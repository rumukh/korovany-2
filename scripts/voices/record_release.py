"""Bind a parent-relayed, informed human release decision to frozen recording hashes."""
import argparse
from pathlib import Path

from prepare import digest, load, save


def record(review_dir, decision_path, output):
    decision = load(decision_path)
    required = ("human_response", "timestamp", "parent_session_id", "human_review_reference", "review_lock_sha256")
    if decision.get("approved") is not True or decision.get("accepts_disclosed_metric_flags") is not True or not all(decision.get(key) for key in required):
        raise RuntimeError("Recording release requires a relayed human decision accepting the disclosed metrics.")
    lock_path = review_dir / "review-lock.json"
    if digest(lock_path) != decision["review_lock_sha256"]:
        raise RuntimeError("Human release does not cover this frozen review revision.")
    lock = load(lock_path)
    for name, expected_hash in lock["files"].items():
        path = review_dir / name
        if path.parent != review_dir or digest(path) != expected_hash:
            raise RuntimeError(f"Frozen review changed: {name}")
    flags = load(review_dir / "review-index.json")
    representatives = load(review_dir / "representative-index.json")
    for item in flags + representatives:
        if digest(item["path"]) != item["sha256"]:
            raise RuntimeError(f"Reviewed recording changed: {item['id']}")
    result = {
        "version": 1,
        "release_approval": {
            **decision, "inventory_source_hash": lock["inventory_source_hash"],
            "review_counts": lock["counts"], "caveats": lock["caveats"],
            "scope": "Informed release acceptance of unchanged recordings with disclosed metrics; not a claim that every flagged line was listened to individually.",
        },
        "master_sha256": load(review_dir / "master-hashes.json"),
        "accepted_segments": {
            item["id"]: {"accepted": True, "audio_sha256": item["sha256"],
                         "human_review_reference": decision["human_review_reference"],
                         "acceptance_scope": "informed-recording-release-with-disclosed-flags",
                         "already_approved_audition": item["already_human_approved"]}
            for item in flags
        },
    }
    if output.exists() and load(output) != result:
        raise RuntimeError("An existing release decision cannot be overwritten.")
    save(output, result)
    print({"accepted_flagged_segments": len(result["accepted_segments"]), "master_count": len(result["master_sha256"]),
           "release_review": str(output), "sha256": digest(output)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--review-dir", type=Path, required=True)
    parser.add_argument("--decision", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    record(args.review_dir.resolve(), args.decision.resolve(), args.output.resolve())
