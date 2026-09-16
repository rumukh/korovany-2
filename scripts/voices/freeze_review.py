"""Freeze final listening indices and evidence hashes without inventing release approval."""
import argparse
from pathlib import Path

from prepare import digest, load, save


def freeze(qa, asr, production, output):
    if output.exists():
        raise RuntimeError("Release review is immutable; use a fresh output directory.")
    summary = load(qa / "qa-summary.json")
    if summary["missing_ids"] or summary["technical_defect_ids"]:
        raise RuntimeError("Cannot freeze an incomplete or technically defective corpus.")
    flags = load(qa / "review-index.json")
    representatives = load(qa / "representative-index.json")
    for item in flags + representatives:
        if digest(item["path"]) != item["sha256"]:
            raise RuntimeError(f"Review audio changed: {item['id']}")
    corroboration = {}
    for path in sorted(asr.glob("*.json")):
        item = load(path)
        corroboration[item["id"]] = item
    priority = []
    for item in flags:
        item["full_file_asr"] = corroboration.get(item["id"])
        if item["full_file_asr"]:
            item["note"] += " Full-file ASR: " + (item["full_file_asr"]["transcription"] or "(no recognized words)")
        if not item["already_human_approved"] and item["review_priority"] != "score-or-recognition-only":
            priority.append(item)
    # Explicitly include the short NoMatch utterance even if the service labels an empty result recognized.
    for item in flags:
        if item["id"] == "ru-mara-edf630ff68eefeda.002" and item not in priority:
            priority.append(item)
    acoustic = load(qa / "acoustic-report.json")
    for item in representatives:
        item["acoustic_scores"] = acoustic["scores"][item["path"]]
        if item["acoustic_scores"]["minimum_mos"] < 4:
            item["note"] += " NISQA below 4: inspect joins/pacing; not a semantic verdict."
            priority.append(item)
    output.mkdir(parents=True)
    master_hashes = {}
    for path in sorted((production / "receipts").glob("*.json")):
        receipt = load(path)
        if digest(receipt["final_path"]) != receipt["final_sha256"]:
            raise RuntimeError(f"Master changed before review freeze: {receipt['id']}")
        master_hashes[receipt["id"]] = receipt["final_sha256"]
    if len(master_hashes) != summary["expected_segments"]:
        raise RuntimeError("Review freeze does not cover every source segment.")
    save(output / "master-hashes.json", master_hashes)
    save(output / "review-index.json", flags)
    save(output / "priority-review-index.json", priority)
    save(output / "representative-index.json", representatives)
    save(output / "qa-summary.json", summary)
    save(output / "corroboration.json", corroboration)
    save(output / "metric-corrections.json", load(qa / "metric-corrections.json"))
    save(output / "acoustic-report.json", acoustic)
    save(output / "review-lock.json", {
        "version": 1, "status": "awaiting-informed-human-release-decision",
        "inventory_source_hash": summary["inventory_source_hash"],
        "files": {path.name: digest(path) for path in sorted(output.glob("*.json"))},
        "audio_sha256": {item["id"]: item["sha256"] for item in flags + representatives},
        "counts": {"raw_retained_flags": len(flags), "previously_approved_exact_audition_flags": summary["flagged_already_human_approved"],
                   "new_flags": summary["flagged_new"], "priority_samples": len(priority),
                   "representative_speaker_language_samples": len(representatives)},
        "caveats": [
            "All 2,265 source segments exist; no clipping, empty audio, hash mismatch or timing compression.",
            "Raw scores are not all PASS. The 32 exact possessive-token bookkeeping corrections retain original evidence.",
            "Some Russian function words merge naturally in speech; ASR alone cannot prove they were omitted.",
            "Roman chapter labels are deliberately spoken as numbers. Whole-file ASR recovers several title continuations missed by single-utterance recognition, but short/name phrases remain weak recognition cases.",
            "Review the short Russian Хорошо and Раут мёртв clips explicitly; one returns no independent transcript while pronunciation assessment scores it 100.",
            "One Russian Ivet whole-block sample has NISQA MOS 3.90; the other 43 representative samples are above 4.7. Scores do not certify pronunciation or acting.",
            "No new generation or blanket automated score override was performed. Final release remains a separate human decision.",
        ],
    })
    print({"review_lock": str(output / "review-lock.json"), "sha256": digest(output / "review-lock.json"),
           "priority_samples": len(priority), "representative_samples": len(representatives)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--qa-dir", type=Path, required=True)
    parser.add_argument("--asr-dir", type=Path, required=True)
    parser.add_argument("--production-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    freeze(args.qa_dir.resolve(), args.asr_dir.resolve(), args.production_dir.resolve(), args.output_dir.resolve())
