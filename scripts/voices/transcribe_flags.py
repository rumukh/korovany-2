"""One cached full-file Azure ASR pass for flagged clips, never resynthesizing audio."""
import argparse
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from prepare import digest, load, save


def continuous_transcript(path, language, region, key):
    import azure.cognitiveservices.speech as sdk
    import soundfile as sf

    config = sdk.SpeechConfig(subscription=key, region=region)
    config.speech_recognition_language = language
    recognizer = sdk.SpeechRecognizer(speech_config=config, audio_config=sdk.audio.AudioConfig(filename=str(path)))
    utterances, cancellations, no_matches = [], [], []
    finished = threading.Event()

    def recognized(event):
        if event.result.reason == sdk.ResultReason.RecognizedSpeech and event.result.text.strip():
            utterances.append({"text": event.result.text, "offset_ticks": event.result.offset,
                               "duration_ticks": event.result.duration})
        elif event.result.reason == sdk.ResultReason.NoMatch:
            no_matches.append({"offset_ticks": event.result.offset, "duration_ticks": event.result.duration})

    def cancelled(event):
        details = event.result.cancellation_details
        if details.reason == sdk.CancellationReason.Error:
            cancellations.append(str(details.error_details))
        finished.set()

    recognizer.recognized.connect(recognized)
    recognizer.canceled.connect(cancelled)
    recognizer.session_stopped.connect(lambda event: finished.set())
    recognizer.start_continuous_recognition_async().get()
    try:
        if not finished.wait(sf.info(path).duration + 60):
            raise RuntimeError("Full-file ASR timed out.")
    finally:
        recognizer.stop_continuous_recognition_async().get()
    if cancellations:
        raise RuntimeError("Full-file ASR service error: " + "; ".join(cancellations))
    if not utterances:
        return {"decision": "NO_MATCH", "transcription": "", "utterances": [],
                "no_match_regions": no_matches, "reason": "Full-file Azure ASR recognized no words; review required."}
    utterances.sort(key=lambda item: item["offset_ticks"])
    return {"decision": "RECOGNIZED", "transcription": " ".join(item["text"] for item in utterances),
            "utterances": utterances, "no_match_regions": no_matches}


def transcribe(index_path, output, skill, workers=3, identifiers=None):
    sys.path.insert(0, str(skill / "scripts"))
    import speech_production as sp

    index = load(index_path)
    selected = [item for item in index if not item["already_human_approved"]
                and not item["independent_asr_exact_tokens"] and (not identifiers or item["id"] in identifiers)]
    region, key, _ = sp.get_speech_resource({"preferred_region": "swedencentral"})
    output.mkdir(parents=True, exist_ok=True)

    def one(item):
        path = Path(item["path"])
        audio_hash = digest(path)
        if item["sha256"] != audio_hash:
            raise RuntimeError(f"Flagged audio changed: {item['id']}")
        destination = output / f"{item['id']}.json"
        if destination.exists():
            prior = load(destination)
            if prior["audio_sha256"] != audio_hash:
                raise RuntimeError(f"Full-file ASR cache belongs to different audio: {item['id']}")
            return prior
        language = "-".join(item["voice"].split("-")[:2])
        result = continuous_transcript(path, language, region, key)
        receipt = {"id": item["id"], "audio_sha256": audio_hash, "method": "Azure continuous full-file recognition",
                   "expected_text": item["text"], **result}
        save(destination, receipt)
        return receipt

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(one, item) for item in selected]
        for future in as_completed(futures):
            result = future.result()
            print(f"{result['id']}: {result.get('decision', 'RECOGNIZED')} {result['transcription']}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=3, choices=range(1, 9))
    parser.add_argument("--id", action="append")
    parser.add_argument("--skill-root", type=Path, default=Path.home() / ".copilot" / "skills" / "speech-production")
    args = parser.parse_args()
    transcribe(args.index.resolve(), args.output_dir.resolve(), args.skill_root.resolve(), args.workers, args.id)
