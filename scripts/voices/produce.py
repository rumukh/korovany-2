"""Hash-bound, resumable production after parent-relayed human casting approval."""
import argparse
import html
import json
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from xml.etree import ElementTree

from prepare import HERE, digest, load, save
from recognition import recognize_once
from reuse import render_key
from pronunciation_policy import (
    NATURAL, pronunciation_mode, retain_natural_review, validate_natural_receipt, validate_natural_segment,
)


def validate_approval(lock, approval):
    mode = pronunciation_mode(lock)
    if pronunciation_mode(approval) != mode:
        raise RuntimeError("Approval pronunciation_mode does not agree with the source lock.")
    if approval.get("approved") is not True or not approval.get("human_approval_reference") or not approval.get("parent_session_id"):
        raise RuntimeError("Full synthesis requires explicit parent-relayed human approval.")
    for key in ("inventory_source_hash", "cast_sha256", "pronunciation_sha256"):
        if approval.get(key) != lock[key]:
            raise RuntimeError(f"Approval does not cover current {key}")
    if digest(HERE / "cast.json") != lock["cast_sha256"] or digest(HERE / "pronunciation.json") != lock["pronunciation_sha256"]:
        raise RuntimeError("Voice configuration changed; prepare a new revision and obtain matching approval.")
    cast = load(HERE / "cast.json")
    if pronunciation_mode(cast) != mode:
        raise RuntimeError("Source lock pronunciation_mode differs from the hash-bound cast.")
    if mode == NATURAL:
        if (approval.get("accepts_unenforced_pronunciation") is not True
                or not approval.get("human_response") or not approval.get("pronunciation_evidence_reference")):
            raise RuntimeError("Natural-reviewed synthesis requires explicit informed acceptance of unenforced pronunciation.")
        accepted = approval.get("accepted_unenforced_pronunciation_report_sha256")
        engines = {name.removeprefix("audition-").removesuffix(".json")
                   for name in lock["manifest_sha256"] if name.startswith("audition-")}
        if (engines != set(cast["engines"]) or not isinstance(accepted, dict) or set(accepted) != engines
                or not all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) for value in accepted.values())):
            raise RuntimeError("Natural approval must bind every actual audition production-report hash.")


def require_audition(root, lock, approval, engine):
    path = root / "engines" / engine / "production-report.json"
    report = load(path)
    capability = report["capability_probe"]
    if pronunciation_mode(lock) != NATURAL:
        if not capability["sentinel_followed"]:
            raise RuntimeError("Selected engine has not demonstrated phoneme payload control.")
        if (not capability["correct_target_scores_pass"]
                and approval.get("accepted_probe_report_sha256", {}).get(engine) != digest(path)):
            raise RuntimeError("Pronunciation probe flags require hash-bound human acceptance before production.")
        return report
    if approval.get("accepted_unenforced_pronunciation_report_sha256", {}).get(engine) != digest(path):
        raise RuntimeError(f"Natural acceptance does not bind the actual audition report hash: {engine}")
    manifest_path = root / "manifests" / f"audition-{engine}.json"
    if digest(manifest_path) != lock["manifest_sha256"][manifest_path.name]:
        raise RuntimeError("Natural audition manifest changed after preparation.")
    source = load(manifest_path)
    if (pronunciation_mode(source) != NATURAL or pronunciation_mode(report) != NATURAL
            or report.get("audition_manifest_sha256") != digest(manifest_path)
            or report.get("cast_sha256") != lock["cast_sha256"]
            or report.get("default_voice") != source["default_voice"]
            or report.get("phoneme_enforced") is not False):
        raise RuntimeError("Natural audition report does not cover this prepared cast and mode.")
    variants = capability["variants"]
    if set(variants) != {"plain", "correct", "swapped", "sentinel"}:
        raise RuntimeError("Natural mode must retain all four phoneme capability probes.")
    for variant in source["capability_probe"]["variants"]:
        item = variants[variant["id"]]
        for kind in ("audio", "ssml"):
            if digest(item[f"{kind}_path"]) != item[f"{kind}_sha256"]:
                raise RuntimeError(f"Natural probe evidence changed: {engine}/{variant['id']}")
        if Path(item["ssml_path"]).read_text(encoding="utf-8") != variant["ssml"]:
            raise RuntimeError("Natural probe SSML differs from the prepared evidence.")
    if (not capability["sentinel_followed"] or not capability["correct_target_scores_pass"]) and (
        capability["decision"] != "FAIL" or report["decision"] != "FAIL"
    ):
        raise RuntimeError("Unsupported phoneme capability must remain a failed audition, not a PASS.")
    by_id = {s["id"]: s for s in report["segments"]}
    if len(by_id) != len(report["segments"]) or set(by_id) != {s["id"] for s in source["segments"]}:
        raise RuntimeError("Natural audition report segment scope changed.")
    for segment in source["segments"]:
        recorded = by_id[segment["id"]]
        validate_natural_segment(segment)
        validate_natural_receipt(recorded, segment)
        if recorded["text"] != segment["text"] or recorded["voice"] != segment["voice"]:
            raise RuntimeError("Natural audition identity changed.")
        for kind in ("raw", "final", "ssml"):
            if digest(recorded[f"{kind}_path"]) != recorded[f"{kind}_sha256"]:
                raise RuntimeError(f"Natural audition {kind} changed: {segment['id']}")
        if Path(recorded["ssml_path"]).read_text(encoding="utf-8") != segment["ssml"]:
            raise RuntimeError("Natural audition plaintext changed.")
    return report


def validate_natural_evidence(root, lock, approval):
    if load(root / "source-lock.json") != lock:
        raise RuntimeError("Natural source lock changed since production.")
    for engine in approval["accepted_unenforced_pronunciation_report_sha256"]:
        require_audition(root, lock, approval, engine)


def natural_sources(root, lock):
    sources = {}
    for name, expected_hash in lock["manifest_sha256"].items():
        if not name.startswith("corpus-"):
            continue
        path = root / "manifests" / name
        if digest(path) != expected_hash:
            raise RuntimeError(f"Natural corpus manifest changed: {name}")
        manifest = load(path)
        if pronunciation_mode(manifest) != NATURAL:
            raise RuntimeError("Natural corpus manifest mode differs from its source lock.")
        for segment in manifest["segments"]:
            validate_natural_segment(segment)
            sources[segment["id"]] = segment
    return sources


def require_approval(root, approval_path):
    lock = load(root / "source-lock.json")
    approval = load(approval_path)
    validate_approval(lock, approval)
    if pronunciation_mode(lock) == NATURAL:
        validate_natural_evidence(root, lock, approval)
    return lock, approval


def validate_segment(segment, sp):
    sp.validate_ssml(segment["ssml"], segment["voice"])
    visible = "".join(ElementTree.fromstring(segment["ssml"]).itertext())
    if visible != segment["text"]:
        raise RuntimeError(f"SSML changes the display text: {segment['id']}")
    if not all(ipa in html.unescape(segment["ssml"]) for ipa in segment["required_ipa"]):
        raise RuntimeError(f"Missing pronunciation markup: {segment['id']}")
    if pronunciation_mode(segment) == NATURAL:
        validate_natural_segment(segment)


def produce(root, output, approval_path, engine, skill, workers=1, reuse_path=None):
    if not 1 <= workers <= 8:
        raise RuntimeError("Speech production permits between one and eight bounded workers.")
    if output.is_relative_to(HERE.parents[1]):
        raise RuntimeError("Lossless production masters must remain outside the repository.")
    sys.path.insert(0, str(skill / "scripts"))
    import speech_production as sp

    lock, approval = require_approval(root, approval_path)
    manifest_path = root / "manifests" / f"corpus-{engine}.json"
    if digest(manifest_path) != lock["manifest_sha256"][manifest_path.name]:
        raise RuntimeError("Corpus manifest changed after preparation.")
    manifest = load(manifest_path)
    mode = pronunciation_mode(lock)
    if pronunciation_mode(manifest) != mode:
        raise RuntimeError("Corpus manifest pronunciation_mode differs from its source lock.")
    sp.validate_manifest(manifest)
    reuse = load(reuse_path) if reuse_path else None
    if reuse and (reuse["inventory_source_hash"] != lock["inventory_source_hash"] or
                  reuse["source_lock_sha256"] != digest(root / "source-lock.json")):
        raise RuntimeError("Reuse plan belongs to different prepared inputs.")
    if reuse and approval.get("reuse_plan_sha256") != digest(reuse_path):
        raise RuntimeError("Generation authorization does not bind this reuse plan.")
    audition_report_path = root / "engines" / engine / "production-report.json"
    audition_report = require_audition(root, lock, approval, engine)
    capability = audition_report["capability_probe"]
    region, key, credential_source = sp.get_speech_resource(manifest["backend"])
    if region != audition_report["region"]:
        raise RuntimeError("Speech resource region changed since engine probe.")
    def render(segment):
        identifier = segment["id"]
        validate_segment(segment, sp)
        if mode == NATURAL and pronunciation_mode(segment) != NATURAL:
            raise RuntimeError("Natural corpus segment lost its pronunciation_mode.")
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
        if mode == NATURAL:
            request.update(pronunciation_mode=mode, phoneme_enforced=False, human_casting_approval=approval,
                           source_lock_sha256=digest(root / "source-lock.json"))
        archived = reuse["groups"][render_key(segment, manifest["quality"])]["reusable"] if reuse else None
        if archived:
            request["approved_reuse"] = archived
        if request_path.exists() and load(request_path) != request:
            raise RuntimeError(f"Segment inputs changed; use a new output revision: {identifier}")
        if receipt_path.exists():
            receipt = load(receipt_path)
            if not request_path.exists():
                raise RuntimeError(f"Missing request provenance: {identifier}")
            for path_field, hash_field in (("raw_path", "raw_sha256"), ("final_path", "final_sha256"), ("ssml_path", "ssml_sha256")):
                if digest(receipt[path_field]) != receipt[hash_field]:
                    raise RuntimeError(f"Previously produced audio changed: {identifier}")
            if mode == NATURAL:
                validate_natural_receipt(receipt, segment)
            return receipt
        if raw_path.exists() and not request_path.exists():
            raise RuntimeError(f"Raw master has no request provenance: {identifier}")
        save(request_path, request)
        if archived:
            if digest(archived["receipt_path"]) != archived["receipt_sha256"]:
                raise RuntimeError(f"Approved reuse receipt changed: {identifier}")
            prior = load(archived["receipt_path"])
            if prior["text"] != segment["text"] or prior["speaker"] != segment["speaker"] or prior["voice"] != segment["voice"]:
                raise RuntimeError(f"Approved reuse identity mismatch: {identifier}")
            for kind in ("raw", "final", "ssml"):
                if digest(prior[f"{kind}_path"]) != prior[f"{kind}_sha256"]:
                    raise RuntimeError(f"Approved reuse {kind} changed: {identifier}")
            if Path(prior["ssml_path"]).read_text(encoding="utf-8") != segment["ssml"]:
                raise RuntimeError(f"Approved reuse pronunciation mismatch: {identifier}")
            receipt = {**prior, "id": identifier, "source_sha256": segment["sourceSha256"],
                       "delivery_id": prior.get("delivery_id", prior["id"]), "reused_audition": False,
                       "reused_approved": {
                           **archived, "historical_release_decision_sha256": reuse["historical_release_decision_sha256"],
                           "historical_review_lock_sha256": reuse["historical_review_lock_sha256"],
                           "scope": reuse["historical_approval_scope"],
                       }}
            if mode == NATURAL:
                retain_natural_review(receipt, segment)
            save(receipt_path, receipt)
            return receipt
        ssml_path.parent.mkdir(parents=True, exist_ok=True)
        if ssml_path.exists() and ssml_path.read_text(encoding="utf-8") != segment["ssml"]:
            raise RuntimeError(f"Previously saved SSML changed: {identifier}")
        ssml_path.write_text(segment["ssml"], encoding="utf-8")
        # Reuse identical, already auditioned segments instead of paying to generate them again.
        audition = next((s for s in audition_report["segments"] if s["id"] == identifier), None)
        if not raw_path.exists():
            if audition and Path(audition["ssml_path"]).read_text(encoding="utf-8") == segment["ssml"]:
                if digest(audition["raw_path"]) != audition["raw_sha256"]:
                    raise RuntimeError(f"Audition master changed: {identifier}")
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(audition["raw_path"], raw_path)
            else:
                sp.synthesize(region, key, segment["ssml"], raw_path)
        final_path.parent.mkdir(parents=True, exist_ok=True)
        reuse_audition = audition and digest(raw_path) == audition["raw_sha256"] and Path(audition["ssml_path"]).read_text(encoding="utf-8") == segment["ssml"]
        if reuse_audition:
            if digest(audition["final_path"]) != audition["final_sha256"]:
                raise RuntimeError(f"Audition conformed master changed: {identifier}")
            shutil.copyfile(audition["final_path"], final_path)
            duration, fit_factor, fit_ok = audition["duration_seconds"], audition["fit_factor"], audition["checks"]["timing"]
            assessment = {key: audition[key] for key in ("assessment_transcription", "accuracy_score", "fluency_score", "completeness_score")}
            transcription = audition["transcription"]
            recognition = {"decision": "RECOGNIZED", "transcription": transcription}
            targets = audition["target_occurrences"]
        else:
            if not final_path.exists():
                duration, fit_factor, fit_ok = sp.conform_audio(raw_path, final_path, None, 1.0)
            else:
                duration, fit_factor, fit_ok = sp.media_duration(final_path), 1.0, True
            assessment_path = output / "assessment" / f"{identifier}.json"
            if assessment_path.exists():
                cached = load(assessment_path)
                if cached["audio_sha256"] != digest(final_path):
                    raise RuntimeError(f"Assessment master changed: {identifier}")
                assessment = cached["result"]
            else:
                assessment = sp.assess(region, key, manifest["language"], final_path, segment["text"])
                save(assessment_path, {"audio_sha256": digest(final_path), "result": assessment})
            recognition_path = output / "recognition" / f"{identifier}.json"
            if recognition_path.exists():
                cached = load(recognition_path)
                if cached["audio_sha256"] != digest(final_path):
                    raise RuntimeError(f"Independent ASR master changed: {identifier}")
                recognition = cached["result"]
            else:
                recognition = recognize_once(region, key, manifest["language"], final_path)
                save(recognition_path, {"audio_sha256": digest(final_path), "result": recognition})
            transcription = recognition["transcription"]
            targets = sp.target_occurrence_results(assessment, segment["target_words"])
        waveform = sp.waveform_metrics(final_path)
        quality = manifest["quality"]
        checks = {
            "markup": True, "timing": fit_ok and fit_factor == 1.0,
            "accuracy": (assessment["accuracy_score"] or 0) >= quality["min_accuracy"],
            "fluency": (assessment["fluency_score"] or 0) >= quality["min_fluency"],
            "completeness": (assessment["completeness_score"] or 0) >= quality["min_completeness"],
            "target_pronunciation": all(t["accuracy_score"] is not None and t["accuracy_score"] >= quality["min_target_word_accuracy"] for t in targets),
            "not_clipped": waveform["clipped_sample_fraction"] == 0,
            "nonempty": duration >= 0.15 and waveform["peak"] > 0.001,
            "independent_asr": recognition["decision"] == "RECOGNIZED",
        }
        receipt = {
            "id": identifier, "speaker": segment["speaker"], "voice": segment["voice"], "text": segment["text"],
            "source_sha256": segment["sourceSha256"], "raw_path": str(raw_path), "final_path": str(final_path),
            "reused_audition": bool(reuse_audition),
            "ssml_path": str(ssml_path), "raw_sha256": digest(raw_path), "final_sha256": digest(final_path),
            "ssml_sha256": digest(ssml_path), "duration_seconds": duration, "fit_factor": fit_factor,
            "required_ipa": segment["required_ipa"], "target_words": segment["target_words"],
            "target_occurrences": targets, **assessment, "transcription": transcription, "independent_recognition": recognition,
            "waveform": waveform, "checks": checks, "decision": "PASS" if all(checks.values()) else "NEEDS_REVIEW",
        }
        if mode == NATURAL:
            retain_natural_review(receipt, segment)
        save(receipt_path, receipt)
        return receipt

    groups = {}
    for segment in manifest["segments"]:
        groups.setdefault(render_key(segment, manifest["quality"]), []).append(segment)
    receipts, errors = [], []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(render, group[0]): group for group in groups.values()}
        for future in as_completed(futures):
            group = futures[future]
            identifier = group[0]["id"]
            try:
                receipt = future.result()
            except (RuntimeError, OSError) as error:
                errors.append({"id": identifier, "error": str(error)})
                print(f"{engine} {identifier} ERROR: {error}", flush=True)
                continue
            receipts.append(receipt)
            for segment in group[1:]:
                validate_segment(segment, sp)
                alias = {**receipt, "id": segment["id"], "source_sha256": segment["sourceSha256"],
                         "delivery_id": receipt.get("delivery_id", identifier), "shared_render_id": identifier}
                alias_path = output / "receipts" / f"{segment['id']}.json"
                if alias_path.exists() and load(alias_path) != alias:
                    raise RuntimeError(f"Shared render receipt changed: {segment['id']}")
                save(alias_path, alias)
                receipts.append(alias)
            print(f"{engine} {len(receipts)}/{len(manifest['segments'])} {identifier} {receipt['decision']}", flush=True)
    if errors:
        save(output / f"failed-requests-{engine}.json", errors)
        raise RuntimeError(f"{engine}: {len(errors)} failed requests; persisted successful masters and receipts, see failed-requests report.")
    by_id = {item["id"]: item for item in receipts}
    receipts = [by_id[segment["id"]] for segment in manifest["segments"]]
    failed = [item["id"] for item in receipts if item["decision"] != "PASS"]
    report = {
        "schema_version": "1.0", "provider": "azure-speech", "region": region, "credential_source": credential_source,
        "language": manifest["language"], "default_voice": manifest["default_voice"],
        "engine": engine, "pronunciation_mode": mode,
        "phoneme_enforced": mode != NATURAL, "phoneme_control_demonstrated": capability["sentinel_followed"],
        "prepared_dir": str(root), "audition_report_sha256": digest(audition_report_path),
        "capability_probe": capability, "segments": receipts,
        "human_casting_approval": approval, "source_lock": lock,
        "summary": {"segment_count": len(receipts), "failed_ids": failed, "maximum_fit_factor": 1.0,
                    "retained_probe_metric_flag": not capability["correct_target_scores_pass"],
                    "retained_probe_sentinel_flag": not capability["sentinel_followed"],
                    "pronunciation_review_required_ids": [r["id"] for r in receipts if r.get("pronunciation_review_required")],
                    "human_review_required": True},
        "decision": "NEEDS_REVIEW" if mode == NATURAL or failed or not capability["correct_target_scores_pass"] else "PASS",
    }
    save(output / f"production-report-{engine}.json", report)
    print(json.dumps({"engine": engine, "segments": len(receipts), "flagged_ids": failed}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--approval", type=Path, required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--reuse-plan", type=Path)
    parser.add_argument("--skill-root", type=Path, default=Path.home() / ".copilot" / "skills" / "speech-production")
    args = parser.parse_args()
    produce(args.prepared_dir.resolve(), args.output_dir.resolve(), args.approval.resolve(), args.engine,
            args.skill_root.resolve(), args.workers, args.reuse_plan.resolve() if args.reuse_plan else None)
