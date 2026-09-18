"""Azure's NoMatch is a review outcome, not a cancellation or a successful transcript."""


def recognize_once(region, key, language, path):
    import azure.cognitiveservices.speech as sdk

    config = sdk.SpeechConfig(subscription=key, region=region)
    config.speech_recognition_language = language
    recognizer = sdk.SpeechRecognizer(speech_config=config, audio_config=sdk.audio.AudioConfig(filename=str(path)))
    result = recognizer.recognize_once_async().get()
    if result.reason == sdk.ResultReason.RecognizedSpeech and result.text.strip():
        return {"decision": "RECOGNIZED", "transcription": result.text}
    if result.reason in (sdk.ResultReason.NoMatch, sdk.ResultReason.RecognizedSpeech):
        return {"decision": "NO_MATCH", "transcription": "", "reason": "Azure independent ASR returned no recognized words; retained for review."}
    details = result.cancellation_details
    raise RuntimeError(f"Independent ASR cancelled: {details.reason}; {details.error_details}")
