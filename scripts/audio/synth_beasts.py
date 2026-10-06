"""Synthesise Korovany II's monster voices (W4: the grave wolf) from code alone: no recordings, samples or generative
models, so the sounds are the project's own. numpy and scipy shape the signals; FFmpeg masters and encodes them like
the soundtrack's effects (produce_soundtrack.py): a fixed -25 dBFS RMS level under a -3 dBTP true-peak ceiling, then
Vorbis quality 5, mono, 48 kHz.

python scripts/audio/synth_beasts.py --out public/audio/beasts --provenance scripts/audio/beasts-provenance.json

Every voice is a source-filter model: a pitch contour drives a band-limited glottal pulse train (harmonics falling off
with a spectral tilt), shaped by two vocal-tract formants, with breath noise mixed in; an amplitude envelope and a short
forest-like reverb (exponentially decaying noise) finish it. Each variant has its own fixed random seed.

  beast-wolf-howl     a long rising and falling howl (the pack has noticed the hero; distant howls as packs appear)
  beast-wolf-snarl    a rattling growl through bared teeth (the windup before a bite)
  beast-wolf-yelp     a short pained cry (a wound)
  beast-wolf-death    two falling whimpers and a last breath
"""
import argparse
import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

RATE = 48000


def contour(points, seconds):
    """Piecewise-linear [(time, value), ...] sampled at RATE for `seconds`."""
    t = np.arange(int(round(seconds * RATE))) / RATE
    times, values = zip(*points)
    return np.interp(t, times, values)


def voice(f0, tilt, rng, jitter=0.004, harmonics=40):
    """Band-limited pulse train following the pitch contour `f0` (Hz per sample): harmonic n at amplitude n^-tilt,
    with a slow random pitch jitter."""
    wobble = signal.lfilter([0.002], [1, -0.998], rng.standard_normal(len(f0))) * jitter * 30
    phase = 2 * np.pi * np.cumsum(f0 * (1 + wobble)) / RATE
    out = np.zeros(len(f0))
    for n in range(1, harmonics + 1):
        audible = (n * f0 < RATE * 0.45).astype(float)
        out += audible * np.sin(n * phase) * n ** -tilt
    return out


def formant(x, centre, width, gain=1.0):
    """A resonant band (second-order band-pass) at `centre` Hz, `width` Hz wide."""
    b, a = signal.iirpeak(centre / (RATE / 2), centre / width)
    return signal.lfilter(b, a, x) * gain


def breath(n, low, high, rng):
    sos = signal.butter(2, [low / (RATE / 2), high / (RATE / 2)], btype="band", output="sos")
    return signal.sosfilt(sos, rng.standard_normal(n))


def envelope(n, attack, release, shape=None):
    t = np.arange(n) / RATE
    seconds = n / RATE
    env = np.clip(t / max(attack, 1e-4), 0, 1) * np.clip((seconds - t) / max(release, 1e-4), 0, 1)
    env = np.sin(env * np.pi / 2) ** 2
    return env * (shape if shape is not None else 1)


def reverb(x, seconds, wet, rng):
    """Forest air: convolution with exponentially decaying, darkened noise; returns dry + wet, with the tail."""
    n = int(seconds * RATE)
    impulse = rng.standard_normal(n) * np.exp(-6.9 * np.arange(n) / n)
    impulse = signal.sosfilt(signal.butter(2, 3500 / (RATE / 2), output="sos"), impulse)
    impulse /= np.sqrt(np.sum(impulse ** 2))
    tail = signal.fftconvolve(x, impulse)
    out = np.zeros(len(tail))
    out[:len(x)] = x
    return out + tail * wet


def normal(x):
    return x / max(1e-9, float(np.max(np.abs(x))))


def howl(rng, base, length):
    """A rise from about 0.7 x base to base in the first fifth, a held vibrato and a long fall."""
    f0 = contour([(0, base * 0.72), (length * 0.2, base), (length * 0.55, base * 1.04), (length, base * 0.68)], length)
    t = np.arange(len(f0)) / RATE
    f0 *= 1 + 0.012 * np.sin(2 * np.pi * 5.2 * t) * np.clip((t - length * 0.25) / 0.4, 0, 1)
    tone = voice(f0, 1.6, rng)
    body = formant(tone, 380, 160, 1.0) + formant(tone, 900, 300, 0.45) + tone * 0.08
    air = breath(len(f0), 600, 3000, rng) * 0.05
    return reverb(normal(body + air) * envelope(len(f0), 0.18, length * 0.35), 1.1, 0.35, rng)


def snarl(rng, length):
    """A rattling growl: a low pulse train with a 30 Hz flutter, open-mouthed formants and a hiss over the teeth."""
    f0 = contour([(0, 92), (length * 0.6, 118), (length, 84)], length)
    t = np.arange(len(f0)) / RATE
    flutter = 0.55 + 0.45 * np.sign(np.sin(2 * np.pi * (28 + rng.uniform(-3, 3)) * t))
    tone = voice(f0, 0.9, rng, jitter=0.03) * flutter
    body = formant(tone, 420, 220, 1.0) + formant(tone, 1150, 400, 0.6) + formant(tone, 2500, 700, 0.25)
    hiss = breath(len(f0), 2500, 7000, rng) * 0.25 * envelope(len(f0), 0.02, 0.1)
    return reverb(normal(body + hiss) * envelope(len(f0), 0.04, 0.16), 0.5, 0.18, rng)


def yelp(rng, base, length):
    """A short pained cry: a sharp high onset falling away."""
    f0 = contour([(0, base * 1.15), (length * 0.25, base), (length, base * 0.6)], length)
    tone = voice(f0, 1.2, rng, jitter=0.01)
    body = formant(tone, 700, 260, 1.0) + formant(tone, 1700, 500, 0.5)
    air = breath(len(f0), 1000, 5000, rng) * 0.08
    return reverb(normal(body + air) * envelope(len(f0), 0.008, length * 0.55), 0.6, 0.22, rng)


def death(rng):
    """Two falling whimpers and a last breath."""
    parts = []
    for base, length in ((620, 0.34), (480, 0.42)):
        f0 = contour([(0, base), (length, base * 0.62)], length)
        tone = voice(f0, 1.4, rng, jitter=0.02)
        body = formant(tone, 520, 220) + formant(tone, 1200, 400, 0.4)
        parts.append(normal(body) * envelope(len(f0), 0.02, length * 0.6))
        parts.append(np.zeros(int(0.06 * RATE)))
    exhale = breath(int(0.55 * RATE), 300, 2200, rng)
    parts.append(normal(exhale) * 0.35 * envelope(len(exhale), 0.05, 0.4))
    return reverb(np.concatenate(parts), 0.8, 0.25, rng)


VARIANTS = [
    ("beast-wolf-howl", 7401, lambda rng: howl(rng, 470, 2.3)),
    ("beast-wolf-howl-2", 7402, lambda rng: howl(rng, 410, 2.7)),
    ("beast-wolf-snarl", 7411, lambda rng: snarl(rng, 0.55)),
    ("beast-wolf-snarl-2", 7412, lambda rng: snarl(rng, 0.62)),
    ("beast-wolf-snarl-3", 7413, lambda rng: snarl(rng, 0.5)),
    ("beast-wolf-yelp", 7421, lambda rng: yelp(rng, 880, 0.3)),
    ("beast-wolf-yelp-2", 7422, lambda rng: yelp(rng, 760, 0.36)),
    ("beast-wolf-death", 7431, death),
]


def run(*command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


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
            # Trim the reverb's silent end (below -60 dB of the peak) and fade the last 20 ms.
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
            run("ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "libvorbis", "-q:a", "5", "-ac", "1", "-ar", str(RATE),
                "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
                "-metadata", f"title=Korovany II - {identifier}", "-metadata", "artist=Korovany II original production", str(ogg))
            probe = json.loads(run("ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
                                   "-of", "json", str(ogg)))
            stream = probe["streams"][0]
            duration = round(len(x) / RATE, 3)
            rows.append({"id": identifier, "src": f"audio/beasts/{identifier}.ogg", "duration": duration, "loop": False})
            records.append({"id": identifier, "seed": seed, "sha256": sha(ogg), "bytes": ogg.stat().st_size, "duration": duration,
                            "codec": stream["codec_name"], "channels": stream["channels"], "sampleRate": int(stream["sample_rate"]),
                            "sourceRmsDbfs": round(source_rms, 3), "sourceTruePeakDbtp": round(true_peak, 3), "gainDb": round(gain, 3)})
    manifest = {"version": 1, "sfx": rows}
    (args.out / "manifest.json").write_bytes((json.dumps(manifest, indent=2) + "\n").encode())
    provenance = {
        "schema": "korovany2-beast-voices/1",
        "license": "Original procedural synthesis for Korovany II from scripts/audio/synth_beasts.py: no recordings, samples, "
                   "sound libraries or generative models; the project's own work.",
        "script": {"path": "scripts/audio/synth_beasts.py",
                   "sha256": hashlib.sha256(Path(__file__).read_text(encoding="utf-8").replace("\r\n", "\n").encode()).hexdigest()},
        "mastering": "fixed -25 dBFS RMS under a -3 dBTP true-peak ceiling (as produce_soundtrack.py masters effects); "
                     "Vorbis -q:a 5, mono, 48 kHz",
        "ffmpeg": run("ffmpeg", "-version").splitlines()[0],
        "limitations": ["Synthesised voices (a source-filter model with formants and noise), not recordings of wolves: "
                        "stylised rather than naturalistic, with no growl texture beyond a modulated pulse train."],
        "assets": records,
    }
    args.provenance.write_bytes((json.dumps(provenance, indent=2) + "\n").encode())
    for record in records:
        print(f"{record['id']}: {record['duration']} s, {record['bytes']} bytes")


if __name__ == "__main__":
    main()
