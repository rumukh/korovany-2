"""Freeze final listening indices and evidence hashes without inventing release approval."""
import argparse
from pathlib import Path

from prepare import digest, load, save
from pronunciation_policy import NATURAL, pronunciation_mode


def freeze(qa, asr, production, output):
    if output.exists():
        raise RuntimeError("Release review is immutable; use a fresh output directory.")
    summary = load(qa / "qa-summary.json")
    mode = pronunciation_mode(summary)
    if summary["missing_ids"] or summary["technical_defect_ids"]:
        raise RuntimeError("Cannot freeze an incomplete or technically defective corpus.")
    flags = load(qa / "review-index.json")
    representatives = load(qa / "representative-index.json")
    campaigns = load(qa / "campaign-index.json") if (qa / "campaign-index.json").exists() else []
    historical = load(qa / "historical-acoustic-index.json") if (qa / "historical-acoustic-index.json").exists() else []
    for item in flags + representatives + campaigns + historical:
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
    for item in flags:
        if not item["already_human_approved"] and (
            item.get("transcription") == "" or (item.get("full_file_asr") or {}).get("decision") == "NO_MATCH"
        ) and item not in priority:
            priority.append(item)
    acoustic = load(qa / "acoustic-report.json")
    for item in representatives:
        if acoustic["audio_sha256"].get(item["path"]) != item["sha256"]:
            raise RuntimeError(f"Acoustic score belongs to a different recording: {item['id']}")
        item["acoustic_scores"] = acoustic["scores"].get(item["path"])
        if item["acoustic_scores"] is None:
            skipped = next((entry for entry in acoustic["not_scored"] if entry["path"] == item["path"]), None)
            if skipped is None:
                raise RuntimeError(f"No acoustic score or declared limitation: {item['id']}")
            item["note"] += " Not acoustically scored: " + skipped["reason"]
        if item["acoustic_scores"] and item["acoustic_scores"]["minimum_mos"] < 4:
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
    save(output / "campaign-index.json", campaigns)
    save(output / "historical-acoustic-index.json", historical)
    listening = {}
    for group, items in (("Campaign openings and endings", campaigns), ("Representative cast", representatives),
                         ("Priority listening", priority), ("All metric flags", flags),
                         ("Historical accepted acoustic caveats", historical)):
        for item in items:
            entry = listening.setdefault(item["id"], {**item, "review_groups": []})
            entry["review_groups"].append(group)
    save(output / "listening-index.json", list(listening.values()))
    save(output / "qa-summary.json", summary)
    save(output / "corroboration.json", corroboration)
    save(output / "metric-corrections.json", load(qa / "metric-corrections.json"))
    save(output / "acoustic-report.json", acoustic)
    save(output / "review-lock.json", {
        "version": 1, "status": "awaiting-informed-human-release-decision",
        "inventory_source_hash": summary["inventory_source_hash"],
        "pronunciation_mode": mode,
        "production_report_sha256": {
            path.name: digest(path) for path in sorted(production.glob("production-report-*.json"))
        },
        "files": {path.name: digest(path) for path in sorted(output.glob("*.json"))},
        "audio_sha256": {item["id"]: item["sha256"] for item in flags + representatives + campaigns + historical},
        "counts": {"raw_retained_flags": len(flags), "previously_approved_exact_master_flags": summary["flagged_already_human_approved"],
                   "new_flags": summary["flagged_new"], "priority_samples": len(priority),
                   "representative_speaker_language_samples": len(representatives),
                   "campaign_opening_and_ending_samples": len(campaigns),
                   "historical_unchanged_acoustic_flags": len(historical)},
        "caveats": [
            f"All {summary['expected_segments']} segment references exist; no clipping, empty audio, hash mismatch or timing compression.",
            f"Retained automated flags: {summary['flagged']}; historically accepted unchanged flags: {summary['flagged_already_human_approved']}; new flags: {summary['flagged_new']}. They are not relabeled automated PASS.",
            f"Exact possessive-token bookkeeping corrections: {summary['possessive_target_bookkeeping_corrections']}; original evidence retained.",
            "Some Russian function words merge naturally in speech; ASR alone cannot prove they were omitted.",
            ("Natural delivery preserves chapter labels as exact text without phonemes; expected chapter IPA is only a listening reference."
             if mode == NATURAL else "Roman chapter labels are deliberately spoken as numbers.")
            + " Short utterances and names remain recognition caveats; corroboration is not pronunciation approval.",
            "Review the priority index for possible omissions, empty transcripts and low acoustic scores. NISQA scores do not certify pronunciation or acting; short unscored samples are not padded.",
            "Historically accepted unchanged acoustic caveats: " + "; ".join(
                f"{item['id']} MOS {item['acoustic_scores']['minimum_mos']}" for item in historical),
            "Cast and mode are revision-specific; generation authorization is not historical listening approval. Final recording release remains a separate human decision.",
            ("Natural-reviewed delivery does not enforce IPA. Failed capability evidence is retained; name and homograph stress require explicit review. "
             "Target scores are automated metrics only. Final acceptance covers disclosed limitations, not a claim that every line was individually heard."
             if mode == NATURAL else "Phoneme-enforced generation requires a successful sentinel even when probe metric flags are accepted."),
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
