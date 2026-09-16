"""Preserve score flags and produce playable review/representative acoustic assets."""
import argparse
import collections
import re
from pathlib import Path

import numpy as np
import soundfile as sf

from prepare import digest, load, save
from produce import require_approval
from metric_evidence import correct_possessive_targets


def tokens(text):
    return re.findall(r"[^\W_]+", text.casefold().replace("ё", "е"))


def audit(inventory_path, production, prepared, approval_path, output, require_complete=False):
    inventory = load(inventory_path)
    lock, approval = require_approval(prepared, approval_path)
    if inventory["sourceHash"] != lock["inventory_source_hash"]:
        raise RuntimeError("QA inventory differs from the approved source.")
    expected = {s["id"]: (entry, s) for entry in inventory["entries"] for s in entry["segments"]}
    receipts = {}
    for path in sorted((production / "receipts").glob("*.json")):
        receipt = load(path)
        identifier = receipt["id"]
        if identifier in receipts or identifier not in expected:
            raise RuntimeError(f"Unexpected or duplicate receipt {identifier}")
        entry, segment = expected[identifier]
        if receipt["text"] != segment["text"] or receipt["source_sha256"] != segment["sourceSha256"]:
            raise RuntimeError(f"QA text mismatch {identifier}")
        for kind in ("raw", "final", "ssml"):
            if digest(receipt[f"{kind}_path"]) != receipt[f"{kind}_sha256"]:
                raise RuntimeError(f"QA {kind} hash mismatch {identifier}")
        receipts[identifier] = correct_possessive_targets(receipt)
    missing = sorted(set(expected) - set(receipts))
    if require_complete and missing:
        raise RuntimeError(f"QA corpus incomplete: {len(missing)} missing segments.")
    approved_samples = {}
    for engine, report_hash in approval["accepted_audition_report_sha256"].items():
        path = prepared / "engines" / engine / "production-report.json"
        if digest(path) != report_hash:
            raise RuntimeError(f"Human-reviewed audition changed: {engine}")
        for sample in load(path)["segments"]:
            approved_samples[sample["id"]] = sample["final_sha256"]
    accepted, technical, review_index = {}, [], []
    for identifier, receipt in receipts.items():
        entry, _ = expected[identifier]
        if not all(receipt["checks"].get(key) for key in ("markup", "timing", "not_clipped", "nonempty")):
            technical.append(identifier)
        if receipt["decision"] == "PASS":
            continue
        heard = approved_samples.get(identifier) == receipt["final_sha256"]
        if heard:
            accepted[identifier] = {
                "accepted": True, "audio_sha256": receipt["final_sha256"],
                "human_review_reference": approval["human_approval_reference"],
                "note": "Exact unchanged audition master covered by explicit human approval; automated flags retained.",
            }
        failed = [key for key, good in receipt["checks"].items() if not good]
        recognized_tokens = tokens(receipt["transcription"])
        word_errors = [{"word": word["Word"], **word.get("PronunciationAssessment", {})} for word in receipt.get("words", [])
                       if word.get("PronunciationAssessment", {}).get("ErrorType") not in (None, "None")]
        omission_candidates = [word["word"] for word in word_errors if word.get("ErrorType") == "Omission"
                               and not all(token in recognized_tokens for token in tokens(word["word"]))]
        critical_negation = any(tokens(word) in (["не"], ["нет"], ["not"], ["no"], ["never"]) for word in omission_candidates)
        review_index.append({
            "id": identifier, "title": f"{entry['speaker']} - {', '.join(failed)}",
            "language": entry["language"], "voice": receipt["voice"], "path": receipt["final_path"],
            "text": receipt["text"], "sha256": receipt["final_sha256"], "kind": "voice",
            "note": f"Automated flags retained: {', '.join(failed)}. Independent ASR: {receipt['transcription']}. "
                    + ("Previously heard audition explicitly approved." if heard else "New generated line; not included in prior audition listening approval."),
            "already_human_approved": heard,
            "independent_asr_exact_tokens": tokens(receipt["text"]) == tokens(receipt["transcription"]),
            "word_errors": word_errors,
            "suspected_omissions": omission_candidates,
            "review_priority": "critical-negation-candidate" if critical_negation else
                               "omission-candidate" if omission_candidates else "score-or-recognition-only",
            "scores": {key: receipt[key] for key in ("accuracy_score", "fluency_score", "completeness_score")},
            "target_occurrences": receipt["target_occurrences"],
        })
    acoustic_index = []
    speakers = sorted({(entry["language"], entry["speaker"]) for entry in inventory["entries"]})
    for language, speaker in speakers:
        candidates = [entry for entry in inventory["entries"] if entry["language"] == language and entry["speaker"] == speaker
                      and all(s["id"] in receipts for s in entry["segments"])]
        if not candidates:
            continue
        # Whole authored blocks exercise actual sentence joins without inventing dialogue.
        chosen = next((entry for entry in candidates if
                       4 <= sum(receipts[s["id"]]["duration_seconds"] for s in entry["segments"]) <= 25), None)
        if chosen is None:
            chosen = max(candidates, key=lambda entry: sum(receipts[s["id"]]["duration_seconds"] for s in entry["segments"]))
        paths = [Path(receipts[s["id"]]["final_path"]) for s in chosen["segments"]]
        chunks = []
        for path in paths:
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            if rate != 48000 or not np.isfinite(audio).all():
                raise RuntimeError(f"Invalid conformed master for QA: {path}")
            chunks.append(audio)
        target = output / "representative" / f"{chosen['id']}.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        sf.write(target, np.concatenate(chunks), 48000, subtype="PCM_24")
        acoustic_index.append({
            "id": f"{language}-{speaker}", "title": f"{speaker} - complete representative block",
            "language": language, "voice": receipts[chosen["segments"][0]["id"]]["voice"],
            "path": str(target), "sha256": digest(target), "text": chosen["text"], "kind": "voice",
            "note": "Concatenated existing approved-cast final segments with no artificial padding or timing changes.",
        })
    save(output / "review-index.json", review_index)
    save(output / "priority-review-index.json", [item for item in review_index if not item["already_human_approved"]
                                                and item["review_priority"] != "score-or-recognition-only"])
    save(output / "human-reviewed-auditions.json", {"version": 1, "accepted_segments": accepted})
    save(output / "representative-index.json", acoustic_index)
    summary = {
        "version": 1, "inventory_source_hash": inventory["sourceHash"], "expected_segments": len(expected),
        "produced_segments": len(receipts), "missing_ids": missing, "technical_defect_ids": technical,
        "automatic_pass": sum(r["decision"] == "PASS" for r in receipts.values()),
        "flagged": len(review_index), "flagged_already_human_approved": len(accepted),
        "flagged_new": sum(not item["already_human_approved"] for item in review_index),
        "new_flagged_exact_independent_asr": sum(not item["already_human_approved"] and item["independent_asr_exact_tokens"] for item in review_index),
        "new_omission_candidates": sum(not item["already_human_approved"] and bool(item["suspected_omissions"]) for item in review_index),
        "maximum_timing_factor": max((r["fit_factor"] for r in receipts.values()), default=None),
        "duration_seconds": round(sum(r["duration_seconds"] for r in receipts.values()), 3),
        "reused_audition_segments": sum(r["reused_audition"] for r in receipts.values()),
        "possessive_target_bookkeeping_corrections": sum("metric_correction" in r for r in receipts.values()),
        "by_speaker_language": dict(collections.Counter(f"{expected[id][0]['language']}/{r['speaker']}" for id, r in receipts.items())),
        "representative_blocks": len(acoustic_index),
        "decision": "NEEDS_REVIEW" if technical or missing or len(review_index) > len(accepted) else "READY_TO_PUBLISH",
    }
    save(output / "qa-summary.json", summary)
    save(output / "metric-corrections.json", {id: receipt["metric_correction"] for id, receipt in receipts.items() if "metric_correction" in receipt})
    print({key: value for key, value in summary.items() if key not in ("missing_ids", "by_speaker_language")})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--production-dir", type=Path, required=True)
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--approval", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    audit(args.inventory.resolve(), args.production_dir.resolve(), args.prepared_dir.resolve(),
          args.approval.resolve(), args.output_dir.resolve(), args.require_complete)
