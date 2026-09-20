"""Preserve score flags and produce playable review/representative acoustic assets."""
import argparse
import collections
import re
from pathlib import Path

import numpy as np
import soundfile as sf

from prepare import digest, load, save
from produce import natural_sources, require_approval
from metric_evidence import correct_possessive_targets
from pronunciation_policy import NATURAL, pronunciation_mode, validate_natural_receipt


def tokens(text):
    return re.findall(r"[^\W_]+", text.casefold().replace("ё", "е"))


def audit(inventory_path, production, prepared, approval_path, output, require_complete=False, reuse_path=None):
    inventory = load(inventory_path)
    lock, approval = require_approval(prepared, approval_path)
    mode = pronunciation_mode(lock)
    sources = natural_sources(prepared, lock) if mode == NATURAL else {}
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
        if mode == NATURAL:
            validate_natural_receipt(receipt, sources[identifier])
            if Path(receipt["ssml_path"]).read_text(encoding="utf-8") != sources[identifier]["ssml"]:
                raise RuntimeError(f"QA natural plaintext mismatch {identifier}")
        receipts[identifier] = correct_possessive_targets(receipt)
    missing = sorted(set(expected) - set(receipts))
    if require_complete and missing:
        raise RuntimeError(f"QA corpus incomplete: {len(missing)} missing segments.")
    approved_samples = {}
    for engine, report_hash in approval.get("accepted_audition_report_sha256", {}).items():
        path = prepared / "engines" / engine / "production-report.json"
        if digest(path) != report_hash:
            raise RuntimeError(f"Human-reviewed audition changed: {engine}")
        for sample in load(path)["segments"]:
            approved_samples[sample["id"]] = sample["final_sha256"]
    historical = {}
    if reuse_path:
        reuse = load(reuse_path)
        if approval.get("reuse_plan_sha256") != digest(reuse_path) or reuse["inventory_source_hash"] != inventory["sourceHash"]:
            raise RuntimeError("QA reuse plan is outside generation authorization.")
        archive = Path(reuse["archive"])
        decision_path = archive / "final-human-release-decision.json"
        if digest(decision_path) != reuse["historical_release_decision_sha256"]:
            raise RuntimeError("Historical approval receipt changed.")
        historical = load(decision_path)
        for identifier, receipt in receipts.items():
            carried = receipt.get("reused_approved")
            if not carried:
                continue
            expected_reuse = reuse["groups"][reuse["segments"][identifier]]["reusable"]
            if not expected_reuse or carried["audio_sha256"] != expected_reuse["audio_sha256"] or receipt["final_sha256"] != carried["audio_sha256"]:
                raise RuntimeError(f"Historical acceptance does not cover this audio: {identifier}")
            approved_samples[identifier] = receipt["final_sha256"]
    accepted, technical, review_index = {}, [], []
    for identifier, receipt in receipts.items():
        entry, _ = expected[identifier]
        if not all(receipt["checks"].get(key) for key in ("markup", "timing", "not_clipped", "nonempty")):
            technical.append(identifier)
        if receipt["decision"] == "PASS":
            continue
        approved = mode != NATURAL and approved_samples.get(identifier) == receipt["final_sha256"]
        if approved:
            accepted[identifier] = {
                "accepted": True, "audio_sha256": receipt["final_sha256"],
                "human_review_reference": historical["human_review_reference"] if receipt.get("reused_approved") else approval["human_approval_reference"],
                "note": "Exact unchanged master covered by historical human acceptance; automated flags retained. Not a claim that every line was individually heard.",
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
            "transcription": receipt["transcription"],
            "note": f"Automated flags retained: {', '.join(failed)}. Independent ASR: {receipt['transcription']}. "
                    + ("Unchanged master covered by historical human acceptance." if approved else "New generated line; not included in prior recording approval."),
            "already_human_approved": approved,
            "independent_asr_exact_tokens": tokens(receipt["text"]) == tokens(receipt["transcription"]),
            "word_errors": word_errors,
            "suspected_omissions": omission_candidates,
            "review_priority": "critical-negation-candidate" if critical_negation else
                               "omission-candidate" if omission_candidates else "score-or-recognition-only",
            "scores": {key: receipt[key] for key in ("accuracy_score", "fluency_score", "completeness_score")},
            "target_occurrences": receipt["target_occurrences"],
            "pronunciation_mode": mode,
            "pronunciation_review_required": receipt.get("pronunciation_review_required", False),
            "expected_ipa": receipt.get("expected_ipa", receipt.get("required_ipa", [])),
        })
        if mode == NATURAL and receipt["pronunciation_review_required"]:
            review_index[-1]["note"] += " Expected IPA is a listening reference only; target scores do not approve names or homograph stress."
            if not omission_candidates:
                review_index[-1]["review_priority"] = "unenforced-pronunciation"
    def whole_block(chosen, directory, identifier, title):
        chunks = []
        for segment in chosen["segments"]:
            path = Path(receipts[segment["id"]]["final_path"])
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            if rate != 48000 or not np.isfinite(audio).all():
                raise RuntimeError(f"Invalid conformed master for QA: {path}")
            chunks.append(audio)
        target = output / directory / f"{chosen['id']}.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        sf.write(target, np.concatenate(chunks), 48000, subtype="PCM_24")
        return {
            "id": identifier, "title": title, "language": chosen["language"],
            "voice": receipts[chosen["segments"][0]["id"]]["voice"],
            "path": str(target), "sha256": digest(target), "text": chosen["text"], "kind": "voice",
            "note": "Concatenated existing approved-cast final segments with no artificial padding or timing changes. Final recording review pending.",
        }

    acoustic_index = []
    speakers = sorted({(entry["language"], entry["speaker"]) for entry in inventory["entries"]})
    for language, speaker in speakers:
        candidates = [entry for entry in inventory["entries"] if entry["language"] == language and entry["speaker"] == speaker
                      and all(s["id"] in receipts for s in entry["segments"])]
        if not candidates:
            continue
        # Whole authored blocks exercise actual sentence joins without inventing dialogue.
        candidates.sort(key=lambda entry: all(receipts[s["id"]].get("reused_approved") for s in entry["segments"]))
        chosen = next((entry for entry in candidates if
                       4 <= sum(receipts[s["id"]]["duration_seconds"] for s in entry["segments"]) <= 25), None)
        if chosen is None:
            chosen = max(candidates, key=lambda entry: sum(receipts[s["id"]]["duration_seconds"] for s in entry["segments"]))
        acoustic_index.append(whole_block(chosen, "representative", f"{language}-{speaker}",
                                          f"{speaker} - complete representative block"))
    campaign_index = []
    openings = {f"faction.{faction}.quest.{quest}.stage.0.prompt" for faction, quest in (
        ("elf", "elf-wooden-walls"), ("guard", "guard-empty-relief"), ("villain", "villain-own-standard"),
    )}
    for entry in inventory["entries"]:
        sources = [source for source in entry["sources"] if ".epilogue.root." in source or source in openings]
        if sources and all(segment["id"] in receipts for segment in entry["segments"]):
            campaign_index.append(whole_block(entry, "campaign", f"campaign-{entry['id']}", " / ".join(sources)))
    historical_acoustic = []
    if reuse_path:
        frozen = archive / "release-review-v1"
        historical_lock = load(frozen / "review-lock.json")
        if digest(frozen / "review-lock.json") != reuse["historical_review_lock_sha256"]:
            raise RuntimeError("Historical acoustic approval lock changed.")
        for name in ("representative-index.json", "acoustic-report.json"):
            if digest(frozen / name) != historical_lock["files"][name]:
                raise RuntimeError(f"Historical acoustic evidence changed: {name}")
        old_acoustic = load(frozen / "acoustic-report.json")
        current_entries = {entry["id"]: entry for entry in inventory["entries"]}
        for item in load(frozen / "representative-index.json"):
            scores = old_acoustic["scores"].get(item["path"])
            entry = current_entries.get(Path(item["path"]).stem)
            if scores and scores["minimum_mos"] < 4 and entry and all(
                receipts.get(segment["id"], {}).get("reused_approved") for segment in entry["segments"]
            ):
                if digest(item["path"]) != item["sha256"]:
                    raise RuntimeError(f"Historically reviewed acoustic sample changed: {item['id']}")
                historical_acoustic.append({
                    **item, "id": f"historical-acoustic-{item['id']}", "already_human_approved": True,
                    "acoustic_scores": scores,
                    "note": f"Historical NISQA minimum {scores['minimum_mos']}; explicitly accepted in the old release. "
                            "This complete block remains byte-identical in the new corpus. Not newly rescored or relabeled PASS.",
                })
    save(output / "review-index.json", review_index)
    save(output / "priority-review-index.json", [item for item in review_index if not item["already_human_approved"]
                                                and item["review_priority"] != "score-or-recognition-only"])
    save(output / "human-reviewed-auditions.json", {"version": 1, "accepted_segments": accepted})
    save(output / "representative-index.json", acoustic_index)
    save(output / "campaign-index.json", campaign_index)
    save(output / "historical-acoustic-index.json", historical_acoustic)
    summary = {
        "version": 1, "inventory_source_hash": inventory["sourceHash"], "expected_segments": len(expected),
        "pronunciation_mode": mode, "phoneme_enforced": mode != NATURAL,
        "cast_sha256": lock["cast_sha256"], "human_casting_approval": approval,
        "pronunciation_review_required_ids": [id for id, r in receipts.items() if r.get("pronunciation_review_required")],
        "produced_segments": len(receipts), "missing_ids": missing, "technical_defect_ids": technical,
        "automatic_pass": sum(r["decision"] == "PASS" for r in receipts.values()),
        "flagged": len(review_index), "flagged_already_human_approved": len(accepted),
        "flagged_new": sum(not item["already_human_approved"] for item in review_index),
        "new_flagged_exact_independent_asr": sum(not item["already_human_approved"] and item["independent_asr_exact_tokens"] for item in review_index),
        "new_omission_candidates": sum(not item["already_human_approved"] and bool(item["suspected_omissions"]) for item in review_index),
        "maximum_timing_factor": max((r["fit_factor"] for r in receipts.values()), default=None),
        "duration_seconds": round(sum(r["duration_seconds"] for r in receipts.values()), 3),
        "reused_audition_segments": sum(r["reused_audition"] for r in receipts.values()),
        "reused_approved_segment_references": sum(bool(r.get("reused_approved")) for r in receipts.values()),
        "unique_master_count": len({r["final_sha256"] for r in receipts.values()}),
        "unique_duration_seconds": round(sum({r["final_sha256"]: r["duration_seconds"] for r in receipts.values()}.values()), 3),
        "possessive_target_bookkeeping_corrections": sum("metric_correction" in r for r in receipts.values()),
        "by_speaker_language": dict(collections.Counter(f"{expected[id][0]['language']}/{r['speaker']}" for id, r in receipts.items())),
        "representative_blocks": len(acoustic_index),
        "campaign_opening_and_ending_blocks": len(campaign_index),
        "historical_unchanged_acoustic_flags": len(historical_acoustic),
        "decision": "NEEDS_REVIEW" if mode == NATURAL or technical or missing or len(review_index) > len(accepted) or
                    approval.get("approval_kind") == "existing-cast-regeneration" else "READY_TO_PUBLISH",
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
    parser.add_argument("--reuse-plan", type=Path)
    args = parser.parse_args()
    audit(args.inventory.resolve(), args.production_dir.resolve(), args.prepared_dir.resolve(),
          args.approval.resolve(), args.output_dir.resolve(), args.require_complete, args.reuse_plan)
