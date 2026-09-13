"""Create Azure Speech skill manifests; never changes displayed narrative text."""
import argparse
import hashlib
import html
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUALITY = {
    "min_accuracy": 90, "min_fluency": 70, "min_completeness": 90,
    "min_target_word_accuracy": 90, "max_fit_factor": 1.0,
}


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def phoneme(word, ipa):
    return f'<phoneme alphabet="ipa" ph="{html.escape(ipa, quote=True)}">{html.escape(word)}</phoneme>'


def wrap(body, voice, rate=0, pitch=0):
    locale = "-".join(voice.split("-")[:2])
    return (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{locale}">'
            f'<voice name="{voice}"><prosody rate="{rate:+d}%" pitch="{pitch:+d}%">'
            f'{body}</prosody></voice></speak>')


def spoken(text, lexicon):
    required, targets = [], []
    lookup = {word.casefold(): ipa for word, ipa in lexicon.items()}

    def replace(match):
        word = match.group()
        ipa = lookup.get(word.casefold())
        if ipa is None:
            return html.escape(word)
        required.append(ipa)
        targets.append(word)
        return phoneme(word, ipa)

    # Split words and XML-escape all other text separately, preserving visible punctuation.
    parts = re.split(r"([^\W\d_]+)", text, flags=re.UNICODE)
    body = "".join(replace(re.fullmatch(r"[^\W\d_]+", part)) if re.fullmatch(r"[^\W\d_]+", part)
                   else html.escape(part) for part in parts)
    return body, required, targets


def probe(voice):
    ru = voice.startswith("ru-")
    words = ["Мара", "замок", "Томан", "замок", "Элин"] if ru else ["Mara", "read", "Toman", "read", "Elin"]
    chunks = ["", " говорит: ", ". ", " повторяет: ", ". ", " слушает."] if ru else [
        "", " says: ", ". ", " repeats: ", ". ", " listens."]
    correct = ["ˈma.rə", "ˈza.mək", "ˈto.mən", "zɐ.ˈmok", "ˈɛ.lʲɪn"] if ru else [
        "ˈmɑːrə", "riːd", "ˈtəʊmən", "rɛd", "ˈɛlɪn"]
    swapped = [*correct]
    swapped[1], swapped[3] = swapped[3], swapped[1]
    sentinel = [*correct]
    sentinel[1] = "sɐ.ˈba.kə" if ru else "bəˈnɑːnə"

    def line(payload):
        return chunks[0] + "".join((html.escape(word) if payload is None else phoneme(word, payload[i]))
                                  + chunks[i + 1] for i, word in enumerate(words))
    return {
        "reference_text": html.unescape(line(None)),
        "correct_variant_id": "correct", "sentinel_variant_id": "sentinel",
        "expected_sentinel_transcript_contains": "собака" if ru else "banana",
        "target_words": words, "min_correct_word_accuracy": 95,
        "variants": [{"id": key, "ssml": wrap(line(value), voice)} for key, value in [
            ("plain", None), ("correct", correct), ("swapped", swapped), ("sentinel", sentinel)]],
    }


def prepare(inventory_path, output):
    inventory, cast, pronunciation = load(inventory_path), load(HERE / "cast.json"), load(HERE / "pronunciation.json")
    entries = inventory["entries"]
    manifests = {}
    full_manifests = {}
    for key, voice in cast["engines"].items():
        base = {
            "schema_version": "1.0", "language": "-".join(voice.split("-")[:2]), "default_voice": voice,
            "backend": {"provider": "azure-speech", "preferred_region": cast["preferred_region"]},
            "quality": QUALITY, "capability_probe": probe(voice), "segments": [],
        }
        manifests[key] = base
        full_manifests[key] = {**base, "segments": []}
    audition_index = []
    pronunciation_review = []
    for entry in entries:
        language, speaker = entry["language"], entry["speaker"]
        engine, rate, pitch = cast["profiles"][speaker][language]
        voice = cast["engines"][engine]
        role = next((a for a in cast["auditions"] if a["speaker"] == speaker and a["source"] in entry["sources"]), None)
        for segment in entry["segments"]:
            lexicon = dict(pronunciation[language])
            if language == "en" and re.search(r"\bread\b", segment["text"], re.IGNORECASE):
                past = bool(re.search(r"\b(Read the warning|He read it|Raut read a warning)\b", segment["text"]))
                lexicon["read"] = "rɛd" if past else "riːd"
            body, required, targets = spoken(segment["text"], lexicon)
            roman = re.match(r"^([IVX]+)\.", segment["text"])
            if roman:
                number = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5}[roman[1]]
                ipa = (["", "ɐ.ˈdʲin", "dva", "trʲi", "tɕɪ.ˈtɨ.rʲɪ", "pʲætʲ"] if language == "ru"
                       else ["", "wʌn", "tuː", "θriː", "fɔː", "faɪv"])[number]
                body = phoneme(roman[1], ipa) + body[len(roman[1]):]
                required.insert(0, ipa)
                targets.insert(0, roman[1])
            rendered = {**segment, "speaker": speaker, "voice": voice,
                        "ssml": wrap(body, voice, rate, pitch), "required_ipa": required,
                        "target_words": targets, "track": f"{language}-{speaker}", "critical": bool(targets)}
            full_manifests[engine]["segments"].append(rendered)
            if targets or re.search(r"\d", segment["text"]):
                pronunciation_review.append({"id": segment["id"], "language": language, "speaker": speaker,
                                             "text": segment["text"], "targets": targets, "ipa": required,
                                             "note": "Roman chapter numbers are spoken as numbers; ASR may spell them as words." if roman else ""})
            if role:
                manifests[engine]["segments"].append(rendered)
        if role:
            audition_index.append({
                "id": f"{language}-{speaker}", "title": role["label"], "language": language,
                "voice": voice, "engine": engine, "path": str((output / "playable" / f"{language}-{speaker}.wav").resolve()),
                "text": entry["text"], "note": cast["profiles"][speaker]["note"] + f" Rate {rate:+d}%; pitch {pitch:+d}%.",
                "kind": "voice", "segment_ids": [s["id"] for s in entry["segments"]],
            })
    for key in manifests:
        if not manifests[key]["segments"]:
            raise RuntimeError(f"No representative audition for engine {key}")
        save(output / "manifests" / f"audition-{key}.json", manifests[key])
        save(output / "manifests" / f"corpus-{key}.json", full_manifests[key])
    save(output / "audition-index.json", audition_index)
    save(output / "pronunciation-review.json", pronunciation_review)
    save(output / "source-lock.json", {
        "version": 1, "inventory_sha256": digest(inventory_path),
        "inventory_source_hash": inventory["sourceHash"], "cast_sha256": digest(HERE / "cast.json"),
        "pronunciation_sha256": digest(HERE / "pronunciation.json"),
        "status": "awaiting-human-cast-approval", "engine_count": len(manifests),
        "manifest_sha256": {p.name: digest(p) for p in sorted((output / "manifests").glob("*.json"))},
    })
    print(json.dumps({"engines": len(manifests), "auditions": len(audition_index),
                      "audition_segments": sum(len(m["segments"]) for m in manifests.values()),
                      "corpus_segments": sum(len(m["segments"]) for m in full_manifests.values())}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.inventory, args.output_dir.resolve())
