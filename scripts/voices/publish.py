"""Publish a complete reviewed corpus as mono Ogg, then atomically expose its manifest."""
import argparse
import json
import subprocess
from pathlib import Path

from prepare import HERE, digest, load, save
from produce import validate_approval

TECHNICAL_CHECKS = ("markup", "timing", "not_clipped", "nonempty")


def publish(inventory_path, production, public, review_path=None):
    inventory = load(inventory_path)
    reports = [load(path) for path in sorted(production.glob("production-report-*.json"))]
    if not reports:
        raise RuntimeError("No completed production reports; cannot publish placeholder voices.")
    review = load(review_path) if review_path else {}
    cast = load(HERE / "cast.json")
    accepted = review.get("accepted_segments", {})
    receipts = {}
    for report in reports:
        validate_approval(report["source_lock"], report["human_casting_approval"])
        if report["source_lock"]["inventory_source_hash"] != inventory["sourceHash"]:
            raise RuntimeError("Production reports belong to a different source inventory.")
        for segment in report["segments"]:
            if segment["id"] in receipts:
                raise RuntimeError(f"Duplicate production receipt {segment['id']}")
            receipts[segment["id"]] = segment
    expected = {segment["id"] for entry in inventory["entries"] for segment in entry["segments"]}
    if set(receipts) != expected:
        missing = sorted(expected - set(receipts))
        extra = sorted(set(receipts) - expected)
        raise RuntimeError(f"Incomplete corpus; missing={missing}, unexpected={extra}")
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
                if decision.get("accepted") is not True or decision.get("audio_sha256") != receipt["final_sha256"] or not decision.get("human_review_reference"):
                    raise RuntimeError(f"Unreviewed pronunciation/fluency flag: {segment['id']}")
                retained_flags.append({"id": segment["id"], "checks": receipt["checks"], "review": decision})
    manifest_entries, hashes = [], {}
    for entry in inventory["entries"]:
        clips = []
        for segment in entry["segments"]:
            receipt = receipts[segment["id"]]
            src = f"audio/voices/{entry['language']}/{entry['speaker']}/{segment['id']}-{receipt['final_sha256'][:12]}.ogg"
            target = public.joinpath(*src.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", receipt["final_path"],
                "-map_metadata", "-1", "-ac", "1", "-ar", "24000", "-c:a", "libvorbis", "-q:a", "3", str(target),
            ], check=True, capture_output=True)
            details = json.loads(subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration",
                "-of", "json", str(target),
            ], check=True, capture_output=True, text=True).stdout)
            stream = details["streams"][0]
            duration = float(details["format"]["duration"])
            if stream["codec_name"] != "vorbis" or stream["channels"] != 1 or duration < 0.15:
                raise RuntimeError(f"Invalid deployment clip: {target}")
            if abs(duration - receipt["duration_seconds"]) > 0.05:
                raise RuntimeError(f"Deployment duration changed: {target}")
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(target), "-f", "null", "-"],
                           check=True, capture_output=True)
            hashes[src] = digest(target)
            clips.append({"src": src, "duration": round(duration, 6)})
        manifest_entries.append({key: entry[key] for key in ("id", "speaker", "language", "text")} | {"clips": clips})
    target_root = public / "audio" / "voices"
    save(target_root / "provenance.json", {
        "version": 1, "provider": "azure-speech", "inventory_source_hash": inventory["sourceHash"],
        "summary": inventory["summary"], "master_format": "24kHz 16-bit mono raw PCM; retained outside repository",
        "delivery_format": "24kHz mono Vorbis quality 3", "maximum_timing_factor": 1.0,
        "source_lock": reports[0]["source_lock"], "cast_approval": reports[0]["human_casting_approval"],
        "retained_automated_flags": retained_flags, "clip_sha256": hashes,
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
    args = parser.parse_args()
    publish(args.inventory.resolve(), args.production_dir.resolve(), args.public_dir.resolve(), args.review)
