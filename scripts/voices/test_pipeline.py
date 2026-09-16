"""Offline regression checks; never contacts Azure or changes approved assets."""
import contextlib
import io
import math
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from prepare import HERE, digest, load, save, wrap
from produce import produce, validate_approval
from publish import publish
from metric_evidence import correct_possessive_targets
from record_release import record
from recognition import recognize_once


class ProductionResumeTests(unittest.TestCase):
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
        with tempfile.TemporaryDirectory(prefix="korovany-voice-release-test-") as temporary:
            root = Path(temporary)
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
        lock = {
            "inventory_source_hash": "test-source",
            "cast_sha256": digest(HERE / "cast.json"),
            "pronunciation_sha256": digest(HERE / "pronunciation.json"),
        }
        with self.assertRaisesRegex(RuntimeError, "explicit parent-relayed"):
            validate_approval(lock, {"automated_decision": "PASS"})
        approval = {**lock, "approved": True, "human_approval_reference": "Offline test only",
                    "parent_session_id": "offline-test"}
        validate_approval(lock, approval)
        with self.assertRaisesRegex(RuntimeError, "inventory_source_hash"):
            validate_approval(lock, {**approval, "inventory_source_hash": "different"})

    def test_parallel_resume_reuses_audition_without_resynthesis_or_reassessment(self):
        with tempfile.TemporaryDirectory(prefix="korovany-voice-test-") as temporary:
            root = Path(temporary)
            prepared, output, skill = root / "prepared", root / "output", root / "skill"
            (skill / "scripts").mkdir(parents=True)
            (skill / "scripts" / "speech_production.py").write_text("offline mock", encoding="utf-8")
            voice = "ru-RU-DmitryNeural"
            segments = [{"id": f"ru-player-test.{i}", "speaker": "player", "voice": voice,
                         "text": text, "sourceSha256": f"source-{i}", "required_ipa": [], "target_words": [],
                         "ssml": wrap(text, voice)} for i, text in enumerate(["First sentence.", "Second sentence."])]
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
                (output / "final" / "ru-player-test.0.wav").write_bytes(b"modified")
                with self.assertRaisesRegex(RuntimeError, "failed requests"):
                    produce(prepared, output, root / "approval.json", "ruD", skill, workers=2)
                errors = load(output / "failed-requests-ruD.json")
                self.assertIn("Previously produced audio changed", errors[0]["error"])

    def test_publish_requires_complete_reviewed_audio_and_resume_preserves_ogg(self):
        with tempfile.TemporaryDirectory(prefix="korovany-voice-publish-test-") as temporary:
            root = Path(temporary)
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
            lock = {"inventory_source_hash": "offline-source", "cast_sha256": digest(HERE / "cast.json"),
                    "pronunciation_sha256": digest(HERE / "pronunciation.json")}
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
                publish(inventory_path, production, HERE, stage_only=True)
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


if __name__ == "__main__":
    unittest.main()
