"""Offline regression checks; never contacts Azure or changes approved assets."""
import contextlib
import copy
import io
import math
import shutil
import struct
import subprocess
import unittest
import uuid
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from prepare import HERE, context_lexicon, digest, load, prepare, save, spoken, wrap
from produce import produce, require_approval, require_audition, validate_approval, validate_segment
from publish import TECHNICAL_CHECKS, decoded_metrics, delivery_profile, publish
from audition import audition
from freeze_review import freeze
from qa_corpus import audit
from metric_evidence import correct_possessive_targets
from pronunciation_policy import ENFORCED, NATURAL, pronunciation_mode, validate_natural_receipt
from record_release import record
from recognition import recognize_once


@contextlib.contextmanager
def offline_workspace():
    root = Path(f".voice-pipeline-test-{uuid.uuid4().hex}").resolve()
    config = root / "repository" / "scripts" / "voices"
    save(config / "cast.json", {"engines": {"ruD": "ru-RU-DmitryNeural"},
                              "profiles": {"player": {"ru": ["ruD", 0, 0]}}})
    save(config / "pronunciation.json", load(HERE / "pronunciation.json"))
    try:
        with patch("prepare.HERE", config), patch("produce.HERE", config), patch("publish.HERE", config):
            yield root
    finally:
        shutil.rmtree(root)


def fixture_lock(root):
    config = root / "repository" / "scripts" / "voices"
    return {"inventory_source_hash": "offline-source", "cast_sha256": digest(config / "cast.json"),
            "pronunciation_sha256": digest(config / "pronunciation.json")}


def write_wave(path, rate=48000):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        stream.writeframes(b"".join(struct.pack("<h", int(4000 * math.sin(2 * math.pi * i * 440 / rate)))
                                   for i in range(rate // 2)))


def natural_fixture(root, targets=True):
    config = root / "repository" / "scripts" / "voices"
    voices = {"ruN": "ru-RU-Lev:MAI-Voice-2", "enN": "en-US-Ethan:MAI-Voice-2"}
    save(config / "cast.json", {
        "pronunciation_mode": NATURAL, "engines": voices, "preferred_region": "test",
        "profiles": {"player": {"ru": ["ruN", 0, 0], "en": ["enN", 0, 0], "note": "Offline fixture"}},
        "auditions": [{"speaker": "player", "source": "offline", "label": "Offline bilingual sample"}],
    })
    save(config / "pronunciation.json", {"ru": {"Мара": "ˈma.rə", "войны": "vɐjˈnɨ"},
                                       "en": {"Mara": "ˈmɑːrə"}})
    prepared, inventory_path = root / "prepared", root / "inventory.json"
    entries = []
    for language, text in (
        ("ru", "I. Мара & «войны» <дома>.\nТочно." if targets else "Привет."),
        ("en", "I. Mara & I will read <books>.\nExactly." if targets else "Hello."),
    ):
        entries.append({"id": f"{language}-player-offline", "language": language, "speaker": "player",
                        "text": text, "sources": ["offline"], "segments": [
                            {"id": f"{language}-player-offline.0", "text": text, "sourceSha256": f"{language}-source"},
                        ]})
    save(inventory_path, {"sourceHash": "offline-source", "summary": {}, "entries": entries})
    with contextlib.redirect_stdout(io.StringIO()):
        prepare(inventory_path, prepared)
    for engine in voices:
        manifest = load(prepared / "manifests" / f"audition-{engine}.json")
        directory = prepared / "engines" / engine
        variants = {}
        for variant in manifest["capability_probe"]["variants"]:
            audio_path, ssml_path = directory / f"{variant['id']}.wav", directory / f"{variant['id']}.ssml"
            write_wave(audio_path)
            ssml_path.write_text(variant["ssml"], encoding="utf-8")
            variants[variant["id"]] = {
                "audio_path": str(audio_path), "audio_sha256": digest(audio_path),
                "ssml_path": str(ssml_path), "ssml_sha256": digest(ssml_path), "transcription": "Ignored IPA",
                "target_occurrences": [{"target": "offline", "accuracy_score": 99}],
            }
        segments = []
        for source in manifest["segments"]:
            sample = {key: source[key] for key in ("id", "speaker", "voice", "text", "required_ipa", "target_words")}
            for kind in ("raw", "final", "ssml"):
                path = directory / f"{source['id']}-{kind}{'.ssml' if kind == 'ssml' else '.wav'}"
                if kind == "ssml":
                    path.write_text(source["ssml"], encoding="utf-8")
                else:
                    write_wave(path)
                sample.update({f"{kind}_path": str(path), f"{kind}_sha256": digest(path)})
            sample.update(
                accuracy_score=99, fluency_score=99, completeness_score=100,
                assessment_transcription=source["text"], transcription=source["text"],
                duration_seconds=0.5, fit_factor=1.0, decision="PASS",
                checks={key: True for key in (*TECHNICAL_CHECKS, "accuracy", "fluency", "completeness", "target_pronunciation")},
                target_occurrences=[{"target": word, "matched_word": word, "word_index": i, "accuracy_score": 99}
                                    for i, word in enumerate(source["target_words"])],
            )
            segments.append(sample)
        save(directory / "production-report.json", {
            "region": "test", "default_voice": manifest["default_voice"], "language": manifest["language"],
            "capability_probe": {"decision": "FAIL", "sentinel_followed": False, "correct_target_scores_pass": True,
                                 "variants": variants},
            "segments": segments, "summary": {"failed_ids": [], "human_review_required": True}, "decision": "FAIL",
        })
    with contextlib.redirect_stdout(io.StringIO()):
        audition(prepared, root / "skill")
    lock = load(prepared / "source-lock.json")
    approval = {**{key: lock[key] for key in ("inventory_source_hash", "cast_sha256", "pronunciation_sha256")},
                "pronunciation_mode": NATURAL, "approved": True, "parent_session_id": "offline",
                "human_approval_reference": "Offline fixture, not real approval", "human_response": "Offline informed mode choice",
                "pronunciation_evidence_reference": "Offline ignored-sentinel evidence; not a claim of listening",
                "accepts_unenforced_pronunciation": True,
                "accepted_unenforced_pronunciation_report_sha256": {
                    engine: digest(prepared / "engines" / engine / "production-report.json") for engine in voices},
                }
    approval_path = root / "approval.json"
    save(approval_path, approval)
    return prepared, inventory_path, approval_path


def produce_natural_fixture(root, prepared, approval_path):
    skill = root / "skill"
    (skill / "scripts").mkdir(parents=True)
    (skill / "scripts" / "speech_production.py").write_text("Offline provider mock only", encoding="utf-8")
    mock = SimpleNamespace(
        validate_manifest=lambda manifest: None, validate_ssml=lambda ssml, voice: None,
        get_speech_resource=lambda backend: ("test", "offline-not-a-key", "offline"),
        waveform_metrics=lambda path: {"clipped_sample_fraction": 0, "peak": 0.5},
    )
    production = root / "production"
    with patch.dict("sys.modules", {"speech_production": mock}), contextlib.redirect_stdout(io.StringIO()):
        for engine in ("ruN", "enN"):
            produce(prepared, production, approval_path, engine, skill)
    return production


def delivery_fixture(root):
    master = root / "master.wav"
    write_wave(master)
    text, identifier = "Offline delivery only.", "ru-player-delivery.0"
    inventory, production = root / "inventory.json", root / "production"
    save(inventory, {"sourceHash": "offline-source", "summary": {}, "entries": [{
        "id": "ru-player-delivery", "speaker": "player", "language": "ru", "text": text,
        "segments": [{"id": identifier, "text": text, "sourceSha256": "offline-text"}],
    }]})
    lock = fixture_lock(root)
    save(production / "production-report-ruD.json", {
        "source_lock": lock, "human_casting_approval": {
            **lock, "approved": True, "parent_session_id": "offline",
            "human_approval_reference": "Offline fixture only",
        },
        "segments": [{
            "id": identifier, "speaker": "player", "voice": "ru-RU-DmitryNeural", "text": text,
            "source_sha256": "offline-text", "final_path": str(master), "final_sha256": digest(master),
            "duration_seconds": 0.5, "decision": "PASS", "checks": {key: True for key in TECHNICAL_CHECKS},
        }],
    })
    return inventory, production, master


class ProductionResumeTests(unittest.TestCase):
    def test_new_homographs_and_inflection_keep_display_text(self):
        pronunciation = load(HERE / "pronunciation.json")
        for line in ("He read the complaints.", "He read the letter.", "Raut read the warning.",
                     "Raut broke the monastery seal, read the warning and asked."):
            self.assertEqual(context_lexicon(line, "en", pronunciation)["read"], "rɛd")
        for line in ("I will read the records.", "You may read the books.", "Read the old instructions."):
            self.assertEqual(context_lexicon(line, "en", pronunciation)["read"], "riːd")
        with self.assertRaisesRegex(RuntimeError, "Unreviewed English read"):
            context_lexicon("They read at dusk.", "en", pronunciation)
        body, ipa, targets = spoken("С Марой.", pronunciation["ru"])
        self.assertIn(">Марой</phoneme>", body)
        self.assertEqual(ipa, ["ˈma.rəj"])
        self.assertEqual(targets, ["Марой"])

    def test_no_match_and_empty_recognition_are_explicit_review_results(self):
        import azure.cognitiveservices.speech as sdk

        with patch.object(sdk, "SpeechConfig"), patch.object(sdk.audio, "AudioConfig"), \
                patch.object(sdk, "SpeechRecognizer") as recognizer:
            for reason in (sdk.ResultReason.NoMatch, sdk.ResultReason.RecognizedSpeech):
                recognizer.return_value.recognize_once_async.return_value.get.return_value = SimpleNamespace(reason=reason, text="")
                self.assertEqual(recognize_once("test", "offline-key", "ru-RU", Path("unused.wav"))["decision"], "NO_MATCH")
            recognizer.return_value.recognize_once_async.return_value.get.return_value = SimpleNamespace(
                reason=sdk.ResultReason.Canceled,
                cancellation_details=SimpleNamespace(reason="Error", error_details="offline fixture"),
            )
            with self.assertRaisesRegex(RuntimeError, "Independent ASR cancelled"):
                recognize_once("test", "offline-key", "ru-RU", Path("unused.wav"))

    def test_release_requires_explicit_human_decision_and_unchanged_frozen_scope(self):
        with offline_workspace() as root:
            review = root / "review"
            audio = root / "sample.wav"
            audio.write_bytes(b"offline sample; never shipped")
            item = {"id": "offline", "path": str(audio), "sha256": digest(audio), "already_human_approved": False}
            save(review / "review-index.json", [item])
            save(review / "representative-index.json", [])
            save(review / "master-hashes.json", {"offline": digest(audio)})
            save(review / "review-lock.json", {
                "inventory_source_hash": "offline-source", "counts": {"new_flags": 1}, "caveats": ["Not a real approval"],
                "files": {path.name: digest(path) for path in review.glob("*.json")},
            })
            decision_path, output = root / "decision.json", root / "accepted.json"
            save(decision_path, {"automated_decision": "PASS"})
            with self.assertRaisesRegex(RuntimeError, "relayed human decision"):
                record(review, decision_path, output)
            decision = {"approved": True, "accepts_disclosed_metric_flags": True, "human_response": "Offline fixture only",
                        "timestamp": "offline", "parent_session_id": "offline", "human_review_reference": "Offline fixture, not real approval",
                        "review_lock_sha256": digest(review / "review-lock.json")}
            save(decision_path, decision)
            with contextlib.redirect_stdout(io.StringIO()):
                record(review, decision_path, output)
            self.assertTrue(load(output)["accepted_segments"]["offline"]["accepted"])
            audio.write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "Reviewed recording changed"):
                record(review, decision_path, output)

    def test_possessive_target_correction_requires_exact_source_and_assessed_token(self):
        receipt = {"id": "en-test", "text": "Raut's men.", "final_sha256": "unchanged",
                   "target_occurrences": [{"target": "Raut", "matched_word": None, "word_index": None, "accuracy_score": None}],
                   "words": [{"Word": "raut’s", "PronunciationAssessment": {"AccuracyScore": 99, "ErrorType": "None"}}],
                   "checks": {"target_pronunciation": False, "accuracy": True}, "decision": "NEEDS_REVIEW"}
        result = correct_possessive_targets(receipt)
        self.assertEqual(result["decision"], "PASS")
        self.assertEqual(result["target_occurrences"][0]["accuracy_score"], 99)
        self.assertEqual(receipt["decision"], "NEEDS_REVIEW")
        self.assertEqual(result["metric_correction"]["audio_unchanged_sha256"], "unchanged")
        receipt["text"] = "Raut spoke."
        self.assertIs(correct_possessive_targets(receipt), receipt)
        receipt["text"] = "Raut's men."
        receipt["words"][0]["PronunciationAssessment"]["AccuracyScore"] = 60
        self.assertEqual(correct_possessive_targets(receipt)["decision"], "NEEDS_REVIEW")

    def test_explicit_human_approval_cannot_be_inferred_from_scores(self):
        with offline_workspace() as root:
            lock = fixture_lock(root)
            with self.assertRaisesRegex(RuntimeError, "explicit parent-relayed"):
                validate_approval(lock, {"automated_decision": "PASS"})
            approval = {**lock, "approved": True, "human_approval_reference": "Offline test only",
                        "parent_session_id": "offline-test"}
            validate_approval(lock, approval)
            with self.assertRaisesRegex(RuntimeError, "inventory_source_hash"):
                validate_approval(lock, {**approval, "inventory_source_hash": "different"})

    def test_parallel_resume_reuses_audition_without_resynthesis_or_reassessment(self):
        with offline_workspace() as root:
            prepared, output, skill = root / "prepared", root / "output", root / "skill"
            (skill / "scripts").mkdir(parents=True)
            (skill / "scripts" / "speech_production.py").write_text("offline mock", encoding="utf-8")
            voice = "ru-RU-DmitryNeural"
            segments = [{"id": f"ru-player-test.{i}", "speaker": "player", "voice": voice,
                         "text": text, "sourceSha256": f"source-{i}", "required_ipa": [], "target_words": [],
                         "ssml": wrap(text, voice)} for i, text in enumerate(["First sentence.", "Second sentence."])]
            segments.append({**segments[0], "id": "ru-player-alias.0"})
            manifest = {"schema_version": "1.0", "language": "ru-RU", "default_voice": voice,
                        "backend": {"provider": "azure-speech"}, "segments": segments,
                        "quality": {"min_accuracy": 90, "min_fluency": 70, "min_completeness": 90,
                                    "min_target_word_accuracy": 90}}
            manifest_path = prepared / "manifests" / "corpus-ruD.json"
            save(manifest_path, manifest)
            audition = root / "audition"
            audition.mkdir()
            (audition / "raw.wav").write_bytes(b"RIFFapproved-audition")
            (audition / "final.wav").write_bytes(b"RIFFconformed-audition")
            (audition / "speech.ssml").write_text(segments[0]["ssml"], encoding="utf-8")
            metric = {"assessment_transcription": segments[0]["text"], "accuracy_score": 99,
                      "fluency_score": 98, "completeness_score": 100}
            sample = {**segments[0], **metric, "transcription": segments[0]["text"],
                      "duration_seconds": 1, "fit_factor": 1, "target_occurrences": [],
                      "checks": {"timing": True}}
            for kind, filename in [("raw", "raw.wav"), ("final", "final.wav"), ("ssml", "speech.ssml")]:
                sample[f"{kind}_path"] = str(audition / filename)
                sample[f"{kind}_sha256"] = digest(audition / filename)
            save(prepared / "engines" / "ruD" / "production-report.json", {
                "region": "test", "segments": [sample],
                "capability_probe": {"sentinel_followed": True, "correct_target_scores_pass": True},
            })
            lock = {"manifest_sha256": {manifest_path.name: digest(manifest_path)}}
            calls = {"synthesis": 0, "conformance": 0, "assessment": 0, "transcription": 0}

            def synthesize(region, key, ssml, path):
                calls["synthesis"] += 1
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"RIFFnew-speech")

            def conform(source, target, ceiling, factor):
                calls["conformance"] += 1
                target.write_bytes(source.read_bytes())
                return 1.0, 1.0, True

            def assess(*args):
                calls["assessment"] += 1
                return {**metric, "assessment_transcription": segments[1]["text"]}

            def transcribe(*args):
                calls["transcription"] += 1
                return {"decision": "RECOGNIZED", "transcription": segments[1]["text"]}

            mock = SimpleNamespace(
                validate_manifest=lambda manifest: None, validate_ssml=lambda ssml, voice: None,
                get_speech_resource=lambda backend: ("test", "not-a-real-key", "offline"),
                synthesize=synthesize, conform_audio=conform, assess=assess, transcribe=transcribe,
                target_occurrence_results=lambda assessment, targets: [],
                waveform_metrics=lambda path: {"clipped_sample_fraction": 0, "peak": 0.5},
                media_duration=lambda path: 1.0,
            )
            with patch.dict("sys.modules", {"speech_production": mock}), \
                    patch("produce.require_approval", return_value=(lock, {})), \
                    patch("produce.recognize_once", side_effect=transcribe), \
                    contextlib.redirect_stdout(io.StringIO()):
                produce(prepared, output, root / "approval.json", "ruD", skill, workers=2)
                self.assertEqual(calls, {"synthesis": 1, "conformance": 1, "assessment": 1, "transcription": 1})
                first = (output / "production-report-ruD.json").read_bytes()
                produce(prepared, output, root / "approval.json", "ruD", skill, workers=2)
                self.assertEqual(calls, {"synthesis": 1, "conformance": 1, "assessment": 1, "transcription": 1})
                self.assertEqual(first, (output / "production-report-ruD.json").read_bytes())
                self.assertTrue(load(output / "receipts" / "ru-player-test.0.json")["reused_audition"])
                alias = load(output / "receipts" / "ru-player-alias.0.json")
                self.assertEqual(alias["shared_render_id"], "ru-player-test.0")
                self.assertEqual(alias["final_path"], load(output / "receipts" / "ru-player-test.0.json")["final_path"])
                (output / "final" / "ru-player-test.0.wav").write_bytes(b"modified")
                with self.assertRaisesRegex(RuntimeError, "failed requests"):
                    produce(prepared, output, root / "approval.json", "ruD", skill, workers=2)
                errors = load(output / "failed-requests-ruD.json")
                self.assertIn("Previously produced audio changed", errors[0]["error"])

    def test_publish_requires_complete_reviewed_audio_and_resume_preserves_ogg(self):
        with offline_workspace() as root:
            master = root / "master.wav"
            with wave.open(str(master), "wb") as stream:
                stream.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                stream.writeframes(b"".join(struct.pack("<h", int(4000 * math.sin(2 * math.pi * i * 440 / 24000)))
                                           for i in range(12000)))
            text = "Offline codec test."
            inventory_path, production, public = root / "inventory.json", root / "production", root / "public"
            save(inventory_path, {"sourceHash": "offline-source", "summary": {}, "entries": [{
                "id": "ru-player-offline", "speaker": "player", "language": "ru", "text": text,
                "segments": [{"id": "ru-player-offline.001", "text": text, "sourceSha256": "offline-text"}],
            }]})
            lock = fixture_lock(root)
            approval = {**lock, "approved": True, "parent_session_id": "offline-test",
                        "human_approval_reference": "Offline fixture, not a real human asset approval."}
            report = {"source_lock": lock, "human_casting_approval": approval, "segments": [{
                "id": "ru-player-offline.001", "speaker": "player", "voice": "ru-RU-DmitryNeural",
                "text": text, "source_sha256": "offline-text", "final_path": str(master),
                "final_sha256": digest(master), "duration_seconds": 0.5,
                "decision": "NEEDS_REVIEW",
                "checks": {"markup": True, "timing": True, "not_clipped": True, "nonempty": True, "accuracy": False},
            }]}
            save(production / "production-report-ruD.json", report)
            with self.assertRaisesRegex(RuntimeError, "Unreviewed pronunciation"):
                publish(inventory_path, production, public)
            self.assertFalse(public.exists())
            staging = root / "staging"
            with contextlib.redirect_stdout(io.StringIO()):
                publish(inventory_path, production, staging, stage_only=True)
            self.assertFalse((staging / "audio" / "voices" / "manifest.json").exists())
            self.assertTrue((staging / "audio" / "voices" / "staging-index.json").exists())
            with self.assertRaisesRegex(RuntimeError, "outside the repository"):
                publish(inventory_path, production, root / "repository", stage_only=True)
            review_path = root / "review.json"
            save(review_path, {"accepted_segments": {"ru-player-offline.001": {
                "accepted": True, "audio_sha256": digest(master),
                "human_review_reference": "Offline fixture, not a real human asset approval.",
            }}})
            with contextlib.redirect_stdout(io.StringIO()):
                publish(inventory_path, production, public, review_path, staged_dir=staging)
            manifest_path = public / "audio" / "voices" / "manifest.json"
            manifest = load(manifest_path)
            self.assertEqual(manifest["entries"][0]["text"], text)
            clip = public.joinpath(*manifest["entries"][0]["clips"][0]["src"].split("/"))
            before = (digest(clip), clip.stat().st_mtime_ns)
            with contextlib.redirect_stdout(io.StringIO()):
                publish(inventory_path, production, public, review_path)
            self.assertEqual(before, (digest(clip), clip.stat().st_mtime_ns))
            completed = subprocess.run(["node", str(HERE / "verify.mjs"), str(inventory_path), str(public)],
                                       capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn('"complete":true', completed.stdout)
            clip.write_bytes(clip.read_bytes() + b"modified")
            with self.assertRaisesRegex(RuntimeError, "changed existing deployment clip"):
                publish(inventory_path, production, public, review_path)
            report["human_casting_approval"]["approval_kind"] = "existing-cast-regeneration"
            report["segments"][0]["decision"] = "PASS"
            save(production / "production-report-ruD.json", report)
            with self.assertRaisesRegex(RuntimeError, "own informed human release"):
                publish(inventory_path, production, public)


class NaturalReviewedTests(unittest.TestCase):
    def test_modes_and_natural_plaintext_preserve_targets_and_four_probes(self):
        self.assertEqual(pronunciation_mode({}), ENFORCED)
        for unknown in ("natural", "", None, False):
            with self.assertRaisesRegex(RuntimeError, "Unknown pronunciation_mode"):
                pronunciation_mode({"pronunciation_mode": unknown})
        self.assertIn('<prosody rate="+0%" pitch="+0%">', wrap("Exact.", "ru-RU-DmitryNeural"))
        for rate, pitch in ((1, 0), (0, -1), (False, 0), (0, "0")):
            with self.assertRaisesRegex(RuntimeError, "zero rate/pitch"):
                wrap("Exact.", "ru-RU-Lev:MAI-Voice-2", rate, pitch, NATURAL)
        with offline_workspace() as root:
            prepared, inventory_path, approval_path = natural_fixture(root)
            lock, _ = require_approval(prepared, approval_path)
            self.assertEqual(lock["pronunciation_mode"], NATURAL)
            self.assertEqual(lock["cast_sha256"], fixture_lock(root)["cast_sha256"])
            references = load(prepared / "pronunciation-review.json")
            self.assertIn("войны", references[0]["targets"])
            self.assertEqual(references[0]["ipa"], references[0]["expected_ipa"])
            inventory = load(inventory_path)
            for entry, engine in zip(inventory["entries"], ("ruN", "enN")):
                manifest = load(prepared / "manifests" / f"corpus-{engine}.json")
                segment = manifest["segments"][0]
                self.assertEqual(segment["id"], entry["segments"][0]["id"])
                self.assertEqual(segment["text"], entry["text"])
                self.assertEqual(segment["required_ipa"], [])
                self.assertTrue(segment["expected_ipa"])
                self.assertTrue(segment["pronunciation_review_required"])
                self.assertNotIn("<phoneme", segment["ssml"])
                self.assertNotIn("<prosody", segment["ssml"])
                self.assertIn("&amp;", segment["ssml"])
                self.assertIn("&lt;", segment["ssml"])
                validate_segment(segment, SimpleNamespace(validate_ssml=lambda *args: None))
                variants = manifest["capability_probe"]["variants"]
                self.assertEqual([v["id"] for v in variants], ["plain", "correct", "swapped", "sentinel"])
                self.assertNotIn("<phoneme", variants[0]["ssml"])
                self.assertTrue(all("<phoneme" in v["ssml"] and "<prosody" not in v["ssml"] for v in variants[1:]))
                report = load(prepared / "engines" / engine / "production-report.json")
                self.assertEqual(report["decision"], "FAIL")
                self.assertFalse(report["capability_probe"]["sentinel_followed"])
                self.assertFalse(report["segments"][0]["checks"]["pronunciation_review"])
                original = load(prepared / "engines" / engine / "skill-production-report.json")
                self.assertNotIn("pronunciation_mode", original)
            before = digest(prepared / "engines" / "ruN" / "production-report.json")
            with contextlib.redirect_stdout(io.StringIO()):
                audition(prepared, root / "skill")
            self.assertEqual(before, digest(prepared / "engines" / "ruN" / "production-report.json"))

    def test_natural_rejects_markup_even_when_visible_text_is_unchanged(self):
        with offline_workspace() as root:
            prepared, _, _ = natural_fixture(root)
            source = load(prepared / "manifests" / "corpus-ruN.json")["segments"][0]
            for text in ("<phoneme alphabet=\"ipa\" ph=\"wrong\">Мара</phoneme>",
                         "<prosody rate=\"+0%\">Мара</prosody>", "<sub alias=\"Other\">Мара</sub>"):
                modified = {**source, "ssml": source["ssml"].replace("Мара", text)}
                with self.assertRaisesRegex(RuntimeError, "exact plaintext"):
                    validate_segment(modified, SimpleNamespace(validate_ssml=lambda *args: None))

    def test_natural_requires_explicit_informed_approval_and_every_exact_report_hash(self):
        with offline_workspace() as root:
            prepared, _, approval_path = natural_fixture(root)
            approval = load(approval_path)
            lock = load(prepared / "source-lock.json")
            for field in ("approved", "parent_session_id", "human_approval_reference", "human_response",
                          "pronunciation_mode", "accepts_unenforced_pronunciation", "pronunciation_evidence_reference",
                          "accepted_unenforced_pronunciation_report_sha256"):
                invalid = {key: value for key, value in approval.items() if key != field}
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    validate_approval(lock, invalid)
            for reports in ({}, {"ruN": "0" * 64}, {"ruN": "not-a-hash", "enN": "0" * 64}):
                with self.subTest(reports=reports), self.assertRaisesRegex(RuntimeError, "every actual audition"):
                    validate_approval(lock, {**approval, "accepted_unenforced_pronunciation_report_sha256": reports})
            save(approval_path, {**approval, "accepted_unenforced_pronunciation_report_sha256": {
                **approval["accepted_unenforced_pronunciation_report_sha256"], "enN": "0" * 64,
            }})
            with self.assertRaisesRegex(RuntimeError, "actual audition report hash"):
                require_approval(prepared, approval_path)
            save(approval_path, approval)
            report_path = prepared / "engines" / "enN" / "production-report.json"
            report_path.write_bytes(report_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(RuntimeError, "actual audition report hash"):
                require_approval(prepared, approval_path)

    def test_strict_sentinel_cannot_be_waived_by_human_metric_acceptance(self):
        with offline_workspace() as root:
            path = root / "engines" / "ruD" / "production-report.json"
            report = {"capability_probe": {"sentinel_followed": False, "correct_target_scores_pass": False}}
            save(path, report)
            approval = {
                "accepted_probe_report_sha256": {"ruD": digest(path)},
                "accepted_audition_report_sha256": {"ruD": digest(path)},
                "accepted_unenforced_pronunciation_report_sha256": {"ruD": digest(path)},
                "accepts_unenforced_pronunciation": True,
            }
            with self.assertRaisesRegex(RuntimeError, "phoneme payload control"):
                require_audition(root, {}, approval, "ruD")
            report["capability_probe"]["sentinel_followed"] = True
            save(path, report)
            with self.assertRaisesRegex(RuntimeError, "hash-bound human acceptance"):
                require_audition(root, {}, approval, "ruD")
            approval["accepted_probe_report_sha256"]["ruD"] = digest(path)
            self.assertEqual(require_audition(root, {}, approval, "ruD"), report)

    def test_natural_probe_and_receipt_evidence_cannot_be_dropped_or_relabelled(self):
        with offline_workspace() as root:
            prepared, _, approval_path = natural_fixture(root)
            report_path = prepared / "engines" / "ruN" / "production-report.json"
            report = load(report_path)
            approval = load(approval_path)
            for mutation in ("missing-variant", "pretend-pass", "lost-review-flag"):
                changed = copy.deepcopy(report)
                if mutation == "missing-variant":
                    del changed["capability_probe"]["variants"]["swapped"]
                elif mutation == "pretend-pass":
                    changed["decision"] = "PASS"
                else:
                    del changed["segments"][0]["checks"]["pronunciation_review"]
                save(report_path, changed)
                approval["accepted_unenforced_pronunciation_report_sha256"]["ruN"] = digest(report_path)
                save(approval_path, approval)
                with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                    require_approval(prepared, approval_path)
            save(report_path, report)
            approval["accepted_unenforced_pronunciation_report_sha256"]["ruN"] = digest(report_path)
            save(approval_path, approval)
            Path(report["capability_probe"]["variants"]["sentinel"]["audio_path"]).write_bytes(b"changed evidence")
            with self.assertRaisesRegex(RuntimeError, "probe evidence changed"):
                require_approval(prepared, approval_path)

    def test_natural_flags_survive_production_qa_metric_correction_and_final_release(self):
        with offline_workspace() as root:
            prepared, inventory, approval_path = natural_fixture(root)
            approval = load(approval_path)
            approval["accepted_audition_report_sha256"] = approval["accepted_unenforced_pronunciation_report_sha256"]
            save(approval_path, approval)
            production = produce_natural_fixture(root, prepared, approval_path)
            report_path = production / "production-report-ruN.json"
            report = load(report_path)
            receipt = report["segments"][0]
            self.assertFalse(report["phoneme_enforced"])
            self.assertTrue(report["summary"]["retained_probe_sentinel_flag"])
            self.assertTrue(receipt["checks"]["target_pronunciation"])
            self.assertFalse(receipt["checks"]["pronunciation_review"])
            self.assertEqual(receipt["decision"], "NEEDS_REVIEW")
            request = load(production / "requests" / f"{receipt['id']}.json")
            self.assertEqual(request["pronunciation_mode"], NATURAL)
            self.assertEqual(request["human_casting_approval"], approval)
            self.assertEqual(request["source_lock_sha256"], digest(prepared / "source-lock.json"))
            invalid = copy.deepcopy(receipt)
            invalid["checks"]["pronunciation_review"] = True
            with self.assertRaisesRegex(RuntimeError, "persistent false"):
                validate_natural_receipt(invalid)
            possessive = {
                **receipt, "id": "en-offline", "text": "Raut's men.", "target_words": ["Raut"], "expected_ipa": ["raʊt"],
                "target_occurrences": [{"target": "Raut", "matched_word": None, "word_index": None, "accuracy_score": None}],
                "words": [{"Word": "raut’s", "PronunciationAssessment": {"AccuracyScore": 99, "ErrorType": "None"}}],
            }
            corrected = correct_possessive_targets(possessive)
            self.assertEqual(corrected["decision"], "NEEDS_REVIEW")
            self.assertFalse(corrected["checks"]["pronunciation_review"])
            qa = root / "qa"
            with contextlib.redirect_stdout(io.StringIO()):
                audit(inventory, production, prepared, approval_path, qa, require_complete=True)
            summary = load(qa / "qa-summary.json")
            self.assertEqual(summary["flagged"], 2)
            self.assertEqual(summary["flagged_already_human_approved"], 0)
            self.assertEqual(summary["decision"], "NEEDS_REVIEW")
            self.assertTrue(all(item["expected_ipa"] and item["review_priority"] == "unenforced-pronunciation"
                                for item in load(qa / "review-index.json")))
            with self.assertRaisesRegex(RuntimeError, "own informed human release"):
                publish(inventory, production, root / "public", qa / "human-reviewed-auditions.json")
            with contextlib.redirect_stdout(io.StringIO()):
                publish(inventory, production, root / "staging", stage_only=True)
            self.assertFalse((root / "staging" / "audio" / "voices" / "manifest.json").exists())
            representatives = load(qa / "representative-index.json")
            save(qa / "acoustic-report.json", {
                "audio_sha256": {item["path"]: item["sha256"] for item in representatives},
                "scores": {item["path"]: {"minimum_mos": 4.9} for item in representatives}, "not_scored": [],
            })
            frozen = root / "frozen"
            with contextlib.redirect_stdout(io.StringIO()):
                freeze(qa, root / "asr", production, frozen)
            decision = {
                "approved": True, "accepts_disclosed_metric_flags": True, "human_response": "Offline final decision only",
                "timestamp": "offline", "parent_session_id": "offline", "human_review_reference": "Offline release fixture",
                "review_lock_sha256": digest(frozen / "review-lock.json"),
            }
            decision_path, release_path = root / "decision.json", root / "release.json"
            save(decision_path, decision)
            with self.assertRaisesRegex(RuntimeError, "acceptance of unenforced"):
                record(frozen, decision_path, release_path)
            decision.update(pronunciation_mode=NATURAL, accepts_unenforced_pronunciation=True)
            save(decision_path, decision)
            with contextlib.redirect_stdout(io.StringIO()):
                record(frozen, decision_path, release_path)
                publish(inventory, production, root / "public", release_path, staged_dir=root / "staging")
            provenance = load(root / "public" / "audio" / "voices" / "provenance.json")
            self.assertEqual(provenance["pronunciation_mode"], NATURAL)
            self.assertFalse(provenance["phoneme_enforced"])
            self.assertEqual(provenance["cast_approval"], approval)
            self.assertEqual(provenance["recording_release_approval"]["human_response"], decision["human_response"])
            self.assertEqual(len(provenance["retained_automated_flags"]), 2)
            self.assertTrue(all(not item["phoneme_control_demonstrated"] for item in provenance["pronunciation_evidence"]))
            report_path.write_bytes(report_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(RuntimeError, "every current production report"):
                publish(inventory, production, root / "public", release_path)
            release = load(release_path)
            for check in TECHNICAL_CHECKS:
                changed = copy.deepcopy(report)
                changed["segments"][0]["checks"][check] = False
                save(report_path, changed)
                release["release_approval"]["production_report_sha256"][report_path.name] = digest(report_path)
                save(release_path, release)
                with self.subTest(check=check), self.assertRaisesRegex(RuntimeError, "Technical defect"):
                    publish(inventory, production, root / "public", release_path)
                with self.subTest(staging_check=check), self.assertRaisesRegex(RuntimeError, "Technical defect"):
                    publish(inventory, production, root / "staging", stage_only=True)

    def test_natural_all_numerical_pass_without_targets_still_needs_final_release(self):
        with offline_workspace() as root:
            prepared, inventory, approval = natural_fixture(root, targets=False)
            production = produce_natural_fixture(root, prepared, approval)
            self.assertTrue(all(load(path)["decision"] == "PASS" for path in (production / "receipts").glob("*.json")))
            with self.assertRaisesRegex(RuntimeError, "own informed human release"):
                publish(inventory, production, root / "public")
            qa = root / "qa"
            with contextlib.redirect_stdout(io.StringIO()):
                audit(inventory, production, prepared, approval, qa, require_complete=True)
            self.assertEqual(load(qa / "qa-summary.json")["decision"], "NEEDS_REVIEW")


class DeliveryHeadroomTests(unittest.TestCase):
    def test_gain_rejects_amplification_and_nonfinite_values_before_io(self):
        for gain in (0.01, 3, float("nan"), float("inf"), -float("inf"), True, "bad", None):
            with self.subTest(gain=gain), self.assertRaisesRegex(RuntimeError, "finite nonpositive"):
                publish(Path("unused"), Path("unused"), Path("unused"), delivery_gain_db=gain)
        self.assertEqual(delivery_profile(0), delivery_profile(-0.0))
        self.assertEqual(delivery_profile(-3), delivery_profile(-3.0))

    def test_profiles_isolate_clips_and_copy_exact_staged_bytes_without_changing_masters(self):
        with offline_workspace() as root, contextlib.redirect_stdout(io.StringIO()):
            inventory, production, master = delivery_fixture(root)
            report_path = production / "production-report-ruD.json"
            originals = digest(master), digest(report_path)
            zero, attenuated, public = root / "zero", root / "minus3", root / "public"
            with patch("publish.subprocess.run", wraps=subprocess.run) as codec:
                publish(inventory, production, zero, stage_only=True)
                publish(inventory, production, attenuated, stage_only=True, delivery_gain_db=-3)
            encodes = [call.args[0] for call in codec.call_args_list if "libvorbis" in call.args[0]]
            self.assertEqual(len(encodes), 2)
            self.assertNotIn("-af", encodes[0])
            self.assertEqual(encodes[1][encodes[1].index("-af") + 1], "volume=-3dB:precision=double")
            zero_index = load(zero / "audio" / "voices" / "staging-index.json")
            index = load(attenuated / "audio" / "voices" / "staging-index.json")
            zero_src, src = next(iter(zero_index["clip_sha256"])), next(iter(index["clip_sha256"]))
            self.assertNotEqual(src, zero_src)
            self.assertNotIn("-delivery-", zero_src)
            profile, profile_hash = delivery_profile(-3)
            self.assertIn(f"-delivery-{profile_hash[:12]}.ogg", src)
            self.assertEqual(index["delivery_profile"], profile)
            self.assertEqual(index["delivery_profile_sha256"], profile_hash)
            encoded = load(production / "encoded-receipts" / f"{Path(src).stem}.json")
            self.assertEqual(encoded["delivery_profile"], profile)
            self.assertEqual(encoded["delivery_profile_sha256"], profile_hash)
            self.assertEqual(encoded["decoded_audio"]["sample_rate_hz"], 48000)
            self.assertGreater(encoded["decoded_audio"]["sample_count"], 0)
            self.assertAlmostEqual(index["delivery_statistics"]["maximum_decoded_peak"] /
                                   zero_index["delivery_statistics"]["maximum_decoded_peak"], 10 ** (-3 / 20), delta=0.02)
            zero_clip = zero.joinpath(*zero_src.split("/"))
            zero_snapshot = zero_clip.read_bytes(), (zero / "audio" / "voices" / "staging-index.json").read_bytes()
            with self.assertRaisesRegex(RuntimeError, "Existing staging output delivery profile"):
                publish(inventory, production, zero, stage_only=True, delivery_gain_db=-3)
            self.assertEqual(zero_snapshot, (zero_clip.read_bytes(), (zero / "audio" / "voices" / "staging-index.json").read_bytes()))
            publish(inventory, production, public, staged_dir=zero)
            old_public_clip = public.joinpath(*zero_src.split("/"))
            old_public_bytes = old_public_clip.read_bytes()
            with patch("publish.subprocess.run", wraps=subprocess.run) as codec:
                publish(inventory, production, public, staged_dir=attenuated, delivery_gain_db=-3)
            self.assertFalse(any("libvorbis" in call.args[0] for call in codec.call_args_list))
            self.assertEqual(public.joinpath(*src.split("/")).read_bytes(), attenuated.joinpath(*src.split("/")).read_bytes())
            self.assertEqual(old_public_clip.read_bytes(), old_public_bytes)
            provenance = load(public / "audio" / "voices" / "provenance.json")
            self.assertEqual(provenance["delivery_profile"], profile)
            self.assertEqual(provenance["delivery_profile_sha256"], profile_hash)
            self.assertEqual(originals, (digest(master), digest(report_path)))

    def test_staged_and_encoded_profile_mismatches_reject_with_zero_only_legacy_support(self):
        with offline_workspace() as root, contextlib.redirect_stdout(io.StringIO()):
            inventory, production, _ = delivery_fixture(root)
            stage, minus3 = root / "zero", root / "minus3"
            publish(inventory, production, stage, stage_only=True)
            publish(inventory, production, minus3, stage_only=True, delivery_gain_db=-3)
            for source, gain in ((stage, -3), (minus3, 0)):
                with self.subTest(gain=gain), self.assertRaisesRegex(RuntimeError, "Staged Ogg delivery profile"):
                    publish(inventory, production, root / "mismatch", staged_dir=source, delivery_gain_db=gain)
            with self.assertRaisesRegex(RuntimeError, "Historical Ogg delivery profile"):
                publish(inventory, production, root / "historical-mismatch", reused_staging=stage, delivery_gain_db=-3)
            index_path = stage / "audio" / "voices" / "staging-index.json"
            legacy = load(index_path)
            del legacy["delivery_profile"]
            del legacy["delivery_profile_sha256"]
            save(index_path, legacy)
            with self.assertRaisesRegex(RuntimeError, "Staged Ogg delivery profile"):
                publish(inventory, production, root / "legacy-mismatch", staged_dir=stage, delivery_gain_db=-3)
            zero_src = next(iter(legacy["clip_sha256"]))
            zero_receipt_path = production / "encoded-receipts" / f"{Path(zero_src).stem}.json"
            zero_receipt = load(zero_receipt_path)
            del zero_receipt["delivery_profile"]
            del zero_receipt["delivery_profile_sha256"]
            save(zero_receipt_path, zero_receipt)
            publish(inventory, production, root / "legacy-compatible", staged_dir=stage)
            self.assertFalse((root / "legacy-mismatch").exists())
            index = load(minus3 / "audio" / "voices" / "staging-index.json")
            src = next(iter(index["clip_sha256"]))
            receipt_path = production / "encoded-receipts" / f"{Path(src).stem}.json"
            receipt = load(receipt_path)
            del receipt["delivery_profile"]
            del receipt["delivery_profile_sha256"]
            save(receipt_path, receipt)
            with self.assertRaisesRegex(RuntimeError, "Encoded receipt delivery profile"):
                publish(inventory, production, root / "receipt-mismatch", staged_dir=minus3, delivery_gain_db=-3)

    def test_float_decode_rejects_overshoot_silence_empty_and_nonfinite_audio(self):
        cases = (b"", b"\0", struct.pack("<ff", 0, 0), struct.pack("<f", float("nan")),
                 struct.pack("<f", float("inf")), struct.pack("<f", -float("inf")),
                 struct.pack("<f", 1.0), struct.pack("<f", 1.008167), struct.pack("<f", -1.008167))
        for data in cases:
            with self.subTest(data=data), patch("publish.subprocess.run", return_value=SimpleNamespace(stdout=data)), \
                    self.assertRaises(RuntimeError):
                decoded_metrics(Path("offline.ogg"))
        with patch("publish.subprocess.run", return_value=SimpleNamespace(stdout=struct.pack("<ff", -0.99, 0.25))) as decoder:
            result = decoded_metrics(Path("offline.ogg"))
            command = decoder.call_args.args[0]
            self.assertEqual(command[command.index("-ar") + 1], "48000")
            self.assertIn("pcm_f32le", command)
            self.assertNotIn("-t", command)
            self.assertEqual(result["sample_count"], 2)
            self.assertAlmostEqual(result["peak"], 0.99)
        with offline_workspace() as root, contextlib.redirect_stdout(io.StringIO()):
            inventory, production, master = delivery_fixture(root)
            report_path = production / "production-report-ruD.json"
            originals = digest(master), digest(report_path)
            actual_run = subprocess.run

            def overshoot(command, **kwargs):
                if "pcm_f32le" in command:
                    return SimpleNamespace(stdout=struct.pack("<f", 1.008167))
                return actual_run(command, **kwargs)

            with patch("publish.subprocess.run", side_effect=overshoot), self.assertRaisesRegex(RuntimeError, "peak < 1.0"):
                publish(inventory, production, root / "blocked", stage_only=True, delivery_gain_db=-3)
            self.assertFalse((root / "blocked" / "audio" / "voices" / "staging-index.json").exists())
            self.assertFalse((root / "blocked" / "audio" / "voices" / "manifest.json").exists())
            self.assertFalse((production / "encoded-receipts").exists())
            self.assertEqual(originals, (digest(master), digest(report_path)))


if __name__ == "__main__":
    unittest.main()
