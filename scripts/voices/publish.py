"""Publish a complete reviewed corpus as mono Ogg, then atomically expose its manifest."""
import argparse
import hashlib
import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np

from prepare import HERE, digest, load, save
from produce import natural_sources, require_audition, validate_approval, validate_natural_evidence
from metric_evidence import correct_possessive_targets
from pronunciation_policy import NATURAL, pronunciation_mode, validate_natural_receipt

TECHNICAL_CHECKS = ("markup", "timing", "not_clipped", "nonempty")


def delivery_profile(gain_db):
    if isinstance(gain_db, bool) or not isinstance(gain_db, (int, float)):
        raise RuntimeError("Delivery gain must be a finite nonpositive number of dB.")
    try:
        gain = float(gain_db)
    except OverflowError as error:
        raise RuntimeError("Delivery gain must be a finite nonpositive number of dB.") from error
    if not math.isfinite(gain) or gain > 0:
        raise RuntimeError("Delivery gain must be a finite nonpositive number of dB.")
    profile = {
        "version": 1, "codec": "libvorbis", "sample_rate_hz": 24000,
        "channels": 1, "vorbis_quality": 3, "gain_db": gain if gain else 0.0,
    }
    encoded = json.dumps(profile, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return profile, hashlib.sha256(encoded).hexdigest()


def require_delivery_profile(document, profile, profile_hash, label):
    if "delivery_profile" not in document and "delivery_profile_sha256" not in document and profile["gain_db"] == 0:
        return
    if document.get("delivery_profile") != profile or document.get("delivery_profile_sha256") != profile_hash:
        raise RuntimeError(f"{label} delivery profile does not match the requested gain/encoding.")


def decoded_metrics(path):
    decoded = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "48000",
        "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1",
    ], check=True, capture_output=True).stdout
    if not decoded or len(decoded) % 4:
        raise RuntimeError(f"Empty or invalid decoded float PCM: {path}")
    samples = np.frombuffer(decoded, dtype="<f4")
    if not np.isfinite(samples).all():
        raise RuntimeError(f"Nonfinite decoded delivery audio: {path}")
    peak = float(np.max(np.abs(samples)))
    if not 0 < peak < 1.0:
        raise RuntimeError(f"Decoded delivery must be non-silent with peak < 1.0; peak={peak}: {path}")
    return {"sample_rate_hz": 48000, "sample_count": int(samples.size), "peak": peak}


def publish(inventory_path, production, public, review_path=None, stage_only=False, staged_dir=None, reused_staging=None,
            delivery_gain_db=0.0):
    profile, profile_hash = delivery_profile(delivery_gain_db)
    profile_metadata = {"delivery_profile": profile, "delivery_profile_sha256": profile_hash}
    gain_suffix = f"-delivery-{profile_hash[:12]}" if profile["gain_db"] != 0 else ""
    if stage_only and public.resolve().is_relative_to(HERE.parents[1]):
        raise RuntimeError("Unreleased voice staging must remain outside the repository.")
    inventory = load(inventory_path)
    report_paths = sorted(production.glob("production-report-*.json"))
    reports = [load(path) for path in report_paths]
    if not reports:
        raise RuntimeError("No completed production reports; cannot publish placeholder voices.")
    review = load(review_path) if review_path else {}
    cast = load(HERE / "cast.json")
    mode = pronunciation_mode(cast)
    accepted = review.get("accepted_segments", {})
    receipts = {}
    for report in reports:
        validate_approval(report["source_lock"], report["human_casting_approval"])
        if mode == NATURAL:
            if (report["source_lock"] != reports[0]["source_lock"]
                    or report["human_casting_approval"] != reports[0]["human_casting_approval"]):
                raise RuntimeError("Natural corpus reports must share one prepared revision and informed generation approval.")
            if pronunciation_mode(report) != mode or report.get("phoneme_enforced") is not False:
                raise RuntimeError("Production report lost its natural pronunciation mode.")
            prepared = Path(report["prepared_dir"])
            validate_natural_evidence(prepared, report["source_lock"], report["human_casting_approval"])
            audition = require_audition(prepared, report["source_lock"], report["human_casting_approval"], report["engine"])
            if (report["audition_report_sha256"] !=
                    report["human_casting_approval"]["accepted_unenforced_pronunciation_report_sha256"][report["engine"]]
                    or report["capability_probe"] != audition["capability_probe"]):
                raise RuntimeError("Production report changed its accepted natural probe evidence.")
            sources = natural_sources(prepared, report["source_lock"])
        if report["source_lock"]["inventory_source_hash"] != inventory["sourceHash"]:
            raise RuntimeError("Production reports belong to a different source inventory.")
        for segment in report["segments"]:
            if segment["id"] in receipts:
                raise RuntimeError(f"Duplicate production receipt {segment['id']}")
            if mode == NATURAL:
                validate_natural_receipt(segment, sources[segment["id"]])
                for kind in ("raw", "ssml"):
                    if digest(segment[f"{kind}_path"]) != segment[f"{kind}_sha256"]:
                        raise RuntimeError(f"Natural production {kind} hash mismatch: {segment['id']}")
                if Path(segment["ssml_path"]).read_text(encoding="utf-8") != sources[segment["id"]]["ssml"]:
                    raise RuntimeError("Natural production no longer preserves its exact plaintext.")
            receipts[segment["id"]] = correct_possessive_targets(segment)
    expected = {segment["id"] for entry in inventory["entries"] for segment in entry["segments"]}
    if set(receipts) != expected:
        missing = sorted(expected - set(receipts))
        extra = sorted(set(receipts) - expected)
        raise RuntimeError(f"Incomplete corpus; missing={missing}, unexpected={extra}")
    release = review.get("release_approval")
    if not stage_only and mode == NATURAL and not release:
        raise RuntimeError("Natural recording requires its own informed human release, even if metrics pass.")
    if not stage_only and not release and any(
        report["human_casting_approval"].get("approval_kind") == "existing-cast-regeneration" for report in reports
    ):
        raise RuntimeError("Regenerated recording requires its own informed human release, even if metrics pass.")
    if release:
        required = ("human_response", "timestamp", "parent_session_id", "human_review_reference", "review_lock_sha256")
        if release.get("approved") is not True or release.get("accepts_disclosed_metric_flags") is not True or not all(release.get(key) for key in required):
            raise RuntimeError("Invalid informed human release decision.")
        if release.get("inventory_source_hash") != inventory["sourceHash"] or review.get("master_sha256") != {id: receipt["final_sha256"] for id, receipt in receipts.items()}:
            raise RuntimeError("Human recording release does not match the complete current corpus.")
        if mode == NATURAL and (
            release.get("pronunciation_mode") != mode or release.get("accepts_unenforced_pronunciation") is not True
            or release.get("production_report_sha256") != {path.name: digest(path) for path in report_paths}
        ):
            raise RuntimeError("Natural release must accept unenforced pronunciation and bind every current production report.")
    retained_flags = []
    for entry in inventory["entries"]:
        for segment in entry["segments"]:
            receipt = receipts[segment["id"]]
            if receipt["text"] != segment["text"] or receipt["source_sha256"] != segment["sourceSha256"] or receipt["speaker"] != entry["speaker"]:
                raise RuntimeError(f"Source mismatch: {segment['id']}")
            expected_engine = cast["profiles"][entry["speaker"]][entry["language"]][0]
            if receipt["voice"] != cast["engines"][expected_engine]:
                raise RuntimeError(f"Cast mismatch: {segment['id']}")
            if digest(receipt["final_path"]) != receipt["final_sha256"]:
                raise RuntimeError(f"Master hash mismatch: {segment['id']}")
            if not all(receipt["checks"].get(key) for key in TECHNICAL_CHECKS):
                raise RuntimeError(f"Technical defect must be repaired: {segment['id']}")
            if receipt["decision"] != "PASS":
                decision = accepted.get(segment["id"], {})
                if not stage_only and (decision.get("accepted") is not True or decision.get("audio_sha256") != receipt["final_sha256"] or not decision.get("human_review_reference")):
                    raise RuntimeError(f"Unreviewed pronunciation/fluency flag: {segment['id']}")
                retained_flags.append({"id": segment["id"], "checks": receipt["checks"], "review": decision})
    staged = load(staged_dir / "audio" / "voices" / "staging-index.json") if staged_dir else None
    historical = load(reused_staging / "audio" / "voices" / "staging-index.json") if reused_staging else None
    if staged and staged["inventory_source_hash"] != inventory["sourceHash"]:
        raise RuntimeError("Staged Oggs belong to a different corpus.")
    for label, document in (("Staged Ogg", staged), ("Historical Ogg", historical)):
        if document is not None:
            require_delivery_profile(document, profile, profile_hash, label)
    existing_stage_path = public / "audio" / "voices" / "staging-index.json"
    if stage_only and existing_stage_path.exists():
        require_delivery_profile(load(existing_stage_path), profile, profile_hash, "Existing staging output")
    existing_provenance_path = public / "audio" / "voices" / "provenance.json"
    existing_provenance = load(existing_provenance_path) if existing_provenance_path.exists() else {}
    existing_hashes = existing_provenance.get("clip_sha256", {})
    manifest_entries, hashes, segment_clips, verified = [], {}, {}, {}
    for entry in inventory["entries"]:
        clips = []
        for segment in entry["segments"]:
            receipt = receipts[segment["id"]]
            delivery_id = receipt.get("delivery_id", segment["id"])
            src = f"audio/voices/{entry['language']}/{entry['speaker']}/{delivery_id}-{receipt['final_sha256'][:12]}{gain_suffix}.ogg"
            segment_clips[segment["id"]] = src
            if src in verified:
                prior = verified[src]
                if prior["master_sha256"] != receipt["final_sha256"]:
                    raise RuntimeError(f"Shared delivery master mismatch: {segment['id']}")
                clips.append({"src": src, "duration": prior["duration"]})
                continue
            target = public.joinpath(*src.split("/"))
            encoded_receipt_path = production / "encoded-receipts" / f"{target.stem}.json"
            known_hashes = []
            if src in existing_hashes:
                require_delivery_profile(existing_provenance, profile, profile_hash, "Existing provenance")
                known_hashes.append(existing_hashes[src])
            if encoded_receipt_path.exists():
                encoded_receipt = load(encoded_receipt_path)
                require_delivery_profile(encoded_receipt, profile, profile_hash, "Encoded receipt")
                if encoded_receipt["master_sha256"] != receipt["final_sha256"] or encoded_receipt["src"] != src:
                    raise RuntimeError(f"Encoded clip receipt mismatch: {segment['id']}")
                known_hashes.append(encoded_receipt["ogg_sha256"])
            if staged:
                if staged["master_sha256"].get(segment["id"]) != receipt["final_sha256"]:
                    raise RuntimeError(f"Staged source master mismatch: {segment['id']}")
                known_hashes.append(staged["clip_sha256"][src])
            reuse_ogg = historical and receipt.get("reused_approved")
            if reuse_ogg:
                if historical["master_sha256"].get(delivery_id) != receipt["final_sha256"] or src not in historical["clip_sha256"]:
                    raise RuntimeError(f"Historical Ogg does not match reused master: {segment['id']}")
                known_hashes.append(historical["clip_sha256"][src])
            if target.exists() and (not known_hashes or any(digest(target) != expected_hash for expected_hash in known_hashes)):
                raise RuntimeError(f"Unverified or changed existing deployment clip: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() and staged:
                source = staged_dir.joinpath(*src.split("/"))
                if digest(source) != staged["clip_sha256"].get(src):
                    raise RuntimeError(f"Staged Ogg hash mismatch: {src}")
                shutil.copyfile(source, target)
            if not target.exists() and reuse_ogg:
                source = reused_staging.joinpath(*src.split("/"))
                if digest(source) != historical["clip_sha256"][src]:
                    raise RuntimeError(f"Historical Ogg changed: {src}")
                shutil.copyfile(source, target)
            if not target.exists():
                temporary_clip = target.with_suffix(".ogg.part")
                gain_filter = ["-af", f"volume={profile['gain_db']:.17g}dB:precision=double"] if gain_suffix else []
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", receipt["final_path"],
                    *gain_filter,
                    "-map_metadata", "-1", "-ac", "1", "-ar", "24000", "-c:a", "libvorbis", "-q:a", "3",
                    "-f", "ogg", str(temporary_clip),
                ], check=True, capture_output=True)
                temporary_clip.replace(target)
            details = json.loads(subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration",
                "-of", "json", str(target),
            ], check=True, capture_output=True, text=True).stdout)
            stream = details["streams"][0]
            duration = float(details["format"]["duration"])
            if len(details["streams"]) != 1 or stream["codec_name"] != "vorbis" or stream["channels"] != 1 or int(stream["sample_rate"]) != 24000 or not math.isfinite(duration) or duration < 0.15:
                raise RuntimeError(f"Invalid deployment clip: {target}")
            if abs(duration - receipt["duration_seconds"]) > 0.05:
                raise RuntimeError(f"Deployment duration changed: {target}")
            decoded = decoded_metrics(target)
            hashes[src] = digest(target)
            if any(hashes[src] != expected_hash for expected_hash in known_hashes):
                raise RuntimeError(f"Deployment clip does not match its recorded hash: {target}")
            save(encoded_receipt_path, {"src": src, "master_sha256": receipt["final_sha256"], "ogg_sha256": hashes[src],
                                        **profile_metadata, "decoded_audio": decoded})
            verified[src] = {"master_sha256": receipt["final_sha256"], "duration": round(duration, 6),
                             "bytes": target.stat().st_size, "decoded_peak": decoded["peak"]}
            clips.append({"src": src, "duration": verified[src]["duration"]})
        manifest_entries.append({key: entry[key] for key in ("id", "speaker", "language", "text")} | {"clips": clips})
    target_root = public / "audio" / "voices"
    delivery_statistics = {
        "entries": len(manifest_entries), "segment_references": len(receipts), "unique_clips": len(hashes),
        "unique_duration_seconds": round(sum(item["duration"] for item in verified.values()), 6),
        "ogg_bytes": sum(item["bytes"] for item in verified.values()),
        "decoded_sample_rate_hz": 48000,
        "maximum_decoded_peak": max(item["decoded_peak"] for item in verified.values()),
    }
    if stage_only:
        save(target_root / "staging-index.json", {
            "version": 1, "status": "unreleased-awaiting-final-human-review", "inventory_source_hash": inventory["sourceHash"],
            "entries": manifest_entries, "clip_sha256": hashes,
            "master_sha256": {id: receipt["final_sha256"] for id, receipt in receipts.items()},
            "delivery_statistics": delivery_statistics,
            **profile_metadata,
            "pronunciation_mode": mode, "phoneme_enforced": mode != NATURAL,
        })
        print(json.dumps({"staged_only": True, "entries": len(manifest_entries), "clips": len(hashes), "published_manifest": False}))
        return
    save(target_root / "provenance.json", {
        "version": 1, "provider": "azure-speech", "inventory_source_hash": inventory["sourceHash"],
        "pronunciation_mode": mode, "phoneme_enforced": mode != NATURAL,
        "engines": cast["engines"],
        "pronunciation_evidence": [
            {"engine": report.get("engine"), "voice": report.get("default_voice"),
             "audition_report_sha256": report.get("audition_report_sha256"),
             "capability_probe": report.get("capability_probe"),
             "phoneme_control_demonstrated": report.get("capability_probe", {}).get("sentinel_followed"),
             "limitation": "IPA is not enforced; expected IPA and target scores are listening aids, not semantic or stress approval."
                           if mode == NATURAL else "Sentinel control does not certify acting or every target pronunciation."}
            for report in reports
        ],
        "summary": inventory["summary"], "master_format": "24kHz 16-bit mono raw PCM; retained outside repository",
        "delivery_format": "24kHz mono Vorbis quality 3", "maximum_timing_factor": 1.0,
        **profile_metadata,
        "source_lock": reports[0]["source_lock"], "cast_approval": reports[0]["human_casting_approval"],
        "recording_release_approval": release,
        "retained_automated_flags": retained_flags, "clip_sha256": hashes,
        "segment_clips": segment_clips,
        "pronunciation_review_targets": {
            id: {"target_words": receipt["target_words"], "expected_ipa": receipt["expected_ipa"],
                 "pronunciation_review_required": True}
            for id, receipt in receipts.items() if receipt.get("pronunciation_review_required")
        },
        "delivery_statistics": delivery_statistics,
        "metric_corrections": {id: receipt["metric_correction"] for id, receipt in receipts.items() if "metric_correction" in receipt},
    })
    temporary = target_root / "manifest.json.tmp"
    save(temporary, {"version": 1, "entries": manifest_entries})
    temporary.replace(target_root / "manifest.json")
    print(json.dumps({"entries": len(manifest_entries), "clips": len(hashes), "retained_reviewed_flags": len(retained_flags)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--production-dir", type=Path, required=True)
    parser.add_argument("--public-dir", type=Path, required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--staged-dir", type=Path)
    parser.add_argument("--reused-staging", type=Path)
    parser.add_argument("--delivery-gain-db", type=float, default=0.0,
                        help="Uniform delivery-only attenuation in dB; finite and <= 0 (default: 0).")
    args = parser.parse_args()
    publish(args.inventory.resolve(), args.production_dir.resolve(), args.public_dir.resolve(), args.review,
            args.stage_only, args.staged_dir.resolve() if args.staged_dir else None,
            args.reused_staging.resolve() if args.reused_staging else None, args.delivery_gain_db)
