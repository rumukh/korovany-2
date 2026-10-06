"""Synthesise Korovany II's monster voices for W4b: the grave wolf's eight (exactly as synth_beasts.py makes them; that
script is imported unchanged) plus the barrow ghoul's and the bog troll's, from code alone: no recordings, samples or
generative models, so the sounds are the project's own. Same source-filter model, mastering and encoding as the wolf's.

python scripts/audio/synth_beasts_w4b.py --out public/audio/beasts --provenance scripts/audio/beasts-provenance.json

  beast-ghoul-howl    a rasping, hollow keen that rises and breaks (a pack appears; the pack turns on the hero)
  beast-ghoul-snarl   a wet, clicking hiss through bared teeth (the windup before a claw swipe)
  beast-ghoul-yelp    a short shriek (a wound)
  beast-ghoul-death   a gurgling rattle falling away
  beast-troll-howl    a low bellow from a huge chest (the troll notices the hero)
  beast-troll-snarl   a deep rumbling growl (the windup before the slam)
  beast-troll-yelp    a grunt of pain (a wound)
  beast-troll-death   a long falling groan and a last heavy breath
"""
import argparse
import hashlib
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth_beasts as wolf  # noqa: E402  (the W4a wolf voices, unchanged)
from synth_beasts import RATE, breath, contour, envelope, formant, normal, reverb, voice  # noqa: E402


def ghoul_howl(rng, base, length):
    """A rasping keen: a rise to a strained, wavering peak that breaks downward, thin formants and heavy breath noise."""
    f0 = contour([(0, base * 0.8), (length * 0.35, base * 1.08), (length * 0.6, base), (length * 0.72, base * 0.7), (length, base * 0.55)], length)
    t = np.arange(len(f0)) / RATE
    f0 *= 1 + 0.03 * np.sin(2 * np.pi * 7.5 * t)
    tone = voice(f0, 1.1, rng, jitter=0.03)
    body = formant(tone, 900, 260, 1.0) + formant(tone, 2300, 600, 0.55) + tone * 0.05
    rasp = breath(len(f0), 1800, 6500, rng) * 0.3 * (0.6 + 0.4 * np.abs(np.sin(2 * np.pi * 31 * t)))
    return reverb(normal(body + rasp) * envelope(len(f0), 0.08, length * 0.4), 0.9, 0.3, rng)


def ghoul_snarl(rng, length):
    """A wet hiss with clicking: band noise gated by irregular clicks over a weak, high voiced rattle."""
    n = int(round(length * RATE))
    t = np.arange(n) / RATE
    clicks = np.zeros(n)
    at = 0.0
    while at < length:
        index = int(at * RATE)
        clicks[index:index + int(0.004 * RATE)] = 1.0
        at += rng.uniform(0.025, 0.06)
    clicks = signal.lfilter([1.0], [1, -0.93], clicks)
    hiss = breath(n, 2200, 8000, rng) * (0.45 + 0.55 * np.clip(clicks, 0, 1))
    f0 = contour([(0, 210), (length * 0.5, 260), (length, 190)], length)
    rattle = formant(voice(f0, 1.0, rng, jitter=0.05), 1300, 400, 0.6) * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 22 * t)))
    return reverb(normal(hiss + rattle * 0.5) * envelope(n, 0.03, 0.14), 0.45, 0.16, rng)


def ghoul_yelp(rng, base, length):
    """A short shriek: a high, harsh onset that cracks and falls."""
    f0 = contour([(0, base * 1.2), (length * 0.2, base), (length, base * 0.5)], length)
    tone = voice(f0, 0.9, rng, jitter=0.04)
    body = formant(tone, 1100, 350, 1.0) + formant(tone, 2700, 700, 0.6)
    air = breath(len(f0), 2000, 7000, rng) * 0.25
    return reverb(normal(body + air) * envelope(len(f0), 0.006, length * 0.5), 0.5, 0.2, rng)


def ghoul_death(rng):
    """A gurgling rattle falling away, then a hiss of escaping breath."""
    length = 0.9
    f0 = contour([(0, 300), (length, 120)], length)
    t = np.arange(len(f0)) / RATE
    gurgle = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * (14 + 10 * (1 - t / length)) * t))
    tone = voice(f0, 1.0, rng, jitter=0.05) * gurgle
    body = formant(tone, 700, 300, 1.0) + formant(tone, 1900, 500, 0.4)
    rattle = normal(body) * envelope(len(f0), 0.03, 0.5)
    exhale = breath(int(0.5 * RATE), 1500, 6000, rng)
    return reverb(np.concatenate([rattle, normal(exhale) * 0.3 * envelope(len(exhale), 0.04, 0.4)]), 0.7, 0.22, rng)


def troll_howl(rng, base, length):
    """A low bellow: a slow swell on a deep fundamental with a strong low formant, a little roar on top."""
    f0 = contour([(0, base * 0.85), (length * 0.3, base * 1.05), (length * 0.7, base), (length, base * 0.75)], length)
    t = np.arange(len(f0)) / RATE
    tone = voice(f0, 1.3, rng, jitter=0.012, harmonics=60)
    body = formant(tone, 260, 120, 1.0) + formant(tone, 620, 220, 0.6) + formant(tone, 1300, 400, 0.18)
    roar = breath(len(f0), 300, 1800, rng) * 0.12 * (0.7 + 0.3 * np.sin(2 * np.pi * 9 * t))
    return reverb(normal(body + roar) * envelope(len(f0), 0.25, length * 0.4), 1.4, 0.4, rng)


def troll_snarl(rng, length):
    """A deep rumbling growl: a very low pulse train with a slow flutter and a dark, open formant."""
    f0 = contour([(0, 52), (length * 0.6, 64), (length, 48)], length)
    t = np.arange(len(f0)) / RATE
    flutter = 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * (17 + rng.uniform(-2, 2)) * t))
    tone = voice(f0, 0.8, rng, jitter=0.03, harmonics=70) * flutter
    body = formant(tone, 280, 140, 1.0) + formant(tone, 700, 260, 0.55) + formant(tone, 1500, 500, 0.15)
    return reverb(normal(body) * envelope(len(f0), 0.08, 0.25), 0.8, 0.25, rng)


def troll_yelp(rng, base, length):
    """A grunt of pain: a short, low, pushed burst."""
    f0 = contour([(0, base * 1.15), (length * 0.3, base), (length, base * 0.7)], length)
    tone = voice(f0, 1.0, rng, jitter=0.02, harmonics=60)
    body = formant(tone, 420, 180, 1.0) + formant(tone, 950, 320, 0.45)
    air = breath(len(f0), 400, 2500, rng) * 0.12
    return reverb(normal(body + air) * envelope(len(f0), 0.01, length * 0.5), 0.7, 0.25, rng)


def troll_death(rng):
    """A long falling groan and a last heavy breath."""
    length = 1.6
    f0 = contour([(0, 120), (length * 0.4, 100), (length, 55)], length)
    tone = voice(f0, 1.2, rng, jitter=0.03, harmonics=60)
    body = formant(tone, 330, 150, 1.0) + formant(tone, 760, 260, 0.45)
    groan = normal(body) * envelope(len(f0), 0.12, 0.8)
    exhale = breath(int(0.8 * RATE), 200, 1600, rng)
    return reverb(np.concatenate([groan, normal(exhale) * 0.4 * envelope(len(exhale), 0.08, 0.6)]), 1.2, 0.3, rng)


VARIANTS = wolf.VARIANTS + [
    ("beast-ghoul-howl", 7501, lambda rng: ghoul_howl(rng, 620, 1.6)),
    ("beast-ghoul-howl-2", 7502, lambda rng: ghoul_howl(rng, 540, 1.9)),
    ("beast-ghoul-snarl", 7511, lambda rng: ghoul_snarl(rng, 0.6)),
    ("beast-ghoul-snarl-2", 7512, lambda rng: ghoul_snarl(rng, 0.7)),
    ("beast-ghoul-yelp", 7521, lambda rng: ghoul_yelp(rng, 980, 0.32)),
    ("beast-ghoul-death", 7531, ghoul_death),
    ("beast-troll-howl", 7601, lambda rng: troll_howl(rng, 110, 2.2)),
    ("beast-troll-snarl", 7611, lambda rng: troll_snarl(rng, 0.95)),
    ("beast-troll-snarl-2", 7612, lambda rng: troll_snarl(rng, 1.1)),
    ("beast-troll-yelp", 7621, lambda rng: troll_yelp(rng, 150, 0.4)),
    ("beast-troll-death", 7631, troll_death),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows, records = [], []
    with tempfile.TemporaryDirectory() as work:
        for identifier, seed, make in VARIANTS:
            x = make(np.random.default_rng(seed)).astype(np.float64)
            # Trim the reverb's silent end (below -60 dB of the peak) and fade the last 20 ms, as synth_beasts.py does.
            loud = np.flatnonzero(np.abs(x) > np.max(np.abs(x)) * 1e-3)
            x = x[:loud[-1] + 1]
            fade = min(len(x), int(0.02 * RATE))
            x[-fade:] *= np.linspace(1, 0, fade)
            source_rms = 20 * math.log10(max(float(np.sqrt(np.mean(x ** 2))), 1e-12))
            true_peak = 20 * math.log10(max(float(np.max(np.abs(signal.resample_poly(x, 4, 1)))), 1e-12))
            gain = min(-25 - source_rms, -3 - true_peak)
            wav = Path(work) / f"{identifier}.wav"
            wavfile.write(wav, RATE, (x * 10 ** (gain / 20)).astype(np.float32))
            ogg = args.out / f"{identifier}.ogg"
            wolf.run("ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "libvorbis", "-q:a", "5", "-ac", "1", "-ar", str(RATE),
                     "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
                     "-metadata", f"title=Korovany II - {identifier}", "-metadata", "artist=Korovany II original production", str(ogg))
            probe = json.loads(wolf.run("ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
                                        "-of", "json", str(ogg)))
            stream = probe["streams"][0]
            duration = round(len(x) / RATE, 3)
            rows.append({"id": identifier, "src": f"audio/beasts/{identifier}.ogg", "duration": duration, "loop": False})
            records.append({"id": identifier, "seed": seed, "sha256": wolf.sha(ogg), "bytes": ogg.stat().st_size, "duration": duration,
                            "codec": stream["codec_name"], "channels": stream["channels"], "sampleRate": int(stream["sample_rate"]),
                            "sourceRmsDbfs": round(source_rms, 3), "sourceTruePeakDbtp": round(true_peak, 3), "gainDb": round(gain, 3)})
    manifest = {"version": 1, "sfx": rows}
    (args.out / "manifest.json").write_bytes((json.dumps(manifest, indent=2) + "\n").encode())

    def digest(path):
        return hashlib.sha256(Path(path).read_text(encoding="utf-8").replace("\r\n", "\n").encode()).hexdigest()

    provenance = {
        "schema": "korovany2-beast-voices/1",
        "license": "Original procedural synthesis for Korovany II from scripts/audio/synth_beasts_w4b.py (which imports "
                   "scripts/audio/synth_beasts.py for the wolf's voices): no recordings, samples, sound libraries or "
                   "generative models; the project's own work.",
        "script": {"path": "scripts/audio/synth_beasts_w4b.py", "sha256": digest(__file__)},
        "imports": [{"path": "scripts/audio/synth_beasts.py", "sha256": digest(wolf.__file__)}],
        "mastering": "fixed -25 dBFS RMS under a -3 dBTP true-peak ceiling (as produce_soundtrack.py masters effects); "
                     "Vorbis -q:a 5, mono, 48 kHz",
        "ffmpeg": wolf.run("ffmpeg", "-version").splitlines()[0],
        "limitations": ["Synthesised voices (a source-filter model with formants and noise), not recordings of animals: "
                        "stylised rather than naturalistic, with no growl texture beyond a modulated pulse train.",
                        "The ghoul's and troll's voices are invented creature sounds built from the same few parts (pulse "
                        "trains, formants, filtered noise, gated clicks); they are recognisable cues, not a sound designer's "
                        "layered recordings."],
        "assets": records,
    }
    args.provenance.write_bytes((json.dumps(provenance, indent=2) + "\n").encode())
    for record in records:
        print(f"{record['id']}: {record['duration']} s, {record['bytes']} bytes")


if __name__ == "__main__":
    main()
