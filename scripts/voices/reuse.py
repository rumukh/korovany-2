"""Inventory exact approved-master reuse and intra-corpus render deduplication."""
import argparse
import hashlib
import json
from pathlib import Path

from prepare import digest, load, save


def render_key(segment, quality):
    fields = {key: segment[key] for key in ("speaker", "voice", "text", "ssml", "required_ipa", "target_words")}
    fields["quality"] = quality
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def plan(prepared, archive, output):
    lock = load(prepared / "source-lock.json")
    decision_path = archive / "final-human-release-decision.json"
    decision = load(decision_path)
    review = archive / "release-review-v1"
    if decision.get("approved") is not True or decision.get("review_lock_sha256") != digest(review / "review-lock.json"):
        raise RuntimeError("Approved archive has no matching human release decision.")
    review_lock = load(review / "review-lock.json")
    if digest(review / "master-hashes.json") != review_lock["files"]["master-hashes.json"]:
        raise RuntimeError("Approved master index changed.")
    masters = load(review / "master-hashes.json")
    approved = {}
    for request_path in sorted((archive / "requests").glob("*.json")):
        request = load(request_path)
        segment = request["segment"]
        receipt_path = archive / "receipts" / request_path.name
        receipt = load(receipt_path)
        if masters.get(segment["id"]) != receipt["final_sha256"]:
            raise RuntimeError(f"Master is outside the frozen approval: {segment['id']}")
        for kind in ("raw", "final", "ssml"):
            if digest(receipt[f"{kind}_path"]) != receipt[f"{kind}_sha256"]:
                raise RuntimeError(f"Approved {kind} changed: {segment['id']}")
        if Path(receipt["ssml_path"]).read_text(encoding="utf-8") != segment["ssml"]:
            raise RuntimeError(f"Approved SSML request mismatch: {segment['id']}")
        approved.setdefault(render_key(segment, request["quality"]), {
            "id": segment["id"], "receipt_path": str(receipt_path), "receipt_sha256": digest(receipt_path),
            "audio_sha256": receipt["final_sha256"], "automated_decision": receipt["decision"],
        })
    groups, segments, blocks = {}, {}, {}
    for manifest_path in sorted((prepared / "manifests").glob("corpus-*.json")):
        if digest(manifest_path) != lock["manifest_sha256"][manifest_path.name]:
            raise RuntimeError(f"Prepared manifest changed: {manifest_path.name}")
        manifest = load(manifest_path)
        for segment in manifest["segments"]:
            key = render_key(segment, manifest["quality"])
            group = groups.setdefault(key, {
                "canonical_segment_id": segment["id"], "engine": manifest_path.stem.removeprefix("corpus-"),
                "reusable": approved.get(key), "segment_ids": [], "characters": len(segment["text"]),
                "words": len(segment["text"].split()),
            })
            group["segment_ids"].append(segment["id"])
            segments[segment["id"]] = key
            blocks.setdefault(segment["id"].rsplit(".", 1)[0], []).append(key)
    reused = [g for g in groups.values() if g["reusable"]]
    new = [g for g in groups.values() if not g["reusable"]]
    result = {
        "version": 1, "inventory_source_hash": lock["inventory_source_hash"],
        "source_lock_sha256": digest(prepared / "source-lock.json"),
        "archive": str(archive), "historical_release_decision_sha256": digest(decision_path),
        "historical_review_lock_sha256": decision["review_lock_sha256"],
        "historical_approval_scope": "Only byte-identical previously released masters; no new recording is approved.",
        "summary": {
            "blocks": len(blocks), "fully_reusable_blocks": sum(all(groups[k]["reusable"] for k in keys) for keys in blocks.values()),
            "segment_references": len(segments), "unique_renders": len(groups),
            "reusable_unique_renders": len(reused), "new_unique_renders": len(new),
            "reusable_segment_references": sum(len(g["segment_ids"]) for g in reused),
            "new_characters": sum(g["characters"] for g in new),
            "new_words": sum(g["words"] for g in new),
            "retained_reused_metric_flags": sum(g["reusable"]["automated_decision"] != "PASS" for g in reused),
        },
        "groups": groups, "segments": segments,
    }
    save(output, result)
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--approved-archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    plan(args.prepared_dir.resolve(), args.approved_archive.resolve(), args.output.resolve())
