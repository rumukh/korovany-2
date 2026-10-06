"""Korovany II W3 nature kit, part b (W3b): reed beds for the lakes, scripted in Blender 5.2 on the conventions of
build_nature_w3.py, whose helpers and plant builder it imports unchanged (only its clump dispatch learns the reeds).

    blender -b --factory-startup --python build_nature_w3b.py -- --out <dir> [--samples 24]

Writes plant-reeds.glb in the tree layout (`variant-<n>` groups holding `lod0-wood-<n>`, `lod0-leaves-<n>`, `lod1-wood-<n>`,
`lod1-leaves-<n>` and `impostor-<n>`), with a 256 px card and 128 px impostors, and nature-w3b-report.json. Variants: 0 a
tall clump of common reed with nodding plumes (about 2.6 m), 1 a medium clump (about 2 m), 2 a low, spreading tussock of
rushes (about 1.2 m). The game stands them in the shallows and along the banks of lakes, presentation only.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_nature_w3 as w3  # noqa: E402  (the W3a nature kit, unchanged; importing it rebinds build_nature's layer table)

w0 = w3.w0
TAU = math.tau


def reed_card(rng):
    """Late-autumn reeds: straw stems with long strap leaves arching away, dark brown plumes nodding on the tallest and a
    few bulrush heads, drawn upright on the unit card (x across, y up the stems)."""
    s = w3.Sketch()
    straws = [(0.22, 0.18, 0.105), (0.18, 0.145, 0.085), (0.27, 0.215, 0.13), (0.15, 0.125, 0.075)]
    leaves = [(0.19, 0.155, 0.09), (0.14, 0.12, 0.07), (0.1, 0.1, 0.06), (0.24, 0.19, 0.11)]
    plume = [(0.1, 0.065, 0.05), (0.14, 0.095, 0.07), (0.075, 0.05, 0.04)]
    bulrush = (0.085, 0.052, 0.034)
    stems = 7
    for k in range(stems):
        x0 = -0.4 + 0.8 * (k + rng.uniform(0.2, 0.8)) / stems
        top = rng.uniform(0.7, 0.98)
        lean = rng.uniform(-0.07, 0.07)
        colour = rng.choice(straws)
        points = [Vector((x0 + lean * (i / 12) ** 1.5, top * i / 12, 0)) for i in range(13)]
        for i in range(12):
            s.strip(points[i], points[i + 1], 0.024 * (1 - i / 16), 0.024 * (1 - (i + 1) / 16), colour)
        for _ in range(rng.randint(3, 5)):
            # A strap leaf from a node: out and up, then arching over and down at its tip.
            node = points[int(rng.uniform(0.1, 0.62) * 12)]
            side = rng.choice((-1, 1))
            length = rng.uniform(0.2, 0.34)
            heading = math.radians(rng.uniform(14, 30))
            p = node.copy()
            width = 0.03
            leaf = rng.choice(leaves)
            for j in range(7):
                d = Vector((side * math.sin(heading), math.cos(heading), 0))
                q = p + d * length / 7
                s.strip(p, q, width, width * 0.82, leaf)
                p, width = q, width * 0.82
                heading += math.radians(rng.uniform(9, 17))
        if top > 0.84 and rng.random() < 0.85:
            # A plume: a nodding panicle of fine spikelets hanging from the tip.
            tip = points[-1]
            bow = Vector((lean * 3 + rng.uniform(-0.05, 0.05), -0.02, 0))
            for _ in range(46):
                along = rng.uniform(0, 1)
                base = tip + bow * along - Vector((0, 0.13 * along, 0))
                d = Vector((rng.uniform(-0.7, 0.7) + bow.x * 3, rng.uniform(-0.6, 0.5), 0)).normalized()
                s.needle(base, d, rng.uniform(0.03, 0.065), 0.009, rng.choice(plume))
        elif rng.random() < 0.45:
            # A bulrush head: a dark brown club just below the tip, which runs on as a thin spike.
            at = points[10]
            s.poly([at + Vector((-0.022, -0.09, 0)), at + Vector((0.022, -0.09, 0)), at + Vector((0.022, 0.0, 0)),
                    at + Vector((0.0, 0.012, 0)), at + Vector((-0.022, 0.0, 0))], bulrush)
    return s.result()


def reed_clump(rng, variant, lod):
    """Cards standing nearly upright in a loose clump, facing every way; `lod` 1 keeps every other card, one segment each."""
    wood = w0.Wood("dark")
    cards = w0.Cards()
    count, size, width, spread, lean = [(18, 2.5, 0.24, 0.8, 0.12), (14, 1.95, 0.26, 0.65, 0.14), (14, 1.15, 0.36, 0.6, 0.24)][variant]
    offset = rng.uniform(0, TAU)
    top = 0.0
    for k in range(count):
        a = offset + k * 2.39996 + rng.uniform(-0.2, 0.2)
        r = spread * math.sqrt((k + 0.5) / count)
        root = Vector((math.cos(a) * r, math.sin(a) * r, -0.08))
        outward = Vector((math.cos(a), math.sin(a), 0))
        along = (Vector((0, 0, 1)) + outward * rng.uniform(0.02, lean)).normalized()
        face = a + rng.uniform(-1.2, 1.2) + math.pi / 2
        across = Vector((math.cos(face), math.sin(face), 0))
        s = size * rng.uniform(0.82, 1.12)
        if lod == 0 or k % 2 == 0:
            cards.card(root, along, across, s, width * s, bend=rng.uniform(0.02, 0.07), segments=3 if lod == 0 else 1,
                       shade=rng.uniform(0.75, 1.0), centre=Vector((0, 0, 0)))
        top = max(top, root.z + along.z * s)
    wood.limb([Vector((0, 0, -0.05)), Vector((0, 0, 0.12))], [0.015, 0.01], 3, cap=False)
    # The impostor frames the clump to this height: the tallest card's tip, not the nominal size.
    return wood, cards, top + 0.05


PLANTS = {
    "plant-reeds": {"variants": 3, "card": reed_card, "kind": "reeds", "thicken": 1.4},
}

_clump = w3.clump


def clump(rng, variant, kind, lod):
    return reed_clump(rng, variant, lod) if kind == "reeds" else _clump(rng, variant, kind, lod)


# build_nature_w3.build_plant draws its clumps through this module-level name.
w3.clump = clump


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--samples", type=int, default=24)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    report = {"blender": bpy.app.version_string, "layers": w3.LAYERS, "assets": {}}
    for name, spec in PLANTS.items():
        if not args.only or name in args.only:
            report["assets"][name] = w3.build_plant(name, spec, args.out, args.samples)
    (args.out / "nature-w3b-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({k: {key: v[key] for key in ("bytes", "variants") if key in v} for k, v in report["assets"].items()}))


if __name__ == "__main__":
    main()
