"""Repair one identified audition defect, preserving the original report and audio."""
import argparse
import shutil
import sys
from pathlib import Path

from prepare import digest, load, save
from produce import validate_segment


def repair(root, replacement_path, engine, identifier, output, skill):
    sys.path.insert(0, str(skill / "scripts"))
    import speech_production as sp

    original_path = root / "manifests" / f"audition-{engine}.json"
    original, replacement = load(original_path), load(replacement_path)
    if {k: v for k, v in original.items() if k != "segments"} != {k: v for k, v in replacement.items() if k != "segments"}:
        raise RuntimeError("A single-line repair cannot change the engine, probe or quality thresholds.")
    before = {s["id"]: s for s in original["segments"]}
    after = {s["id"]: s for s in replacement["segments"]}
    if set(before) != set(after) or {key for key in before if before[key] != after[key]} != {identifier}:
        raise RuntimeError("Repair must change exactly one existing audition segment.")
    segment = after[identifier]
    if segment["text"] != before[identifier]["text"]:
        raise RuntimeError("Pronunciation repair must not change displayed text.")
    validate_segment(segment, sp)
    if output.exists():
        raise RuntimeError("Use a fresh repair directory to preserve all earlier evidence.")
    output.mkdir(parents=True)
    report_path = root / "engines" / engine / "production-report.json"
    shutil.copyfile(report_path, output / "original-production-report.json")
    shutil.copyfile(original_path, output / "original-manifest.json")
    report = load(report_path)
    if not report["capability_probe"]["sentinel_followed"]:
        raise RuntimeError("The audition engine has not demonstrated phoneme control.")
    region, key, _ = sp.get_speech_resource(replacement["backend"])
    if region != report["region"]:
        raise RuntimeError("Speech resource changed since the engine probe.")
    raw, final, ssml = output / "raw.wav", output / "final.wav", output / "speech.ssml"
    ssml.write_text(segment["ssml"], encoding="utf-8")
    sp.synthesize(region, key, segment["ssml"], raw)
    duration, factor, fit_ok = sp.conform_audio(raw, final, None, 1.0)
    assessment = sp.assess(region, key, replacement["language"], final, segment["text"])
    transcription = sp.transcribe(region, key, replacement["language"], final)
    targets = sp.target_occurrence_results(assessment, segment["target_words"])
    waveform = sp.waveform_metrics(final)
    quality = replacement["quality"]
    checks = {
        "markup": True, "timing": fit_ok and factor == 1.0,
        "accuracy": (assessment["accuracy_score"] or 0) >= quality["min_accuracy"],
        "fluency": (assessment["fluency_score"] or 0) >= quality["min_fluency"],
        "completeness": (assessment["completeness_score"] or 0) >= quality["min_completeness"],
        "target_pronunciation": all(t["accuracy_score"] is not None and t["accuracy_score"] >= quality["min_target_word_accuracy"] for t in targets),
        "not_clipped": waveform["clipped_sample_fraction"] == 0,
    }
    old = next(s for s in report["segments"] if s["id"] == identifier)
    updated = {**old, **assessment, "required_ipa": segment["required_ipa"],
               "target_occurrences": targets, "target_word_scores": [t["accuracy_score"] for t in targets],
               "transcription": transcription, "raw_path": str(raw), "raw_sha256": digest(raw),
               "final_path": str(final), "final_sha256": digest(final), "ssml_path": str(ssml), "ssml_sha256": digest(ssml),
               "duration_seconds": duration, "fit_factor": factor, "waveform": waveform, "checks": checks,
               "decision": "PASS" if all(checks.values()) else "FAIL"}
    report["segments"] = [updated if s["id"] == identifier else s for s in report["segments"]]
    report["summary"]["failed_ids"] = [s["id"] for s in report["segments"] if s["decision"] != "PASS"]
    for metric in ("accuracy", "fluency", "completeness"):
        report["summary"][f"minimum_{metric}"] = min(s[f"{metric}_score"] or 0 for s in report["segments"])
    report["decision"] = "PASS" if not report["summary"]["failed_ids"] and report["capability_probe"]["decision"] == "PASS" else "FAIL"
    save(output / "repair-report.json", {"segment": updated, "replaces_audio_sha256": old["final_sha256"]})
    save(report_path, report)
    shutil.copyfile(replacement_path, original_path)
    lock = load(root / "source-lock.json")
    lock["manifest_sha256"][original_path.name] = digest(original_path)
    save(root / "source-lock.json", lock)
    print(f"Repaired {identifier}: {updated['decision']}; retained original at {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--replacement-manifest", type=Path, required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--segment", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--skill-root", type=Path, default=Path.home() / ".copilot" / "skills" / "speech-production")
    args = parser.parse_args()
    repair(args.prepared_dir.resolve(), args.replacement_manifest.resolve(), args.engine, args.segment,
           args.output_dir.resolve(), args.skill_root.resolve())
