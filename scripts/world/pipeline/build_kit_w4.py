"""Korovany II world kit, W4b barrow: a scripted Blender 5.2 burial mound for the barrow ghouls' haunts in the Ash Steppe.

Extends the W0, W1 and W2 kits (build_kit.py, build_kit_w1.py and build_kit_w2.py, imported unchanged) with one piece:
an old long barrow at the heroic scale standard, its turf mound ringed by kerb stones, a stone-lined passage under a
lintel at its front end (a dark doorway), and the raw earth and rubble of a breach where the mound was dug open (the lore:
Raut's men opened old graves for bone ash). Same conventions: one mesh; UV0 is a world-scale planar mapping; UV1.x is
the surface layer index (+0.5) into the game's texture array and UV1.y baked ambient occlusion. Everything stays inside
the collider rectangle the v3 generator gives the piece (width along local X, the front facing +X; length along Z) and
below 3 m. The mound's turf is smooth shaded; stones keep flat faces.

    blender -b --factory-startup --python build_kit_w4.py -- --out <dir> [--samples 48]
"""
import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_kit as kit  # noqa: E402  (the W0 kit, unchanged)
import build_kit_w2 as w2  # noqa: E402  (the W2 kit, unchanged; imports the W1 kit)
from build_kit import Builder, bake_ao, bounds, export  # noqa: E402

# The game's surface array order (WORLD_SURFACES in src/view/world-assets.ts): W2's layers, then W3's.
SURFACES = w2.SURFACES + ["darkforest", "cliff", "bark-pine", "moss"]
assert SURFACES[:len(w2.SURFACES)] == w2.SURFACES
kit.LAYERS[:] = SURFACES
kit.TILE.update({"coldgrass": 4.0, "ash": 4.0, "mud": 4.0, "granite": 2.0, "moss": 2.0})

BARROW = dict(width=14.0, length=8.0, height=3.2, seed=41,
              # The mound: a superellipse plan (exponent `boxiness`) of half axes `half` round `centre` (along X), `top` high.
              centre=-0.4, half=(5.7, 3.4), top=2.95, boxiness=2.4, sides=40, rings=10,
              # The breach: dug earth on the mound's flank (plan centre, radius) and its spilled rubble.
              breach=((-2.4, -1.4), 1.7))


def superellipse(a, b, n, t):
    c, s = math.cos(t), math.sin(t)
    return (a * math.copysign(abs(c) ** (2 / n), c), b * math.copysign(abs(s) ** (2 / n), s))


def mound_height(s, top):
    """Height of the mound at normalized plan radius s (1 = the foot): steep flanks under a broad, rounded crown."""
    return top * max(0.0, 1 - min(1.0, s) ** 2) ** 0.62


def oriented_box(b, centre, along, size, height, layer, tilt=0.0, sink=0.0):
    """A stone slab standing on the ground: `size` = (length along `along`, thickness across it), leaning `tilt` radians
    outward (away from the mound) and sunk `sink` metres into the ground (the kit keeps everything at or above it)."""
    u = Vector((along[0], along[1], 0)).normalized()
    v = Vector((-u.y, u.x, 0))
    lean = v * math.sin(tilt)
    up = Vector((0, 0, 1)) * math.cos(tilt) + lean
    c = Vector((centre[0], centre[1], -sink))
    hl, ht = size[0] / 2, size[1] / 2
    base = [c + u * sx * hl + v * sy * ht for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    top = [p + up * (height + sink) for p in base]
    mid = c + up * (height + sink) / 2
    for i in range(4):
        j = (i + 1) % 4
        b.quad(tuple(base[i]), tuple(base[j]), tuple(top[j]), tuple(top[i]), layer, grain=tuple(up), centre=tuple(mid))
    b.quad(*(tuple(p) for p in top), layer, grain=tuple(u), centre=tuple(mid))


def barrow(spec):
    b = Builder()
    rng = random.Random(spec["seed"])
    cx, (a, bb), top, n = spec["centre"], spec["half"], spec["top"], spec["boxiness"]
    sides, rings = spec["sides"], spec["rings"]
    (bx, by), br = spec["breach"]
    # Rings from the foot (s = 1.05, on the ground) to near the crown, then a fan to the crown's centre.
    levels = [1.05] + [1.0 - k / rings for k in range(rings)]
    ring = []
    for s in levels:
        z = 0.0 if s > 1 else mound_height(s, top)
        ring.append([(cx + x, y, z) for x, y in (superellipse(a * s, bb * s, n, 2 * math.pi * i / sides) for i in range(sides))])
    turf = []

    def layer_at(points, k):
        mx = sum(p[0] for p in points) / len(points)
        my = sum(p[1] for p in points) / len(points)
        if math.hypot(mx - bx, my - by) < br * (0.75 + 0.25 * rng.random()):
            return "mud"
        return "ash" if k == 0 else "coldgrass"

    for k in range(len(ring) - 1):
        for i in range(sides):
            j = (i + 1) % sides
            quad = [ring[k][i], ring[k][j], ring[k + 1][j], ring[k + 1][i]]
            face = b.quad(*quad, layer_at(quad, k), outward=(quad[0][0] - cx, quad[0][1], 1.0))
            turf.append(face)
    crown = (cx, 0.0, top)
    for i in range(sides):
        j = (i + 1) % sides
        tri = [ring[-1][i], ring[-1][j], crown]
        turf.append(b.tri(*tri, layer_at(tri, len(ring)), outward=(0, 0, 1)))
    for face in turf:
        face.smooth = True
    # Kerb stones round the foot, but for the front, where the passage opens.
    for i in range(18):
        t = 2 * math.pi * (i + 0.5) / 18
        if abs(math.atan2(math.sin(t), math.cos(t))) < 0.42:
            continue
        x, y = superellipse(a * 1.07, bb * 1.07, n, t)
        x2, y2 = superellipse(a * 1.07, bb * 1.07, n, t + 0.01)
        height = rng.uniform(0.55, 1.1)
        oriented_box(b, (cx + x, y), (x2 - x, y2 - y), (rng.uniform(0.7, 1.0), rng.uniform(0.28, 0.4)), height, "granite",
                     tilt=rng.uniform(-0.05, 0.12))
    # The passage: side walls of upright slabs, capstones over them, a portal and lintel at the front, a dark doorway.
    front = cx + a  # the mound's foot on its long axis
    x0, x1 = front - 2.2, front + 0.75
    for side in (-1, 1):
        b.box((x0, side * 0.72 - 0.17, 0.0), (x1 - 0.1, side * 0.72 + 0.17, 2.25), "granite")
    for k, (c0, c1) in enumerate(((x0, x0 + 1.0), (x0 + 1.0, x0 + 2.0))):
        b.box((c0, -1.05, 2.25), (c1, 1.05, 2.25 + 0.38 + 0.06 * k), "granite")
    for side in (-1, 1):
        b.box((x1 - 0.55, side * 0.98 - 0.32, 0.0), (x1 + 0.05, side * 0.98 + 0.32, 2.45), "granite")
    b.box((x1 - 0.65, -1.45, 2.45), (x1 + 0.12, 1.45, 2.95), "granite")
    b.quad((x1 - 0.42, -0.66, 0.0), (x1 - 0.42, 0.66, 0.0), (x1 - 0.42, 0.66, 2.45), (x1 - 0.42, -0.66, 2.45), "dark", outward=(1, 0, 0))
    # Two leaning facade stones flank the entrance, and a third, fallen, lies before it.
    for side in (-1, 1):
        oriented_box(b, (x1 - 0.2, side * 2.15), (0.35, side * 1.0), (1.1, 0.42), rng.uniform(1.7, 2.1), "granite", tilt=0.12)
    oriented_box(b, (x1 + 0.35, -1.75), (0.3, 1.0), (1.4, 0.45), 0.45, "granite")
    # Rubble spilled from the breach.
    for k in range(5):
        r, t = rng.uniform(0.3, 1.2) * br, rng.uniform(0, 2 * math.pi)
        x, y = bx + math.cos(t) * r, by + math.sin(t) * r - 0.6
        s = math.hypot((x - cx) / a, y / bb)
        if s > 1.02:
            x, y = cx + (x - cx) / s, y / s
        z = max(0.0, mound_height(math.hypot((x - cx) / a, y / bb), top) - 0.1)
        size = rng.uniform(0.22, 0.42)
        b.box((x - size, y - size, z), (x + size, y + size, z + size * 1.2), "rubble")
    return b, top


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=48)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    report = {"blender": bpy.app.version_string, "build": bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash,
              "layers": SURFACES, "tileMetres": kit.TILE, "assets": {}}
    name, spec = "kit-barrow", BARROW
    builder, top = barrow(spec)
    mesh = builder.finish(name)
    # Builder.finish shades every face flat; the turf mound is smooth (its faces carry the coldgrass, ash and mud layers).
    smooth = {SURFACES.index(layer) for layer in ("coldgrass", "ash", "mud")}
    layer_uv = mesh.uv_layers["Layer"].data
    for polygon in mesh.polygons:
        polygon.use_smooth = int(layer_uv[polygon.loop_start].uv[0]) in smooth
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    bake_ao(obj, args.samples)
    path = args.out / f"{name}.glb"
    export(obj, path)
    report["assets"][name] = {"triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons), "vertices": len(obj.data.vertices),
                              "top": top, "bounds": bounds(obj), "footprint": [spec["width"], spec["length"]], "file": path.name,
                              "bytes": path.stat().st_size}
    (args.out / "kit-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({key: {k: v for k, v in a.items() if k in ("triangles", "bytes", "top", "bounds")} for key, a in report["assets"].items()}))


if __name__ == "__main__":
    main()
