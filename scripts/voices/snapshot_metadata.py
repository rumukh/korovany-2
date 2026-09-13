"""Persist compact, credential-free audition provenance without committing WAV masters."""
import argparse
from pathlib import Path

from prepare import HERE, digest, load, save


def snapshot(inventory_path, prepared, auditions, output):
    inventory = load(inventory_path)
    ready = load(auditions / "auditions-ready.json")
    acoustic = load(auditions / "acoustic-report.json")
    engines, flags = {}, []
    for path in sorted((auditions / "engines").glob("*/production-report.json")):
        report = load(path)
        probe = report["capability_probe"]
        engines[path.parent.name] = {
            "voice": report["default_voice"], "region": report["region"],
            "probe_decision": probe["decision"], "sentinel_followed": probe["sentinel_followed"],
            "correct_target_scores": probe["variants"]["correct"]["target_occurrences"],
            "sentinel_transcription": probe["variants"]["sentinel"]["transcription"],
            "production_report_sha256": digest(path),
        }
        for segment in report["segments"]:
            if segment["decision"] == "PASS":
                continue
            flags.append({
                "id": segment["id"], "text": segment["text"], "transcription": segment["transcription"],
                "accuracy": segment["accuracy_score"], "fluency": segment["fluency_score"],
                "completeness": segment["completeness_score"],
                "failed_checks": [key for key, valid in segment["checks"].items() if not valid],
                "audio_sha256": segment["final_sha256"],
            })
    save(output, {
        "version": 1, "status": "awaiting-parent-relayed-human-voice-approval",
        "provider": "azure-speech", "source_lock": load(prepared / "source-lock.json"),
        "inventory_summary": {key: value for key, value in inventory["summary"].items() if key != "speakers"},
        "cast_sha256": digest(HERE / "cast.json"),
        "engines": engines, "audition_flags": flags,
        "samples": [{"id": item["id"], "file": Path(item["path"]).name, "sha256": item["sha256"]} for item in ready],
        "acoustic": {
            "device": acoustic["device"], "decision": acoustic["decision"],
            "scored": {Path(path).name: scores for path, scores in acoustic["scores"].items()},
            "not_scored": [{**item, "path": Path(item["path"]).name} for item in acoustic["not_scored"]],
            "note": "Raw NISQA regression scores are not clamped; values can slightly exceed five. They do not approve pronunciation or acting.",
        },
        "limitations": [
            "Three Russian engines, including one male timbre; four British English engines. Twenty character profiles are not twenty unique actors.",
            "All seven voices obey sentinel phonemes, but two Russian female probes miss the target-score threshold on the proposed stress of Toman.",
            "Automated pronunciation/recognition flags are retained for human listening. Thresholds are unchanged.",
            "One identified IPA vowel defect in privyaz was corrected once. Original audio/report remain in the external repair history; the metric still flags the word.",
            "No full-corpus synthesis or public runtime manifest has been released at this gate.",
        ],
    })
    print(f"Saved compact provenance for {len(engines)} engines and {len(ready)} playable files: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--audition-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    snapshot(args.inventory.resolve(), args.prepared_dir.resolve(), args.audition_dir.resolve(), args.output.resolve())
