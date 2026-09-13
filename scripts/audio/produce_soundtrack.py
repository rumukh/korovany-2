"""Offline acoustic sound design, lossless mastering, Vorbis delivery and QA.

Music is exclusively rendered by ACE-Step; this script never synthesizes a
replacement composition. numpy/scipy and ffmpeg/ffprobe must already be installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import scipy
from scipy import signal
from scipy.io import wavfile


ROOT = Path(__file__).resolve().parents[2]
RECIPE_PATH = Path(__file__).with_name("score-cues.json")
RECIPE = json.loads(RECIPE_PATH.read_text(encoding="utf-8"))
ARCHIVE = Path(r"C:\AI\ACE-Step-1.5\outputs") / RECIPE["production"]
DEPLOY = ROOT / "public" / "audio" / "soundtrack"
RATE = 48000
REGIONS = {
    "heartlands": "Wet pasture wind, distant small iron door bells, wooden wagon creaks.",
    "greenmarch": "Forest canopy and orchard leaves, sparse small birds, branch creaks.",
    "fens": "Reed hiss, black-water laps and drips, damp plank and ferry-rope creaks.",
    "salt-coast": "Layered brine surf, sand hiss, rigging wood and distant shore birds.",
    "ash-steppe": "Dry exposed gusts, granular ash, charcoal ticks and hollow loose slag.",
    "crownlands": "Sheltered low wind, distant bronze foundry work and army wagon wood.",
    "frostspine": "Cold mountain gusts, snow hiss, dry shelter timber and distant monastery bell.",
    "hollowvale": "Hushed fir wind, loose shutters at a stone well, sparse deep water drops; no voices.",
}
EFFECTS = {
    "attack-elf": (0.62, "Bow-limb flex, string release and narrow arrow air pass."),
    "attack-guard": (0.72, "Sword air sweep with a short steel hilt ring."),
    "attack-villain": (0.9, "Heavy cleave air displacement and rough iron scrape."),
    "hit": (0.42, "Muted layered leather/cloth body impact, no vocalization."),
    "kill": (1.12, "Equipment settles: cloth fall, wood thump and small loose iron."),
    "pickup": (0.85, "Leather pouch lift and several small coin contacts."),
    "capture": (2.8, "Three warm protective bell answers and a wooden latch."),
    "delivery": (1.65, "Two grain sacks set onto a wooden wagon deck, grain rattle."),
    "raid": (2.1, "Wagon board crack, loose wheel wood and falling cargo."),
    "convoy": (2.0, "Axle creak, two wheel bumps and leather harness jostle."),
    "repair": (1.75, "Three different hammer-on-wood strikes and tightened rope."),
    "upgrade": (2.4, "Dry plucked-string ascending figure, small bronze confirmation."),
    "ability-elf": (1.8, "Layered three-arrow volley with a flutter of dry leaves."),
    "ability-guard": (2.1, "Broad shield-plate strike and protective iron resonance."),
    "ability-villain": (1.9, "Double heavy cleave and deep leather-frame impact."),
    "fortress": (4.2, "Single heavy foundry bell with irregular bronze partials."),
    "victory": (4.5, "Restrained rising three-bell cadence with dry plucked strings."),
    "defeat": (3.6, "Low descending muted strings and a final dull wood contact."),
    "click": (0.14, "Short double wooden mechanism contact."),
    "step-dirt": (0.38, "Soft heel thump followed by granular earth and leather scuff."),
    "step-stone": (0.32, "Hard heel and toe contacts with a short stone reflection."),
    "dodge": (0.68, "Cloth rush, leather flex and a restrained earth slide."),
    "discover": (2.0, "Open resonant glass and a dry plucked questioning figure."),
    "inspect": (0.9, "Parchment unfolding, wood edge contact, quiet glass detail."),
}


def run(*args: str) -> str:
    completed = subprocess.run(args, capture_output=True, text=True, check=True)
    return completed.stdout + completed.stderr


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def save_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def rng_for(identifier: str) -> tuple[np.random.Generator, int]:
    seed = int.from_bytes(hashlib.sha256(("hollow-road-v1:" + identifier).encode()).digest()[:4], "little")
    return np.random.default_rng(seed), seed


def clock(seconds: float) -> np.ndarray:
    return np.arange(round(seconds * RATE), dtype=np.float64) / RATE


def band_noise(rng: np.random.Generator, seconds: float, low: float, high: float) -> np.ndarray:
    raw = rng.normal(size=round(seconds * RATE))
    filtered = signal.sosfilt(signal.butter(2, (low, high), "bandpass", fs=RATE, output="sos"), raw)
    return filtered / max(1e-8, float(np.sqrt(np.mean(filtered * filtered))))


def shape(x: np.ndarray, attack: float = 0.005, release: float = 0.03) -> np.ndarray:
    x = x.copy()
    a = min(len(x), round(attack * RATE))
    r = min(len(x), round(release * RATE))
    if a:
        x[:a] *= np.linspace(0, 1, a) ** 1.5
    if r:
        x[-r:] *= np.linspace(1, 0, r) ** 1.5
    return x


def modal(rng: np.random.Generator, seconds: float, frequency: float, material: str) -> np.ndarray:
    t = clock(seconds)
    materials = {
        "wood": ([1, 2.76, 5.4, 8.93], [1, .42, .22, .09], .12),
        "iron": ([1, 1.51, 2.08, 2.73, 4.11, 6.4], [1, .61, .48, .31, .22, .1], .65),
        "bell": ([.5, 1, 1.19, 1.5, 2, 2.51, 3.01, 4.17], [.35, 1, .28, .48, .36, .2, .11, .06], 1.55),
        "glass": ([1, 2.32, 4.25, 6.63, 9.48], [1, .36, .18, .1, .04], .82),
        "leather": ([1, 1.59, 2.14, 2.3, 2.65], [1, .37, .21, .14, .07], .16),
        "string": ([1, 2, 3, 4, 5, 6, 7], [1, .52, .3, .18, .1, .06, .03], .6),
    }
    ratios, levels, decay = materials[material]
    x = np.zeros(len(t))
    for index, (ratio, level) in enumerate(zip(ratios, levels)):
        f = frequency * ratio
        if f >= RATE * .45:
            continue
        bend = 1 + (.015 * np.exp(-t * 28) if material == "leather" else 0)
        phase = 2 * np.pi * f * np.cumsum(np.broadcast_to(bend, t.shape)) / RATE
        x += level * np.sin(phase + rng.uniform(-.15, .15)) * np.exp(-t * (1 + index * .26) / decay)
    excitation = band_noise(rng, seconds, 150, 7000) * np.exp(-t * 100)
    return shape(x + .11 * excitation, .001, min(.16, seconds / 3))


def sweep(rng: np.random.Generator, seconds: float, weight: float = 1) -> np.ndarray:
    t = clock(seconds)
    envelope = np.sin(np.pi * t / seconds) ** 2.4
    air = band_noise(rng, seconds, 220 / weight, 7500 / weight)
    rough = band_noise(rng, seconds, 50, 420) * .25 * weight
    return shape((air + rough) * envelope, .006, .035)


def creak(rng: np.random.Generator, seconds: float, frequency: float = 160) -> np.ndarray:
    t = clock(seconds)
    pitch = frequency * (1 + .24 * np.sin(t * 5) + .035 * np.sin(t * 61))
    phase = 2 * np.pi * np.cumsum(pitch) / RATE
    friction = sum(np.sin(phase * h) / h for h in range(1, 7))
    friction += .22 * band_noise(rng, seconds, 600, 2600)
    return shape(friction * (.55 + .45 * np.sin(t * 47) ** 2), .09, .18)


def bird(rng: np.random.Generator, seconds: float, base: float = 1900) -> np.ndarray:
    t = clock(seconds)
    phase = 2 * np.pi * np.cumsum(base * (1 + .2 * np.sin(t * 19) + .08 * t)) / RATE
    syllables = np.maximum(0, np.sin(t * 30)) ** 2
    return shape((np.sin(phase) + .2 * np.sin(phase * 2.02)) * syllables, .025, .12)


def drop(rng: np.random.Generator, seconds: float, frequency: float) -> np.ndarray:
    t = clock(seconds)
    phase = 2 * np.pi * frequency * (t + .18 * (1 - np.exp(-t * 35)) / 35)
    water = np.sin(phase) * np.exp(-t * 17)
    return shape(water + .1 * band_noise(rng, seconds, 300, 4000) * np.exp(-t * 28), .002, .05)


def add(bed: np.ndarray, event: np.ndarray, at: float, gain: float = 1, pan: float = 0) -> None:
    start = round(at * RATE)
    count = min(len(event), len(bed) - start)
    if start < 0 or count <= 0:
        raise ValueError("Sound event falls outside its authored timeline")
    if bed.ndim == 1:
        bed[start:start + count] += gain * event[:count]
    else:
        angle = (pan + 1) * np.pi / 4
        bed[start:start + count, 0] += gain * math.cos(angle) * event[:count]
        bed[start:start + count, 1] += gain * math.sin(angle) * event[:count]


def room(x: np.ndarray, wet: float, delays: tuple[float, ...] = (.037, .061, .109)) -> np.ndarray:
    result = x.copy()
    for index, seconds in enumerate(delays):
        offset = round(seconds * RATE)
        if offset < len(x):
            result[offset:] += x[:-offset] * wet / (index + 1)
    return result


def ambience(identifier: str) -> tuple[np.ndarray, int]:
    rng, seed = rng_for(identifier)
    seconds = 36
    t = clock(seconds)
    x = np.zeros((len(t), 2))
    wind = {
        "heartlands": (70, 1300, .10), "greenmarch": (160, 3400, .09),
        "fens": (110, 2000, .075), "salt-coast": (65, 2400, .13),
        "ash-steppe": (100, 3700, .12), "crownlands": (55, 950, .07),
        "frostspine": (180, 3900, .14), "hollowvale": (60, 1100, .075),
    }[identifier]
    for channel in range(2):
        gust = .57 + .21 * np.sin(t * .41 + channel * .8) + .15 * np.sin(t * .93 + 1.6)
        x[:, channel] += band_noise(rng, seconds, wind[0], wind[1]) * gust * wind[2]
    if identifier == "heartlands":
        for at, f in [(3.8, 560), (18.7, 670), (31.2, 560)]:
            add(x, modal(rng, 2.7, f, "bell"), at, .065, -.7)
        for at in [8.4, 23.1]:
            add(x, creak(rng, 1.3), at, .045, .5)
    elif identifier == "greenmarch":
        for at in [2.4, 8.7, 19.3, 27.6, 33]:
            add(x, bird(rng, .7, rng.uniform(1800, 2600)), at, .025, rng.uniform(-.9, .9))
        for at in [5.6, 15.3, 29.4]:
            add(x, sweep(rng, 2.7, .7), at, .035, rng.uniform(-.7, .7))
            add(x, creak(rng, .7, 235), at + .8, .016, .3)
    elif identifier == "fens":
        for channel in range(2):
            x[:, channel] += band_noise(rng, seconds, 110, 1100) * (.7 + .3 * np.sin(t * 2.2 + channel)) * .045
        for at in [1.3, 4.2, 9.5, 11.7, 17.6, 23.8, 30.4, 34.1]:
            add(x, drop(rng, .7, rng.uniform(420, 1050)), at, .085, rng.uniform(-.8, .8))
        add(x, creak(rng, 2.4, 110), 14.3, .03, -.4)
        add(x, modal(rng, .6, 190, "wood"), 27, .04, .6)
    elif identifier == "salt-coast":
        for channel in range(2):
            surf = (.5 + .5 * np.sin(t * .89 + channel * .3)) ** 2
            x[:, channel] += band_noise(rng, seconds, 45, 5400) * surf * .19
            x[:, channel] += band_noise(rng, seconds, 2000, 8500) * (.5 + .5 * np.sin(t * .89 - 1)) ** 4 * .033
        for at in [7.5, 25]:
            add(x, bird(rng, 1.1, 920), at, .027, .75)
        add(x, creak(rng, 1.7, 105), 16, .025, -.7)
    elif identifier == "ash-steppe":
        for at in rng.uniform(.5, 34.5, 60):
            add(x, modal(rng, .15, rng.uniform(700, 1700), "wood"), float(at), .01, rng.uniform(-1, 1))
        for at in [7, 20, 30]:
            add(x, modal(rng, 1.1, 260, "glass"), at, .018, .65)
        for at in [3, 13, 26]:
            add(x, sweep(rng, 3, .65), at, .047, -.2)
    elif identifier == "crownlands":
        for at in [3.1, 3.85, 4.6, 15.1, 15.9, 28.2, 29.1]:
            add(x, room(modal(rng, 1.3, 320 + rng.uniform(-25, 25), "iron"), .3), at, .048, -.75)
        for at in [8, 21]:
            add(x, creak(rng, 1.8, 120), at, .03, .55)
            add(x, modal(rng, .7, 110, "wood"), at + 1.1, .045, .45)
    elif identifier == "frostspine":
        for channel in range(2):
            x[:, channel] += band_noise(rng, seconds, 1800, 7000) * (.5 + .5 * np.sin(t * .53 + 2)) ** 3 * .027
        add(x, room(modal(rng, 5.5, 295, "bell"), .4, (.12, .23, .41)), 17.2, .034, -.5)
        for at in [6.6, 28.8]:
            add(x, creak(rng, .95, 270), at, .023, .7)
    else:
        for at in [4.5, 12.8, 26.3, 31.9]:
            add(x, room(modal(rng, .8, rng.uniform(110, 180), "wood"), .3), at, .049, .65)
            add(x, creak(rng, .5, 96), at + .11, .015, .65)
        for at in [8.2, 20.4, 29.2]:
            add(x, room(drop(rng, 1.3, 320), .45, (.15, .27, .44)), at, .053, -.5)
    return x.astype(np.float32), seed


def effect(identifier: str) -> tuple[np.ndarray, int]:
    rng, seed = rng_for(identifier)
    seconds = EFFECTS[identifier][0]
    x = np.zeros(round(seconds * RATE))

    def strike(at: float, f: float, material: str, gain: float = 1, decay: float = .6) -> None:
        add(x, modal(rng, min(decay, seconds - at), f, material), at, gain)

    if identifier == "attack-elf":
        add(x, creak(rng, .2, 330), 0, .14)
        strike(.13, 540, "string", .5, .27)
        add(x, sweep(rng, .36, .75), .16, .43)
    elif identifier == "attack-guard":
        add(x, sweep(rng, .42, 1), .02, .55)
        strike(.22, 1050, "iron", .15, .48)
    elif identifier == "attack-villain":
        add(x, sweep(rng, .62, 2.2), .01, .55)
        add(x, creak(rng, .35, 105), .23, .17)
        strike(.38, 195, "iron", .18, .5)
    elif identifier == "hit":
        strike(.005, 93, "leather", .8, .38)
        add(x, sweep(rng, .13, 2), .005, .38)
        strike(.035, 260, "wood", .2, .3)
    elif identifier == "kill":
        add(x, sweep(rng, .48, 2), .01, .26)
        strike(.26, 80, "leather", .5)
        strike(.44, 155, "wood", .32)
        strike(.66, 840, "iron", .11, .4)
    elif identifier == "pickup":
        add(x, creak(rng, .25, 245), .01, .13)
        for at, f in [(.16, 1600), (.24, 2050), (.36, 1720)]:
            strike(at, f, "iron", .17, .42)
    elif identifier == "capture":
        strike(.02, 240, "wood", .17)
        for at, f in [(.13, 440), (.62, 550), (1.11, 660)]:
            strike(at, f, "bell", .33, 1.68)
    elif identifier == "delivery":
        for at in [.03, .69]:
            strike(at, 75, "leather", .53, .6)
            strike(at + .045, 175, "wood", .4, .55)
            add(x, sweep(rng, .48, .9), at + .07, .11)
    elif identifier == "raid":
        for at, f, gain in [(.02, 185, .65), (.08, 360, .32), (.29, 120, .42), (.61, 220, .32), (.99, 145, .23)]:
            strike(at, f, "wood", gain)
        add(x, sweep(rng, .8, 2), .04, .25)
        add(x, creak(rng, .65, 120), .65, .16)
    elif identifier == "convoy":
        add(x, creak(rng, 1.5, 115), .02, .17)
        for at in [.2, .74, 1.21]:
            strike(at, 120, "wood", .32)
            strike(at + .05, 700, "iron", .035, .3)
    elif identifier == "repair":
        for at, f in [(.03, 310), (.47, 350), (.91, 285)]:
            strike(at, f, "wood", .6, .35)
            strike(at, f * 3.5, "iron", .08, .3)
        add(x, creak(rng, .57, 195), 1.1, .12)
    elif identifier == "upgrade":
        for at, f in [(.02, 220), (.19, 330), (.36, 440)]:
            strike(at, f, "string", .4, 1.4)
        strike(.55, 660, "bell", .24, 1.8)
    elif identifier == "ability-elf":
        for at in [.02, .23, .47]:
            strike(at, 520 + at * 160, "string", .25, .35)
            add(x, sweep(rng, .51, .65), at + .04, .36)
        add(x, sweep(rng, 1.1, .5), .58, .14)
    elif identifier == "ability-guard":
        strike(.02, 210, "iron", .62, 1.9)
        strike(.03, 102, "leather", .52, .6)
        strike(.13, 420, "bell", .24, 1.8)
    elif identifier == "ability-villain":
        for at in [.02, .45]:
            add(x, sweep(rng, .58, 2.6), at, .56)
            strike(at + .28, 70, "leather", .64, .8)
        strike(.85, 140, "iron", .19, 1)
    elif identifier == "fortress":
        strike(.02, 176, "bell", .75, 4.1)
        strike(.03, 85, "leather", .18)
        x = room(x, .3, (.073, .151, .287))
    elif identifier == "victory":
        for at, f in [(.02, 440), (.47, 550), (.92, 660)]:
            strike(at, f, "bell", .38, 3.4)
            strike(at + .1, f / 2, "string", .38, 1.7)
    elif identifier == "defeat":
        for at, f in [(.02, 196), (.5, 174.61), (1.05, 146.83)]:
            strike(at, f, "string", .48, 2)
        strike(1.72, 100, "wood", .19, .6)
    elif identifier == "click":
        strike(.003, 1050, "wood", .5, .1)
        strike(.032, 620, "wood", .25, .09)
    elif identifier == "step-dirt":
        strike(.005, 75, "leather", .45, .25)
        add(x, sweep(rng, .24, 1.4), .045, .28)
        grains = band_noise(rng, .2, 700, 6500)
        grains *= np.maximum(0, rng.normal(size=len(grains))) ** 2
        add(x, shape(grains, .025, .1), .08, .06)
    elif identifier == "step-stone":
        strike(.004, 240, "wood", .62, .23)
        strike(.087, 510, "glass", .12, .2)
        x = room(x, .15, (.025, .052))
    elif identifier == "dodge":
        add(x, sweep(rng, .44, 1.3), .01, .38)
        add(x, creak(rng, .29, 180), .03, .09)
        strike(.31, 65, "leather", .24, .32)
        add(x, sweep(rng, .28, .8), .34, .16)
    elif identifier == "discover":
        strike(.01, 740, "glass", .28, 1.9)
        strike(.22, 293.66, "string", .4, 1.6)
        strike(.48, 440, "string", .25, 1.4)
    elif identifier == "inspect":
        add(x, sweep(rng, .52, .6), .01, .2)
        strike(.14, 620, "wood", .09, .2)
        strike(.36, 1300, "glass", .065, .5)
    else:
        raise ValueError(f"Missing effect authoring: {identifier}")
    return shape(x, .002, min(.12, seconds / 3)).astype(np.float32), seed


def read_audio(path: Path, channels: int) -> np.ndarray:
    data = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ar", str(RATE), "-ac", str(channels),
         "-f", "f32le", "-"], capture_output=True, check=True,
    ).stdout
    return np.frombuffer(data, dtype="<f4").reshape(-1, channels).copy()


def loop_crossfade(x: np.ndarray, duration: float, overlap: float) -> np.ndarray:
    target = round(duration * RATE)
    fade = round(overlap * RATE)
    if len(x) < target + fade:
        raise ValueError(f"Master too short for {duration}s loop plus {overlap}s overlap: {len(x) / RATE}s")
    x = x[:target + fade]
    phase = np.linspace(0, np.pi / 2, fade)[:, None]
    blend = x[-fade:] * np.cos(phase) + x[:fade] * np.sin(phase)
    # Rotating the overlap preserves the natural sample sequence across the file boundary.
    return np.concatenate((x[fade:-fade], blend)).astype(np.float32)


def loudness(path: Path) -> dict:
    output = run("ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                 "-af", "loudnorm=I=-23:TP=-2:LRA=11:print_format=json", "-f", "null", "NUL")
    start = output.rfind("{")
    return json.loads(output[start:output.index("}", start) + 1])


def metrics(path: Path, channels: int, loop: bool) -> dict:
    probe = json.loads(run("ffprobe", "-v", "error", "-show_entries",
                           "format=duration:stream=codec_type,codec_name,sample_rate,channels",
                           "-of", "json", str(path)))
    streams = probe["streams"]
    if (len(streams) != 1 or streams[0]["codec_type"] != "audio"
            or int(streams[0]["sample_rate"]) != RATE or streams[0]["channels"] != channels):
        raise ValueError(f"Unexpected native audio format: {path}: {streams}")
    x = read_audio(path, channels)
    if len(x) == 0 or not np.all(np.isfinite(x)):
        raise ValueError(f"Empty or nonfinite audio: {path}")
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    true_peak = 0.0
    for start in range(0, len(x), RATE * 4):
        block = x[max(0, start - 32):start + RATE * 4 + 32]
        true_peak = max(true_peak, float(np.max(np.abs(signal.resample_poly(block, 4, 1, axis=0)))))
    duration = float(probe["format"]["duration"])
    decoded_duration = len(x) / RATE
    # Short Vorbis files can lose the 128-sample priming block in FFmpeg's native decoder.
    if abs(duration - decoded_duration) > 256 / RATE:
        raise ValueError(f"Decoded/container duration mismatch: {path}")
    result = {
        "duration": duration, "decoded_duration": decoded_duration,
        "sample_rate": RATE, "channels": channels, "native_codec": streams[0]["codec_name"],
        "peak_dbfs": round(20 * math.log10(max(peak, 1e-12)), 3),
        "true_peak_dbtp": round(20 * math.log10(max(true_peak, 1e-12)), 3),
        "rms_dbfs": round(20 * math.log10(max(rms, 1e-12)), 3),
        "sha256": sha256(path),
    }
    if rms < .0001 or peak > .98 or true_peak > .99:
        raise ValueError(f"Silent/clipping audio: {path}: {result}")
    if loop:
        jump = float(np.max(np.abs(x[-1] - x[0])))
        local = np.concatenate((x[-RATE // 4:], x[:RATE // 4]))
        normal_step = float(np.quantile(np.abs(np.diff(local, axis=0)), .995))
        # Codec boundary differences must be smaller than ordinary local transients.
        if jump > max(.004, 2 * normal_step):
            raise ValueError(f"Loop boundary click: {path}: jump {jump}, local {normal_step}")
        before = float(np.sqrt(np.mean(x[-RATE // 10:] ** 2)))
        after = float(np.sqrt(np.mean(x[:RATE // 10] ** 2)))
        level_change = abs(20 * math.log10(max(before, 1e-9) / max(after, 1e-9)))
        if level_change > 9:
            raise ValueError(f"Loop boundary level mismatch: {path}: {level_change:.2f}dB")
        result["seam"] = {
            "sample_jump": round(jump, 7), "local_step_p995": round(normal_step, 7),
            "rms_change_db_100ms": round(level_change, 3),
        }
    return result


def master(identifier: str, category: str, x: np.ndarray, duration: float, loop: bool, provenance: dict) -> None:
    archive = ARCHIVE / category
    archive.mkdir(parents=True, exist_ok=True)
    out = DEPLOY / category
    out.mkdir(parents=True, exist_ok=True)
    if x.ndim == 1:
        x = x[:, None]
    expected = round(duration * RATE)
    if len(x) != expected:
        raise ValueError(f"Wrong master duration: {identifier}: {len(x) / RATE}")
    highpass = signal.butter(2, 28 if category == "music" else 40, "highpass", fs=RATE, output="sos")
    # Warm the filter from the preceding loop tail instead of introducing a start transient.
    if loop:
        warm = np.concatenate((x[-RATE:], x))
        x = signal.sosfilt(highpass, warm, axis=0)[RATE:].astype(np.float32)
    else:
        x = signal.sosfilt(highpass, x, axis=0).astype(np.float32)
    x -= np.mean(x, axis=0)
    working = archive / f"{identifier}-working.wav"
    flac = archive / f"{identifier}-master.flac"
    ogg = out / f"{identifier}.ogg"
    wavfile.write(working, RATE, x)
    target, ceiling, quality = {
        "music": (-21, -2.5, 6), "ambience": (-31, -6, 4), "sfx": (-20, -3, 5),
    }[category]
    source_rms = 20 * math.log10(max(float(np.sqrt(np.mean(x.astype(np.float64) ** 2))), 1e-12))
    if category == "sfx":
        # BS.1770 gating is undefined for some sub-400ms transients; use fixed RMS/true-peak mastering.
        integrated = None
        peak = 20 * math.log10(max(float(np.max(np.abs(signal.resample_poly(x, 4, 1, axis=0)))), 1e-12))
        gain = min(-25 - source_rms, ceiling - peak)
    else:
        levels = loudness(working)
        integrated = float(levels["input_i"])
        peak = float(levels["input_tp"])
        if not math.isfinite(integrated) or not math.isfinite(peak):
            raise ValueError(f"Cannot master silent source: {identifier}")
        gain = min(target - integrated, ceiling - peak)
    run("ffmpeg", "-y", "-v", "error", "-i", str(working), "-af", f"volume={gain:.8f}dB",
        "-c:a", "flac", "-sample_fmt", "s32", str(flac))
    run("ffmpeg", "-y", "-v", "error", "-i", str(flac), "-c:a", "libvorbis", "-q:a", str(quality),
        "-metadata", f"title=Korovany II - {identifier}", "-metadata", "artist=Korovany II original production",
        str(ogg))
    lossless_metrics = metrics(flac, x.shape[1], loop)
    delivery_metrics = metrics(ogg, x.shape[1], loop)
    if abs(delivery_metrics["duration"] - duration) > .002:
        raise ValueError(f"Vorbis duration changed: {identifier}")
    row = {"id": identifier, "src": f"audio/soundtrack/{category}/{identifier}.ogg",
           "duration": duration, "loop": loop}
    record = {
        "asset": row, "category": category, "source": provenance,
        "master": {"path": str(flac), "codec": "flac", **lossless_metrics},
        "delivery": {"codec": "vorbis", "quality": quality, **delivery_metrics},
        "mastering": {"source_integrated_lufs": integrated, "source_true_peak_dbtp": peak,
                      "source_rms_dbfs": round(source_rms, 3),
                      "target_lufs": target if category != "sfx" else None,
                      "target_rms_dbfs": -25 if category == "sfx" else None,
                      "peak_ceiling_dbtp": ceiling, "static_gain_db": round(gain, 8)},
    }
    save_json(archive / f"{identifier}.json", record)
    working.unlink()
    print(f"DELIVERED {category}/{identifier}: {duration}s, {delivery_metrics['peak_dbfs']}dBFS", flush=True)


def produce_acoustic() -> None:
    for identifier, description in REGIONS.items():
        x, seed = ambience(identifier)
        raw_dir = ARCHIVE / "ambience"
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw = raw_dir / f"{identifier}-source.wav"
        wavfile.write(raw, RATE, x)
        master(identifier, "ambience", loop_crossfade(x, 32, 4), 32, True,
               {"method": "deterministic-acoustic-synthesis-v1", "description": description,
                "seed": seed, "path": str(raw), "sha256": sha256(raw), "codec": "pcm_f32le",
                "sample_rate": RATE, "channels": 2, "duration": 36, "crossfade_seconds": 4,
                "numpy": np.__version__, "scipy": scipy.__version__})
    for identifier, (duration, description) in EFFECTS.items():
        x, seed = effect(identifier)
        raw_dir = ARCHIVE / "sfx"
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw = raw_dir / f"{identifier}-source.wav"
        wavfile.write(raw, RATE, x)
        master(identifier, "sfx", x, duration, False,
               {"method": "deterministic-acoustic-synthesis-v1", "description": description,
                "seed": seed, "path": str(raw), "sha256": sha256(raw), "codec": "pcm_f32le",
                "sample_rate": RATE, "channels": 1, "numpy": np.__version__, "scipy": scipy.__version__})


def produce_music(identifiers: list[str]) -> None:
    unknown = set(identifiers) - {cue["id"] for cue in RECIPE["cues"]}
    if unknown:
        raise ValueError(f"Unknown score cues: {sorted(unknown)}")
    for cue in RECIPE["cues"]:
        if cue["id"] not in identifiers:
            continue
        name = f"{RECIPE['production']}-{cue['id']}"
        source = ARCHIVE.parent / f"{name}.flac"
        metadata_path = ARCHIVE.parent / f"{name}.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        request = metadata["request"]
        for key, expected in {
            "model": RECIPE["model"], "inference_steps": 50, "seed": cue["seed"],
            "prompt": cue["prompt"], "lyrics": "[Instrumental]", "thinking": True,
            "lm_model_path": RECIPE["planner"], "lm_backend": "vllm", "batch_size": 1,
            "audio_duration": cue["duration"] + cue["crossfade"],
        }.items():
            if request.get(key) != expected:
                raise ValueError(f"ACE provenance mismatch for {cue['id']}: {key}")
        x = read_audio(source, 2)
        source_duration = len(x) / RATE
        if cue["loop"]:
            x = loop_crossfade(x, cue["duration"], cue["crossfade"])
        else:
            if len(x) < round(cue["duration"] * RATE):
                raise ValueError(f"Incomplete ending: {cue['id']}")
            x = x[:round(cue["duration"] * RATE)]
            for channel in range(2):
                x[:, channel] = shape(x[:, channel], .015, 2.5)
        master(cue["id"], "music", x, cue["duration"], cue["loop"],
               {"method": "ACE-Step text2music", "model": request["model"], "planner": RECIPE["planner"],
                "seed": cue["seed"], "prompt": cue["prompt"], "request": request,
                "path": str(source), "sha256": sha256(source), "metadata_path": str(metadata_path),
                "metadata_sha256": sha256(metadata_path), "codec": "flac",
                "sample_rate": int(metadata["probe"]["streams"][0]["sample_rate"]),
                "channels": metadata["probe"]["streams"][0]["channels"], "duration": source_duration,
                "crossfade_seconds": cue["crossfade"], "task_id": metadata["task_id"],
                "generated_at": metadata["generated_at"], "quantization": "int8_weight_only",
                "cpu_offload": True, "dit_cpu_offload": True, "attention": "flash_attention_2",
                "generation_timeout_seconds": 5400,
                "actual_shift": metadata.get("actual_parameters", {}).get("shift", 1.0),
                "parameter_forwarding_note": (
                    "Explicit parameters verified from supported Python API output."
                    if "actual_parameters" in metadata else
                    "Legacy Gradio route ignored requested shift=3 and used default shift=1; completed composition retained."
                ),
                "planner_unloaded_before_diffusion": metadata.get("planner_unloaded_before_diffusion", False),
                "runner_sha256": metadata.get("runner_sha256"),
                "ace_revision": "ca1e85fe9430179831e6bc6be790c332190a3866"})


def manifest(validate: bool) -> None:
    identifiers = {"music": [item["id"] for item in RECIPE["cues"]], "ambience": list(REGIONS), "sfx": list(EFFECTS)}
    records = []
    result = {"version": 1}
    for category, ids in identifiers.items():
        result[category] = []
        for identifier in ids:
            record = json.loads((ARCHIVE / category / f"{identifier}.json").read_text(encoding="utf-8"))
            path = ROOT / "public" / Path(record["asset"]["src"])
            if sha256(path) != record["delivery"]["sha256"]:
                raise ValueError(f"Deployment changed since mastering: {path}")
            source = Path(record["source"]["path"])
            lossless = Path(record["master"]["path"])
            if sha256(source) != record["source"]["sha256"] or sha256(lossless) != record["master"]["sha256"]:
                raise ValueError(f"Archived source/master changed: {identifier}")
            if category == "music":
                metadata = Path(record["source"]["metadata_path"])
                if sha256(metadata) != record["source"]["metadata_sha256"]:
                    raise ValueError(f"Archived ACE metadata changed: {identifier}")
                record["source"]["runner_sha256"] = json.loads(metadata.read_text(encoding="utf-8")).get("runner_sha256")
            if validate:
                actual = metrics(path, record["delivery"]["channels"], record["asset"]["loop"])
                if abs(actual["duration"] - record["asset"]["duration"]) > .002:
                    raise ValueError(f"Duration mismatch: {path}")
                if actual["native_codec"] != "vorbis":
                    raise ValueError(f"Expected browser Vorbis delivery: {path}")
            result[category].append(record["asset"])
            records.append(record)
    save_json(DEPLOY / "manifest.json", result)
    save_json(Path(__file__).with_name("soundtrack-provenance.json"),
              {"version": 1, "production": RECIPE["production"], "master_archive": str(ARCHIVE),
               "generator_sha256": sha256(Path(__file__)), "recipe_sha256": sha256(RECIPE_PATH),
               "render_wrapper_sha256": sha256(Path(__file__).with_name("render-score.ps1")),
               "local_runner_sha256": sha256(Path(__file__).with_name("render_score_local.py")),
               "archived_helper": {"path": str(ARCHIVE / "tooling" / "generate-music.ps1"),
                                   "sha256": sha256(ARCHIVE / "tooling" / "generate-music.ps1")},
               "archived_launcher": {"path": str(ARCHIVE / "tooling" / "Start-ACE-Step.ps1"),
                                     "sha256": sha256(ARCHIVE / "tooling" / "Start-ACE-Step.ps1")},
               "archived_local_runners": [
                   {"path": str(path), "sha256": sha256(path)} for path in sorted((ARCHIVE / "tooling").glob("*.py"))
               ],
               "failed_attempts": [str(path) for path in sorted(ARCHIVE.glob("failed-*/failure.json"))],
               "ffmpeg": run("ffmpeg", "-version").splitlines()[0], "assets": records})
    print(f"MANIFEST {len(records)} assets; all originals, masters and delivery hashes retained", flush=True)


def review_samples() -> None:
    samples = []
    groups = {"music": [cue["id"] for cue in RECIPE["cues"]], "ambience": list(REGIONS), "sfx": list(EFFECTS)}
    for category, identifiers in groups.items():
        for identifier in identifiers:
            record_path = ARCHIVE / category / f"{identifier}.json"
            if not record_path.exists():
                continue
            record = json.loads(record_path.read_text(encoding="utf-8"))
            path = ROOT / "public" / Path(record["asset"]["src"])
            if sha256(path) != record["delivery"]["sha256"]:
                raise ValueError(f"Review file changed after mastering: {path}")
            description = record["source"].get("description", "Original XL-SFT acoustic folk chamber score; no voices.")
            samples.append({
                "id": f"{category}-{identifier}", "title": f"{category.title()}: {identifier.replace('-', ' ').title()}",
                "kind": "music", "path": str(path),
                "note": f"{record['asset']['duration']} seconds. {description}",
            })
    path = ARCHIVE / "review-samples.json"
    save_json(path, samples)
    print(f"REVIEW_SAMPLES={path} ({len(samples)} playable assets)", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--acoustic", action="store_true")
    parser.add_argument("--music", nargs="+", choices=[cue["id"] for cue in RECIPE["cues"]])
    parser.add_argument("--manifest", action="store_true")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--review-samples", action="store_true")
    args = parser.parse_args()
    if not any((args.acoustic, args.music, args.manifest, args.validate, args.review_samples)):
        parser.error("Choose --acoustic, --music, --manifest, --validate or --review-samples")
    if args.acoustic:
        produce_acoustic()
    if args.music:
        produce_music(args.music)
    if args.manifest or args.validate:
        manifest(args.validate)
    if args.review_samples:
        review_samples()


if __name__ == "__main__":
    main()
