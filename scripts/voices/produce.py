"""Hash-bound, resumable production after parent-relayed human casting approval."""
import argparse
import html
import json
import sys
from pathlib import Path
from xml.etree import ElementTree

from prepare import HERE, digest, load, save


def validate_approval(lock, approval):
    if approval.get("approved") is not True or not approval.get("human_approval_reference") or not approval.get("parent_session_id"):
        raise RuntimeError("Full synthesis requires explicit parent-relayed human approval.")
    for key in ("inventory_source_hash", "cast_sha256", "pronunciation_sha256"):
        if approval.get(key) != lock[key]:
            raise RuntimeError(f"Approval does not cover current {key}")
    if digest(HERE / "cast.json") != lock["cast_sha256"] or digest(HERE / "pronunciation.json") != lock["pronunciation_sha256"]:
        raise RuntimeError("Voice configuration changed; prepare a new revision and obtain matching approval.")


def require_approval(root, approval_path):
    lock = load(root / "source-lock.json")
    approval = load(approval_path)
    validate_approval(lock, approval)
    return lock, approval


def validate_segment(segment, sp):
    sp.validate_ssml(segment["ssml"], segment["voice"])
    visible = "".join(ElementTree.fromstring(segment["ssml"]).itertext())
    if visible != segment["text"]:
        raise RuntimeError(f"SSML changes the display text: {segment['id']}")
    if not all(ipa in html.unescape(segment["ssml"]) for ipa in segment["required_ipa"]):
        raise RuntimeError(f"Missing pronunciation markup: {segment['id']}")


def produce(root, output, approval_path, engine, skill):
    if output.is_relative_to(HERE.parents[1]):
        raise RuntimeError("Lossless production masters must remain outside the repository.")
    sys.path.insert(0, str(skill / "scripts"))
    import speech_production as sp

    lock, approval = require_approval(root, approval_path)
    manifest_path = root / "manifests" / f"corpus-{engine}.json"
    if digest(manifest_path) != lock["manifest_sha256"][manifest_path.name]:
        raise RuntimeError("Corpus manifest changed after preparation.")
    manifest = load(manifest_path)
    sp.validate_manifest(manifest)
    audition_report_path = root / "engines" / engine / "production-report.json"
    audition_report = load(audition_report_path)
    capability = audition_report["capability_probe"]
    if not capability["sentinel_followed"]:
        raise RuntimeError("Selected engine has not demonstrated phoneme payload control.")
    if not capability["correct_target_scores_pass"] and approval.get("accepted_probe_report_sha256", {}).get(engine) != digest(audition_report_path):
        raise RuntimeError("Pronunciation probe flags require hash-bound human acceptance before production.")
    region, key, credential_source = sp.get_speech_resource(manifest["backend"])
    if region != audition_report["region"]:
        raise RuntimeError("Speech resource region changed since engine probe.")
    receipts = []
    for segment in manifest["segments"]:
        identifier = segment["id"]
        validate_segment(segment, sp)
        receipt_path = output / "receipts" / f"{identifier}.json"
        request_path = output / "requests" / f"{identifier}.json"
        raw_path = output / "raw" / f"{identifier}.wav"
        final_path = output / "final" / f"{identifier}.wav"
        ssml_path = output / "ssml" / f"{identifier}.ssml"
        request = {
            "segment": segment, "quality": manifest["quality"],
            "skill_sha256": digest(skill / "scripts" / "speech_production.py"),
            "probe_report_sha256": digest(audition_report_path), "region": region,
        }
        if request_path.exists() and load(request_path) != request:
            raise RuntimeError(f"Segment inputs changed; use a new output revision: {identifier}")
        if receipt_path.exists():
            receipt = load(receipt_path)
            if not request_path.exists():
                raise RuntimeError(f"Missing request provenance: {identifier}")
            for path_field, hash_field in (("raw_path", "raw_sha256"), ("final_path", "final_sha256"), ("ssml_path", "ssml_sha256")):
                if digest(receipt[path_field]) != receipt[hash_field]:
                    raise RuntimeError(f"Previously produced audio changed: {identifier}")
            receipts.append(receipt)
            continue
        if raw_path.exists() and not request_path.exists():
            raise RuntimeError(f"Raw master has no request provenance: {identifier}")
        save(request_path, request)
        ssml_path.parent.mkdir(parents=True, exist_ok=True)
        if ssml_path.exists() and ssml_path.read_text(encoding="utf-8") != segment["ssml"]:
            raise RuntimeError(f"Previously saved SSML changed: {identifier}")
        ssml_path.write_text(segment["ssml"], encoding="utf-8")
        # Reuse identical, already auditioned segments instead of paying to generate them again.
        audition = next((s for s in audition_report["segments"] if s["id"] == identifier), None)
        if not raw_path.exists():
            if audition and Path(audition["ssml_path"]).read_text(encoding="utf-8") == segment["ssml"]:
                import shutil
                if digest(audition["raw_path"]) != audition["raw_sha256"]:
                    raise RuntimeError(f"Audition master changed: {identifier}")
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(audition["raw_path"], raw_path)
            else:
                sp.synthesize(region, key, segment["ssml"], raw_path)
        final_path.parent.mkdir(parents=True, exist_ok=True)
        duration, fit_factor, fit_ok = sp.conform_audio(raw_path, final_path, None, 1.0)
        assessment = sp.assess(region, key, manifest["language"], final_path, segment["text"])
        transcription = sp.transcribe(region, key, manifest["language"], final_path)
        waveform = sp.waveform_metrics(final_path)
        targets = sp.target_occurrence_results(assessment, segment["target_words"])
        quality = manifest["quality"]
        checks = {
            "markup": True, "timing": fit_ok and fit_factor == 1.0,
            "accuracy": (assessment["accuracy_score"] or 0) >= quality["min_accuracy"],
            "fluency": (assessment["fluency_score"] or 0) >= quality["min_fluency"],
            "completeness": (assessment["completeness_score"] or 0) >= quality["min_completeness"],
            "target_pronunciation": all(t["accuracy_score"] is not None and t["accuracy_score"] >= quality["min_target_word_accuracy"] for t in targets),
            "not_clipped": waveform["clipped_sample_fraction"] == 0,
            "nonempty": duration >= 0.15 and waveform["peak"] > 0.001,
        }
        receipt = {
            "id": identifier, "speaker": segment["speaker"], "voice": segment["voice"], "text": segment["text"],
            "source_sha256": segment["sourceSha256"], "raw_path": str(raw_path), "final_path": str(final_path),
            "ssml_path": str(ssml_path), "raw_sha256": digest(raw_path), "final_sha256": digest(final_path),
            "ssml_sha256": digest(ssml_path), "duration_seconds": duration, "fit_factor": fit_factor,
            "required_ipa": segment["required_ipa"], "target_words": segment["target_words"],
            "target_occurrences": targets, **assessment, "transcription": transcription,
            "waveform": waveform, "checks": checks, "decision": "PASS" if all(checks.values()) else "NEEDS_REVIEW",
        }
        save(receipt_path, receipt)
        receipts.append(receipt)
        print(f"{engine} {len(receipts)}/{len(manifest['segments'])} {identifier} {receipt['decision']}", flush=True)
    failed = [item["id"] for item in receipts if item["decision"] != "PASS"]
    report = {
        "schema_version": "1.0", "provider": "azure-speech", "region": region, "credential_source": credential_source,
        "language": manifest["language"], "default_voice": manifest["default_voice"],
        "capability_probe": capability, "segments": receipts,
        "human_casting_approval": approval, "source_lock": lock,
        "summary": {"segment_count": len(receipts), "failed_ids": failed, "maximum_fit_factor": 1.0,
                    "human_review_required": True},
        "decision": "NEEDS_REVIEW" if failed else "PASS",
    }
    save(output / f"production-report-{engine}.json", report)
    print(json.dumps({"engine": engine, "segments": len(receipts), "flagged_ids": failed}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--approval", type=Path, required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--skill-root", type=Path, default=Path.home() / ".copilot" / "skills" / "speech-production")
    args = parser.parse_args()
    produce(args.prepared_dir.resolve(), args.output_dir.resolve(), args.approval.resolve(), args.engine, args.skill_root.resolve())
