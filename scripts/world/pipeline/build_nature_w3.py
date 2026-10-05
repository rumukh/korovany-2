"""Korovany II W3 nature kit (W3a): dark-forest trees, crags, mossy boulders, fallen logs, stumps and undergrowth for
version 3 worlds, scripted in Blender 5.2 on the conventions of build_nature.py, whose helpers it imports unchanged (the
W0 module's layer table is rebound to the full W3 table before anything is built).

    blender -b --factory-startup --python build_nature_w3.py -- --out <dir> [--only tree-blackpine ...] [--samples 24]

Writes, with nature-w3-report.json and the card and impostor renders:

- Trees in the W0 layout (`variant-<n>` groups holding `lod0-wood-<n>`, `lod0-leaves-<n>` and `impostor-<n>`) plus a middle
  level of detail (`lod1-wood-<n>`, `lod1-leaves-<n>`): tree-blackpine (3 variants), tree-twistedoak (2), tree-deadbirch (2),
  and the W0 tree-spruce, tree-birch and tree-deadoak re-cooked from build_nature.py's own builders and seeds. Impostor
  atlases are 256 px. Black pine and twisted oak bark is the bark-pine layer turned a quarter, so its plates run along the
  limbs.
- plant-bracken (3 variants) and plant-bramble (2) in the same layout, with 256 px cards and a 128 px impostor: undergrowth
  the game scatters round trees.
- rock-crag-<moss|snow|bare>-<a..d>: twelve single-mesh crags standing on y = 0, on the cliff layer with a talus of granite
  rubble blocks round the foot that encloses the whole crag, and moss or snow on their upward faces (or bare rock).
- rock-mossy, wood-log and wood-stump (4 variants each, at most 400 triangles): granite boulders with moss on top, fallen
  black pines along local Z (glTF) with splintered ends, branch stubs and moss, and broken stumps with roots; each
  normalised to the collider the game gives it.

Every solid mesh uses the kit conventions (UV0 world-scale tiling, UV1.x the surface layer + 0.5, UV1.y baked AO); the
foliage, undergrowth and impostor cards carry their own card textures. Natural sizes: the game scales trees and the
forest floor to their obstacles; crags are fixed.
"""
import argparse
import json
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector, noise

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_nature as w0  # noqa: E402  (the W0 nature kit's helpers, unchanged)

# The game's surface table (src/view/world-assets.ts WORLD_SURFACES): W3 appends its layers after the W0-W2 ones.
LAYERS = ["daub", "timber", "thatch", "shingle", "rubble", "planks", "dark",
          "meadow", "forest", "mud", "road", "field", "granite", "bark-spruce", "bark-birch",
          "ashlar", "slate", "lime", "tarred", "brick", "reedmud", "pebbles", "ash", "snow", "cobbles", "coldgrass",
          "castle", "mossruin", "darkforest", "cliff", "bark-pine", "moss"]
TILE = {"granite": 2.0, "bark-spruce": 1.0, "bark-birch": 1.0, "bark-pine": 1.0, "cliff": 4.0,
        "snow": 4.0, "moss": 2.0, "timber": 1.0, "dark": 1.0}
w0.LAYERS = LAYERS
w0.TILE = TILE
SURFACES = w0.SURFACES
TAU = math.tau


def layer_index(name):
    return LAYERS.index(name) + 0.5


# ----------------------------------------------------------------------------------------------------------------
# Card textures
# ----------------------------------------------------------------------------------------------------------------
class Sketch:
    """Flat coloured polygons in a unit card (x -0.5..0.5, y 0..1), rendered top-down by build_nature.card_texture."""

    def __init__(self):
        self.bm = bmesh.new()
        self.colours = []

    def poly(self, points, colour):
        self.bm.faces.new([self.bm.verts.new(Vector((p.x, p.y, 0))) for p in points])
        self.colours.append(colour)

    def strip(self, a, b, width_a, width_b, colour):
        d = (b - a).normalized()
        side = Vector((-d.y, d.x, 0))
        self.poly([a - side * width_a / 2, a + side * width_a / 2, b + side * width_b / 2, b - side * width_b / 2], colour)

    def needle(self, p, d, length, width, colour):
        side = Vector((-d.y, d.x, 0)).normalized() * width / 2
        self.poly([p - side, p + side, p + d * length], colour)

    def result(self):
        return self.bm, self.colours


def pine_tuft(rng):
    """A black pine shoot: a twig with side twigs ending in brushes of long, dark paired needles round a dark core."""
    s = Sketch()
    bark = (0.03, 0.026, 0.022)
    core = (0.018, 0.032, 0.022)
    greens = [(0.026, 0.046, 0.032), (0.034, 0.058, 0.038), (0.022, 0.04, 0.028), (0.04, 0.066, 0.042)]

    def brush(centre, forward, count, reach):
        ring = [centre + forward * reach * 0.15 + Vector((math.cos(a), math.sin(a), 0)) * reach * 0.42
                for a in (TAU * k / 7 for k in range(7))]
        s.poly(ring, core)
        for _ in range(count):
            a = rng.uniform(0, TAU)
            d = (Vector((math.cos(a), math.sin(a), 0)) + forward * rng.uniform(0.3, 1.1)).normalized()
            s.needle(centre, d, reach * rng.uniform(0.75, 1.05), 0.009, rng.choice(greens))

    top = Vector((rng.uniform(-0.04, 0.04), 0.8, 0))
    s.strip(Vector((0, 0.02, 0)), top, 0.024, 0.014, bark)
    for k in range(6):
        t = 0.16 + k * 0.1
        side = 1 if k % 2 == 0 else -1
        start = Vector((0, t, 0))
        angle = math.radians(rng.uniform(32, 52))
        d = Vector((side * math.sin(angle), math.cos(angle), 0))
        length = rng.uniform(0.2, 0.3) * (1.1 - t * 0.4)
        s.strip(start, start + d * length, 0.012, 0.007, bark)
        for f in (0.5, 0.85):
            brush(start + d * length * f, d, 24, rng.uniform(0.1, 0.13))
    for y in (0.48, 0.66, 0.84):
        brush(Vector((0, y, 0)), Vector((0, 1, 0)), 28, rng.uniform(0.11, 0.14))
    return s.result()


def bracken_frond(rng):
    """A dead bracken frond: a curved stem with paired pinnae of small lobed pinnules, rust and dun browns."""
    s = Sketch()
    stem = (0.16, 0.08, 0.04)
    # Dead bracken's rust and copper: the brightest thing on a dark forest floor in late autumn.
    browns = [(0.42, 0.19, 0.07), (0.34, 0.15, 0.055), (0.5, 0.25, 0.09), (0.27, 0.12, 0.05)]
    points = [Vector((0.03 * math.sin(i / 20 * 2.0), 0.02 + 0.94 * i / 20, 0)) for i in range(21)]
    for i in range(20):
        s.strip(points[i], points[i + 1], 0.014 * (1 - i / 24), 0.014 * (1 - (i + 1) / 24), stem)
    for i in range(3, 19):
        t = i / 20
        p = points[i]
        for side in (-1, 1):
            length = 0.4 * (1 - t) ** 0.7 * rng.uniform(0.85, 1.05)
            angle = math.radians(rng.uniform(58, 74))
            d = Vector((side * math.sin(angle), math.cos(angle), 0))
            perp = Vector((-d.y, d.x, 0))
            s.strip(p, p + d * length, 0.006, 0.003, stem)
            lobes = max(3, int(length * 32))
            for k in range(lobes):
                f = (k + 0.5) / lobes
                q = p + d * length * f
                w = 0.03 * (1 - f * 0.7)
                colour = rng.choice(browns)
                for ps in (-1, 1):
                    s.poly([q - d * w * 0.5, q + d * w * 0.5, q + perp * ps * w * 1.5 + d * w * 0.7], colour)
    return s.result()


def bramble_cane(rng):
    """Arching bramble canes, dark red with pale thorns, and a few dull purple-brown three-leaflet leaves."""
    s = Sketch()
    cane = (0.2, 0.06, 0.05)
    thorn = (0.26, 0.2, 0.13)
    leaves = [(0.2, 0.08, 0.06), (0.24, 0.11, 0.06), (0.11, 0.13, 0.05), (0.16, 0.06, 0.07)]

    def leaflet(p, d, size, colour):
        side = Vector((-d.y, d.x, 0))
        mid = p + d * size * 0.5
        s.poly([p, mid + side * size * 0.3, p + d * size, mid - side * size * 0.3], colour)

    for c in range(3):
        a = Vector((rng.uniform(-0.15, 0.15), 0.02, 0))
        ctrl = Vector((rng.uniform(-0.45, 0.45), rng.uniform(0.75, 1.0), 0))
        b = Vector((rng.uniform(-0.45, 0.45), rng.uniform(0.35, 0.65), 0))
        points = [a * (1 - t) ** 2 + ctrl * 2 * t * (1 - t) + b * t * t for t in (i / 16 for i in range(17))]
        for i in range(16):
            s.strip(points[i], points[i + 1], 0.02 * (1 - i / 20), 0.02 * (1 - (i + 1) / 20), cane)
            if i % 2 == 0:
                d = (points[i + 1] - points[i]).normalized()
                side = Vector((-d.y, d.x, 0)) * (1 if i % 4 == 0 else -1)
                s.needle(points[i] + side * 0.008, (side * 0.8 + d * 0.4).normalized(), 0.02, 0.008, thorn)
            if i in (5, 10, 14):
                d = (points[i + 1] - points[i]).normalized()
                side = Vector((-d.y, d.x, 0))
                colour = rng.choice(leaves)
                for turn in (-0.9, 0.0, 0.9):
                    ld = (d + side * turn).normalized()
                    leaflet(points[i], ld, rng.uniform(0.07, 0.1), colour)
    return s.result()


# ----------------------------------------------------------------------------------------------------------------
# Trees
# ----------------------------------------------------------------------------------------------------------------
def turn_uvs(wood):
    """Turn the bark tiling a quarter: the bark-pine layer's plates run along the image's x axis."""
    for face in wood.bm.faces:
        for loop in face.loops:
            u, v = loop[wood.uv].uv
            loop[wood.uv].uv = (v, u)


class Axis:
    """A polyline trunk: points at height fractions, sampled by height."""

    def __init__(self, points):
        self.points = points

    def at(self, z):
        pts = self.points
        for a, b in zip(pts, pts[1:]):
            if b.z >= z:
                t = 0.0 if b.z == a.z else (z - a.z) / (b.z - a.z)
                return a.lerp(b, max(0.0, min(1.0, t)))
        return pts[-1].copy()


def blackpine(rng, variant, lod):
    """A tall black pine: a straight dark trunk bare of all but dead stubs below an irregular, flat-layered crown."""
    height = [24.0, 21.0, 26.5][variant]
    crown_base = height * [0.56, 0.5, 0.62][variant]
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized() * rng.uniform(0.004, 0.012)
    wood = w0.Wood("bark-pine")
    steps = 14 if lod == 0 else 7
    points, radii = [], []
    for i in range(steps + 1):
        t = i / steps
        z = height * t
        wobble = Vector((math.sin(t * 2.6 + variant * 1.7) * 0.22, math.cos(t * 2.1 + variant) * 0.18, 0)) * t
        points.append(Vector((0, 0, z)) + lean * z * z / height + wobble)
        radii.append(0.46 * (1 - t) ** 0.8 + 0.03 + (0.16 * (1 - t / 0.05) if t < 0.05 else 0))
    wood.limb(points, radii, 8 if lod == 0 else 5)
    axis = Axis(points)
    cards = w0.Cards()
    if lod == 0:
        z = 2.4
        while z < crown_base - 0.5:
            for _ in range(rng.randint(1, 2)):
                a = rng.uniform(0, TAU)
                d = Vector((math.cos(a), math.sin(a), rng.uniform(-0.55, -0.1))).normalized()
                length = rng.uniform(0.5, 1.6) * (0.5 + 0.5 * z / crown_base)
                root = axis.at(z)
                wood.limb([root, root + d * length], [0.045, 0.01], 4, cap=False)
            z += rng.uniform(0.8, 1.5)
    z = crown_base
    while z < height - 1.2:
        frac = (z - crown_base) / (height - crown_base)
        reach = (1.6 + 2.8 * math.sin(math.pi * min(1.0, 0.25 + frac * 0.85))) * rng.uniform(0.8, 1.15)
        count = rng.randint(3, 4) if lod == 0 else 3
        offset = rng.uniform(0, TAU)
        for b in range(count):
            a = offset + b * TAU / count + rng.uniform(-0.45, 0.45)
            rise = rng.uniform(0.0, 0.32) - 0.18 * (1 - frac)
            d = Vector((math.cos(a), math.sin(a), rise)).normalized()
            root = axis.at(z)
            end = root + d * reach
            if lod == 0:
                elbow = root + d * reach * 0.55 + Vector((0, 0, 0.25))
                wood.limb([root, elbow, end], [0.1 * (1.15 - frac), 0.055, 0.016], 5, cap=False)
            clumps = 3 if lod == 0 else 2
            for c in range(clumps):
                f = 0.4 + 0.6 * (c + 1) / clumps
                p = root.lerp(end, f) + Vector((0, 0, rng.uniform(0.05, 0.45)))
                size = rng.uniform(1.5, 2.2) * (1.35 if lod else 1.0)
                shade = (0.6 + 0.4 * frac) * rng.uniform(0.85, 1.0)
                ang = a + rng.uniform(-0.3, 0.3)
                out = Vector((math.cos(ang), math.sin(ang), 0))
                tangent = Vector((-math.sin(ang), math.cos(ang), 0))
                # A needle clump is a volume: one gently tilted card over two crossed upright ones.
                tilted = (out + Vector((0, 0, 0.35))).normalized()
                cards.card(p - tilted * size * 0.5, tilted, tangent, size, size * 0.85, bend=0.06, segments=2 if lod == 0 else 1,
                           shade=shade, centre=axis.at(z))
                upright = (out * 0.3 + Vector((0, 0, 1))).normalized()
                for across in ((tangent,) if lod else (tangent, out)):
                    cards.card(p - upright * size * 0.42, upright, across, size * 0.85, size * 0.8, bend=0.04, segments=1,
                               shade=shade * 0.92, centre=axis.at(z))
        z += rng.uniform(0.9, 1.5) * (1.0 if lod == 0 else 1.5)
    top = axis.at(height - 1.0)
    for k in range(3 if lod == 0 else 2):
        a = k * math.pi / (3 if lod == 0 else 2)
        cards.card(top, Vector((0, 0, 1)), Vector((math.cos(a), math.sin(a), 0)), 2.2, 1.6, segments=1, shade=1.0, centre=top)
    turn_uvs(wood)
    return wood, cards, height


def grow(wood, cards, rng, lod, start, direction, length, radius, depth, twist, leaf_size, centre, sides):
    """A gnarled limb: segments that wander by `twist`, forking until thin, with a leaf card at each tip."""
    points, radii = [start], [radius]
    d = direction.normalized()
    segments = 4 if lod == 0 else 2
    p = start.copy()
    for k in range(1, segments + 1):
        wander = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.6, 0.45))) * twist
        d = (d + wander).normalized()
        p = p + d * (length / segments)
        points.append(p.copy())
        radii.append(radius * (1 - 0.55 * k / segments))
    wood.limb(points, radii, sides if depth > 1 else max(4, sides - 2), cap=depth == 0)
    if depth == 0 or radii[-1] < 0.035:
        if leaf_size:
            for _ in range(2 if lod == 0 else 1):
                a = rng.uniform(0, TAU)
                size = leaf_size * rng.uniform(0.8, 1.2) * (1.5 if lod else 1.0)
                cards.card(points[-1] - d * size * 0.3, d, Vector((math.cos(a), math.sin(a), 0)), size, size * 0.8, segments=1,
                           shade=rng.uniform(0.7, 1.0), centre=centre)
        return
    for _ in range(rng.randint(2, 3) if lod == 0 else 2):
        f = rng.uniform(0.5, 1.0)
        k = min(len(points) - 1, max(1, round(f * (len(points) - 1))))
        fork = (d + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.35, 0.5)))).normalized()
        grow(wood, cards, rng, lod, points[k], fork, length * rng.uniform(0.5, 0.72), radii[k] * 0.62, depth - 1, twist,
             leaf_size, centre, sides)


def twistedoak(rng, variant, lod):
    """An old twisted oak: a short, thick, leaning bole on buttress roots, wide wandering limbs and a few dead leaves."""
    height = [12.0, 10.0][variant]
    wood = w0.Wood("bark-pine")
    cards = w0.Cards()
    sides = 8 if lod == 0 else 5
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized() * height * 0.06
    top = Vector((0, 0, height * 0.38)) + lean
    wood.limb([Vector((0, 0, -0.3)), Vector((0, 0, 0.7)), top * 0.55 + Vector((0, 0, 0.6)), top],
              [1.0, 0.75, 0.6, 0.5], sides + 2)
    if lod == 0:
        for k in range(5):
            a = k * TAU / 5 + rng.uniform(-0.3, 0.3)
            out = Vector((math.cos(a), math.sin(a), 0))
            wood.limb([Vector((0, 0, 0.9)) + out * 0.3, out * 1.2 + Vector((0, 0, 0.25)), out * 2.0 + Vector((0, 0, -0.25))],
                      [0.32, 0.2, 0.06], 5, cap=False)
    centre = Vector((0, 0, height * 0.65))
    for k in range(4 if lod == 0 else 3):
        a = k * TAU / (4 if lod == 0 else 3) + rng.uniform(-0.45, 0.45)
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.25, 0.8)))
        grow(wood, cards, rng, lod, top, d, height * rng.uniform(0.42, 0.55), 0.36, 3 if lod == 0 else 2, 0.6, 1.9, centre, sides)
    turn_uvs(wood)
    return wood, cards, height


def deadbirch(rng, variant, lod):
    """A dead birch: a pale, leaning trunk snapped off at the top, with a few bare, broken limbs."""
    height = [12.5, 10.5][variant]
    wood = w0.Wood("bark-birch")
    cards = w0.Cards()
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized() * rng.uniform(0.035, 0.06)
    steps = 9 if lod == 0 else 5
    points = [Vector((0, 0, height * i / steps)) + lean * (height * i / steps) ** 1.4 for i in range(steps + 1)]
    radii = [0.22 * (1 - i / steps) ** 0.6 + 0.07 + (0.07 if i == 0 else 0) for i in range(steps + 1)]
    wood.limb(points, radii, 7 if lod == 0 else 5, cap=True)
    centre = Vector((0, 0, height * 0.7))
    for k in range(6 if lod == 0 else 4):
        t = 0.35 + 0.5 * k / 6 + rng.uniform(-0.03, 0.03)
        base = points[0].lerp(points[-1], t)
        a = rng.uniform(0, TAU)
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.3, 1.0)))
        broken = rng.random() < 0.4
        length = height * rng.uniform(0.12, 0.25) * (0.5 if broken else 1.0)
        grow(wood, cards, rng, lod, base, d, length, 0.07 * (1.1 - t), 0 if broken else 1, 0.35, 1.3, centre, 5)
    return wood, cards, height


SPECIES = {
    # The W0 species, re-cooked from build_nature.py's own builders, seeds and cards with a LOD1 middle band added.
    **{name: {"variants": spec["variants"], "build": spec["build"], "card": spec["card"],
              "bark": "bark-birch" if name == "tree-birch" else "bark-spruce"} for name, spec in w0.SPECIES.items()},
    "tree-blackpine": {"variants": 3, "build": blackpine, "bark": "bark-pine", "card": pine_tuft, "thicken": 1.0},
    "tree-twistedoak": {"variants": 2, "build": twistedoak, "bark": "bark-pine",
                        "card": lambda rng: w0.leaf_cluster(rng, [(0.16, 0.09, 0.04), (0.2, 0.12, 0.05), (0.12, 0.07, 0.035),
                                                                  (0.24, 0.15, 0.06)], 3)},
    "tree-deadbirch": {"variants": 2, "build": deadbirch, "bark": "bark-birch",
                       "card": lambda rng: w0.leaf_cluster(rng, [(0.1, 0.07, 0.05)], 0, bare=True)},
}


def bark_image(name, dev):
    path = SURFACES / f"{name}-albedo.webp"
    if not path.exists():
        if not dev:
            raise FileNotFoundError(f"{path} is missing: cook the {name} surface first (or pass --dev for a stand-in render)")
        path = SURFACES / "bark-spruce-albedo.webp"
    return bpy.data.images.load(str(path), check_existing=True)


def build_species(name, spec, out, samples, dev):
    """build_nature.build_species with each species' own bark for its impostor render."""
    rng = random.Random(f"korovany2:{name}")
    card = w0.card_texture(out, name, spec["card"](rng), samples, thicken=spec.get("thicken", 1.0))
    leaf_material = w0.card_material(f"{name}-leaves", card)
    bark = bark_image(spec["bark"], dev)
    exported, report = [], {"variants": []}
    for variant in range(spec["variants"]):
        group = bpy.data.objects.new(f"variant-{variant}", None)
        w0.link(group)
        parts = {}
        vrng = random.Random(f"korovany2:{name}:{variant}")
        wood, cards, height = spec["build"](vrng, variant, 0)
        parts["lod0-wood"] = w0.mesh_object(f"lod0-wood-{variant}", wood.finish(f"lod0-wood-{variant}"), w0.kit_placeholder())
        parts["lod0-leaves"] = w0.mesh_object(f"lod0-leaves-{variant}", cards.finish(f"lod0-leaves-{variant}"), leaf_material)
        w0.bake_ao([parts["lod0-wood"], parts["lod0-leaves"]], parts["lod0-wood"], samples)
        parts["lod0-wood"].data.materials.append(w0.kit_placeholder())
        # LOD1 for the middle band: the same tree from the same seed with fewer rings, sides and cards.
        wood1, cards1, _ = spec["build"](random.Random(f"korovany2:{name}:{variant}"), variant, 1)
        parts["lod1-wood"] = w0.mesh_object(f"lod1-wood-{variant}", wood1.finish(f"lod1-wood-{variant}"), w0.kit_placeholder())
        parts["lod1-leaves"] = w0.mesh_object(f"lod1-leaves-{variant}", cards1.finish(f"lod1-leaves-{variant}"), leaf_material)
        w0.bake_ao([parts["lod1-wood"], parts["lod1-leaves"]], parts["lod1-wood"], samples)
        parts["lod1-wood"].data.materials.append(w0.kit_placeholder())
        render_wood = parts["lod0-wood"].copy()
        render_wood.data = parts["lod0-wood"].data.copy()
        render_wood.data.materials.clear()
        render_wood.data.materials.append(w0.emission_material(f"{name}-bark-albedo", image=bark))
        w0.link(render_wood)
        render_leaves = parts["lod0-leaves"].copy()
        render_leaves.data = parts["lod0-leaves"].data.copy()
        render_leaves.data.materials.clear()
        render_leaves.data.materials.append(w0.emission_material(f"{name}-leaf-albedo", image=card, use_alpha=True, vertex_shade=True))
        w0.link(render_leaves)
        # 256 px impostors (W0's were 512): they are only drawn beyond 58 m, and the world keeps within its texture memory.
        imp_mesh, imp_image = small_impostor(out, f"{name}-{variant}", [render_wood, render_leaves], height, samples, size=256)
        bpy.data.objects.remove(render_wood, do_unlink=True)
        bpy.data.objects.remove(render_leaves, do_unlink=True)
        parts["impostor"] = w0.mesh_object(f"impostor-{variant}", imp_mesh, w0.card_material(f"{name}-impostor-{variant}", imp_image))
        for obj in parts.values():
            obj.parent = group
        exported.extend([group, *parts.values()])
        report["variants"].append({"variant": variant, "height": height,
                                   "triangles": {key: w0.triangles(obj) for key, obj in parts.items()}})
    path = out / f"{name}.glb"
    w0.export(exported, path)
    report["bytes"] = path.stat().st_size
    for obj in exported:
        bpy.data.objects.remove(obj, do_unlink=True)
    return report


# ----------------------------------------------------------------------------------------------------------------
# Solid nature pieces on the kit material
# ----------------------------------------------------------------------------------------------------------------
class Solid:
    """A bmesh with the kit UV layers; faces are assigned a surface layer and projected along their main axis."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.layer_uv = self.bm.loops.layers.uv.new("Layer")
        self.layers = {}
        # Faces whose UVs were set by `tube` (turned bark); `finish_wood` leaves them alone.
        self.fixed = set()

    def face(self, verts, layer):
        f = self.bm.faces.new(verts)
        self.layers[f] = layer
        return f

    def project(self, choose=None, top_down=()):
        """Assign each face its layer (optionally re-chosen from its normal and centre) and a planar tiling UV along its
        main axis; layers in `top_down` are always projected from above, so snow, moss and scree show no seams."""
        self.bm.normal_update()
        for f in self.bm.faces:
            layer = self.layers.get(f, "cliff")
            if choose:
                layer = choose(f, layer)
            n = f.normal
            axis = 2 if layer in top_down else max(range(3), key=lambda i: abs(n[i]))
            tile = TILE[layer]
            for loop in f.loops:
                c = loop.vert.co
                u, v = [(c.y, c.z), (c.x, c.z), (c.x, c.y)][axis]
                loop[self.uv].uv = (u / tile, v / tile)
                loop[self.layer_uv].uv = (layer_index(layer), 0.0)

    def finish(self, name, smooth):
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for polygon in mesh.polygons:
            polygon.use_smooth = smooth
        return mesh


def ring_mesh(solid, rings, layer, close_top=None):
    """Quads between consecutive rings of equal length (each a list of BMVerts), all on `layer`; an optional top fan."""
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for j in range(n):
            k = (j + 1) % n
            solid.face((a[j], a[k], b[k], b[j]), layer)
    if close_top is not None:
        last = rings[-1]
        for j in range(len(last)):
            solid.face((last[j], last[(j + 1) % len(last)], close_top), layer)


# Crag shapes: half-extents of the foot (x, y), height, and the number of buttress and summit blocks round the main mass.
CRAGS = [(7.0, 6.0, 24.0, 6, 2), (11.0, 9.0, 16.0, 8, 2), (12.0, 8.5, 12.5, 9, 1), (7.5, 6.5, 30.0, 6, 3)]
CRAG_STYLES = ("moss", "snow", "bare")


def hull_block(solid, rng, centre, size, lean, layer, points=36):
    """A convex rock block: the hull of random points on an irregular ellipsoid of half-sizes `size` round `centre`,
    sheared by `lean` with height and cut flat at the ground (its underside, never seen, is dropped)."""
    bm = solid.bm
    coords = []
    for _ in range(points):
        u, a = rng.uniform(-1, 1), rng.uniform(0, TAU)
        s = math.sqrt(1 - u * u)
        r = rng.uniform(0.8, 1.0)
        q = Vector((s * math.cos(a) * size.x * r, s * math.sin(a) * size.y * r, u * size.z * r))
        q = centre + q + lean * (q.z + size.z)
        q.z = max(0.0, q.z)
        coords.append(q)
    verts = [bm.verts.new(c) for c in coords]
    hull = bmesh.ops.convex_hull(bm, input=verts)
    unused = list(dict.fromkeys(v for v in hull["geom_unused"] + hull["geom_interior"] if isinstance(v, bmesh.types.BMVert) and v.is_valid))
    if unused:
        bmesh.ops.delete(bm, geom=unused, context="VERTS")
    faces = [f for f in hull["geom"] if isinstance(f, bmesh.types.BMFace) and f.is_valid]
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    under = [f for f in faces if f.normal.z < -0.95 and all(v.co.z < 0.01 for v in f.verts)]
    if under:
        bmesh.ops.delete(bm, geom=under, context="FACES_ONLY")
    for f in faces:
        if f.is_valid:
            solid.layers[f] = layer
    return [f for f in faces if f.is_valid]


def crag(rng, variant, style):
    """A crag standing on y = 0, built like real jointed rock from overlapping convex blocks: a tall main mass, leaning
    buttresses round it, a few summit blocks for a broken crest, and a ring of low rubble blocks (the scree talus) round
    the foot (granite, its broken faces paler than the weathered cliff). Every block is a set of large flat facets with sharp
    edges; snow or moss lies on the upward ones."""
    rx, ry, height, buttresses, summits = CRAGS[variant]
    seed = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    solid = Solid()

    def lean(amount):
        return Vector((rng.uniform(-amount, amount), rng.uniform(-amount, amount), 0))

    hull_block(solid, rng, Vector((0, 0, height * 0.46)), Vector((rx * 0.72, ry * 0.72, height * 0.5)), lean(0.06), "cliff", 64)
    for k in range(buttresses):
        a = TAU * k / buttresses + rng.uniform(-0.35, 0.35)
        out = Vector((math.cos(a) * rx, math.sin(a) * ry, 0))
        tall = height * rng.uniform(0.28, 0.72)
        size = Vector((rx * rng.uniform(0.32, 0.5), ry * rng.uniform(0.32, 0.5), tall / 2))
        hull_block(solid, rng, out * rng.uniform(0.45, 0.7) + Vector((0, 0, tall * 0.48)), size, out.normalized() * rng.uniform(0.0, 0.12) + lean(0.05),
                   "cliff", 40)
    for k in range(summits):
        a = rng.uniform(0, TAU)
        tall = height * rng.uniform(0.18, 0.32)
        hull_block(solid, rng, Vector((math.cos(a) * rx * 0.25, math.sin(a) * ry * 0.25, height * rng.uniform(0.78, 0.9))),
                   Vector((rx * rng.uniform(0.18, 0.3), ry * rng.uniform(0.18, 0.3), tall / 2)), lean(0.1), "cliff", 30)
    rubble = 7 + buttresses
    for k in range(rubble):
        a = TAU * k / rubble + rng.uniform(-0.2, 0.2)
        spread = rng.uniform(0.9, 1.1)
        size = Vector((rng.uniform(1.3, 2.5), rng.uniform(1.3, 2.5), rng.uniform(0.9, 1.8)))
        hull_block(solid, rng, Vector((math.cos(a) * rx * spread, math.sin(a) * ry * spread, size.z * 0.35)), size, lean(0.03), "granite", 18)

    def choose(face, layer):
        if layer != "cliff":
            return layer
        c = face.calc_center_median()
        up = face.normal.z
        patch = noise.noise(c * 0.3 + seed) * 0.12
        if style == "snow" and up > 0.55 + patch and c.z > height * 0.25:
            return "snow"
        if style == "moss" and up > 0.6 + patch and c.z < height * 0.7:
            return "moss"
        return "cliff"

    solid.project(choose, top_down=("snow", "moss"))
    return solid


def mossy_boulder(rng, variant):
    """build_nature's boulder (displaced, flattened icosphere) with moss over its upper faces."""
    solid = Solid()
    bm = solid.bm
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    seed = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    squash = Vector((rng.uniform(0.85, 1.15), rng.uniform(0.75, 1.1), rng.uniform(0.55, 0.8)))
    for v in bm.verts:
        p = v.co.copy()
        n = noise.fractal(p * 0.9 + seed, 0.6, 2.0, 4) * 0.28 + noise.noise(p * 2.6 + seed) * 0.07
        facet = math.floor((noise.noise(p * 1.4 + seed * 2) + 1) * 2.5) / 5 * 0.12
        v.co = Vector((p.x * squash.x, p.y * squash.y, p.z * squash.z)) * (1 + n + facet)
    lowest = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= lowest
        if v.co.z < 0.18:
            v.co.z *= 0.35
    for f in bm.faces:
        solid.layers[f] = "granite"

    def choose(face, layer):
        patch = noise.noise(face.calc_center_median() * 1.6 + seed) * 0.22
        return "moss" if face.normal.z > 0.38 + patch else "granite"

    solid.project(choose)
    return solid


def tube(solid, points, radii, sides, layer, rng, jagged=(0.0, 0.0), end_layer="timber"):
    """A log, stump or root tube with bark UVs turned like the pine trunks (plates along the tube) and, where `jagged`
    gives a tooth depth, a splintered end: the end ring closes onto a recessed centre through a ring of jagged teeth."""
    bm = solid.bm
    rings = []
    along = 0.0
    frame = None
    for i, (p, r) in enumerate(zip(points, radii)):
        d = (points[min(i + 1, len(points) - 1)] - points[max(i - 1, 0)]).normalized()
        if i:
            along += (p - points[i - 1]).length
        side = d.cross(Vector((0, 0, 1))) if frame is None else frame - d * frame.dot(d)
        if side.length < 1e-4:
            side = d.cross(Vector((1, 0, 0)))
        side.normalize()
        frame = side
        up = d.cross(side).normalized()
        ring = [bm.verts.new(p + (side * math.cos(TAU * s / sides) + up * math.sin(TAU * s / sides)) * r) for s in range(sides)]
        rings.append((ring, along, r, p, d))
    circumference = TAU * max(radii)
    for (a, va, _, _, _), (b, vb, _, _, _) in zip(rings, rings[1:]):
        for s in range(sides):
            t = (s + 1) % sides
            f = solid.face((a[s], a[t], b[t], b[s]), layer)
            solid.fixed.add(f)
            uv_a, uv_b = s / sides, (s + 1) / sides
            for loop, (u, v) in zip(f.loops, ((uv_a, va), (uv_b, va), (uv_b, vb), (uv_a, vb))):
                loop[solid.uv].uv = (v / TILE[layer], u * circumference / TILE[layer])
    for (ring, _, r, p, d), sign, depth in ((rings[0], -1, jagged[0]), (rings[-1], 1, jagged[1])):
        if depth <= 0:
            continue
        teeth = [bm.verts.new(v.co + d * sign * depth * rng.uniform(-0.4, 1.0) - (v.co - p) * 0.25) for v in ring]
        centre = bm.verts.new(p - d * sign * depth * 0.3)
        n = len(ring)
        for s in range(n):
            t = (s + 1) % n
            solid.face((ring[s], ring[t], teeth[t], teeth[s]) if sign > 0 else (ring[t], ring[s], teeth[s], teeth[t]), end_layer)
            solid.face((teeth[s], teeth[t], centre) if sign > 0 else (teeth[t], teeth[s], centre), end_layer)


def finish_wood(solid, seed, moss=True):
    """Layers and UVs of a log or stump: bark faces facing up turn to moss (planar UV), splintered ends keep their wood
    layer (planar UV); tube faces keep their turned bark UVs."""
    solid.bm.normal_update()
    for f in solid.bm.faces:
        layer = solid.layers[f]
        patch = noise.noise(f.calc_center_median() * 0.9 + seed) * 0.2
        if moss and layer == "bark-pine" and f.normal.z > 0.55 + patch:
            layer = "moss"
        if f not in solid.fixed or layer != solid.layers[f]:
            n = f.normal
            axis = max(range(3), key=lambda k: abs(n[k]))
            for loop in f.loops:
                c = loop.vert.co
                u, v = [(c.y, c.z), (c.x, c.z), (c.x, c.y)][axis]
                loop[solid.uv].uv = (u / TILE[layer], v / TILE[layer])
        for loop in f.loops:
            loop[solid.layer_uv].uv = (layer_index(layer), 0.0)


# Fallen logs: length, radius and sideways bow; they lie along Blender Y, which is glTF (local) Z.
LOGS = [(9.0, 0.42, 0.3), (7.5, 0.36, -0.25), (10.5, 0.48, 0.12), (8.2, 0.4, -0.1)]
LOG_LENGTH = 9.0


def fallen_log(rng, variant):
    """A fallen black pine, bowed and sagging, with splintered ends, upward branch stubs and moss along its top."""
    length, radius, bow = LOGS[variant]
    solid = Solid()
    steps = 12
    points, radii = [], []
    for i in range(steps + 1):
        t = i / steps
        points.append(Vector((bow * math.sin(math.pi * t), -length / 2 + length * t, radius * 0.8 - 0.07 * math.sin(math.pi * t))))
        radii.append(radius * (1.0 - 0.28 * t))
    tube(solid, points, radii, 8, "bark-pine", rng, jagged=(radius * 0.7, radius * 0.9))
    for _ in range(rng.randint(3, 4)):
        i = int(rng.uniform(0.15, 0.85) * steps)
        p = points[i]
        lean = rng.uniform(math.radians(35), math.radians(85)) * rng.choice((-1, 1))
        d = Vector((math.cos(lean) * math.copysign(1, lean), rng.uniform(-0.3, 0.3), abs(math.sin(lean)))).normalized()
        r = radii[i] * rng.uniform(0.18, 0.26)
        tube(solid, [p, p + d * rng.uniform(0.5, 1.2)], [r, r * 0.45], 5, "bark-pine", rng, jagged=(0, r * 1.5))
    finish_wood(solid, Vector((rng.uniform(0, 100), rng.uniform(0, 100), 0)))
    return solid


# Stumps: trunk radius and height; roots reach about twice the radius.
STUMPS = [(0.55, 0.95), (0.45, 0.6), (0.62, 1.35), (0.5, 0.8)]


def stump(rng, variant):
    """A broken stump: a short flaring trunk with splintered teeth on top and roots running into the ground."""
    radius, height = STUMPS[variant]
    solid = Solid()
    points = [Vector((0, 0, -0.3)), Vector((0, 0, 0.15)), Vector((0, 0, height * 0.6)), Vector((0, 0, height))]
    tube(solid, points, [radius * 1.45, radius * 1.15, radius * 1.0, radius * 0.95], 10, "bark-pine", rng, jagged=(0, height * 0.35))
    for k in range(5):
        a = k * TAU / 5 + rng.uniform(-0.3, 0.3)
        out = Vector((math.cos(a), math.sin(a), 0))
        tube(solid, [out * radius * 0.7 + Vector((0, 0, 0.3)), out * radius * 1.5 + Vector((0, 0, 0.05)), out * radius * 2.0 + Vector((0, 0, -0.3))],
             [radius * 0.3, radius * 0.2, radius * 0.08], 5, "bark-pine", rng)
    finish_wood(solid, Vector((rng.uniform(0, 100), rng.uniform(0, 100), 0)), moss=False)
    return solid


def normalise(solid, size, along_y=False):
    """Scale a piece uniformly so its low part (below 1.2 m, glTF y) reaches `size` metres from its axis: the radius of a
    round piece, or half the length of a log (along Blender Y)."""
    verts = solid.bm.verts
    if along_y:
        reach = max(abs(v.co.y) for v in verts)
    else:
        reach = max(math.hypot(v.co.x, v.co.y) for v in verts if v.co.z < 1.2)
    k = size / reach
    for v in verts:
        v.co *= k
    return k


# Rock-kind pieces (four variants each), normalised to the collider the generator gives them.
NATURE = {
    "rock-mossy": {"build": mossy_boulder, "size": 1.3},
    "wood-log": {"build": fallen_log, "size": LOG_LENGTH / 2, "along_y": True},
    "wood-stump": {"build": stump, "size": 1.0},
}


def nature_model(name, spec, out, samples):
    """Export `variant-<n>` meshes on the kit placeholder material with baked AO, each normalised to the spec size."""
    exported, report = [], {"variants": []}
    for variant in range(4):
        solid = spec["build"](random.Random(f"korovany2:{name}:{variant}"), variant)
        normalise(solid, spec["size"], spec.get("along_y", False))
        obj = w0.mesh_object(f"variant-{variant}", solid.finish(f"variant-{variant}", True), w0.kit_placeholder())
        w0.bake_ao([obj], obj, samples)
        obj.data.materials.append(w0.kit_placeholder())
        exported.append(obj)
        report["variants"].append({"variant": variant, "triangles": w0.triangles(obj), "size": [round(d, 3) for d in obj.dimensions]})
    path = out / f"{name}.glb"
    w0.export(exported, path)
    report["bytes"] = path.stat().st_size
    for obj in exported:
        bpy.data.objects.remove(obj, do_unlink=True)
    return report


def crag_model(style, shape, out, samples):
    """One crag as a single kit mesh (rock-crag-<style>-<a..d>), flat-shaded, with baked AO."""
    name = f"rock-crag-{style}-{'abcd'[shape]}"
    solid = crag(random.Random(f"korovany2:{name}"), shape, style)
    obj = w0.mesh_object(name, solid.finish(name, False), w0.kit_placeholder())
    w0.bake_ao([obj], obj, samples)
    obj.data.materials.append(w0.kit_placeholder())
    path = out / f"{name}.glb"
    w0.export([obj], path)
    mesh = obj.data
    report = {"triangles": w0.triangles(obj), "size": [round(d, 3) for d in obj.dimensions], "bytes": path.stat().st_size,
              "radius": round(max(math.hypot(v.co.x, v.co.y) for v in mesh.vertices if v.co.z < 3.0), 3),
              "radiusAbove": round(max((math.hypot(v.co.x, v.co.y) for v in mesh.vertices if v.co.z >= 3.0), default=0.0), 3),
              "height": round(max(v.co.z for v in mesh.vertices), 3), "lowest": round(min(v.co.z for v in mesh.vertices), 4)}
    bpy.data.objects.remove(obj, do_unlink=True)
    return name, report


# ----------------------------------------------------------------------------------------------------------------
# Undergrowth: bracken clumps and bramble thickets, drawn like small trees (stems, cards and a small impostor)
# ----------------------------------------------------------------------------------------------------------------
def small_impostor(out, name, objects, height, samples, size=128):
    """build_nature.impostor at `size` pixels: two crossed side cards and a top card on one small atlas."""
    import numpy as np
    span = max(max(abs(v.co.x), abs(v.co.y)) for obj in objects for v in obj.data.vertices) * 2 + 0.2
    scale = max(height + 0.2, span * 2)
    camera = w0.ortho_camera((0, -60, scale / 2 - 0.1), (math.radians(90), 0, 0), scale)
    side = w0.render_to(out / f"impostor-{name}-side.png", objects, camera, size // 2, size, samples)
    bpy.data.objects.remove(camera, do_unlink=True)
    camera = w0.ortho_camera((0, 0, height + 40), (0, 0, 0), span)
    top = w0.render_to(out / f"impostor-{name}-top.png", objects, camera, size // 2, size // 2, samples)
    bpy.data.objects.remove(camera, do_unlink=True)
    atlas = np.zeros((size, size, 4), dtype=np.float32)
    atlas[:, :size // 2] = np.array(side.pixels[:], dtype=np.float32).reshape(size, size // 2, 4)
    atlas[size // 2:, size // 2:] = np.array(top.pixels[:], dtype=np.float32).reshape(size // 2, size // 2, 4)
    image = bpy.data.images.new(f"impostor-{name}", size, size, alpha=True)
    image.colorspace_settings.name = "sRGB"
    image.pixels = atlas.ravel()
    w0.finish_card(image, 0.8)
    image.filepath_raw = str(out / f"impostor-{name}.png")
    image.file_format = "PNG"
    image.save()
    cards = w0.Cards()
    w = scale / 2
    for a in (0.0, math.pi / 2):
        cards.card(Vector((0, 0, -0.1)), Vector((0, 0, 1)), Vector((math.cos(a), math.sin(a), 0)), scale, w, segments=1, shade=1.0,
                   centre=Vector((0, 0, height * 0.6)), u0=0.0, u1=0.5)
    cards.card(Vector((0, -span / 2, height * 0.55)), Vector((0, 1, 0)), Vector((1, 0, 0)), span, span, segments=1, shade=1.0,
               centre=Vector((0, 0, height * 0.3)), u0=0.5, u1=1.0, v0=0.5, v1=1.0)
    return cards.finish(f"impostor-{name}"), image


def clump(rng, variant, kind, lod):
    """Bracken: a ring of fronds (variants 0-2 large to small); bramble: arching canes over a low dome (variants 0-1).
    Each frond or cane is a card on a short stem; `lod` 1 keeps every other card."""
    wood = w0.Wood("dark")
    cards = w0.Cards()
    centre = Vector((0, 0, 0))
    if kind == "bracken":
        count, size, width, bend, rise, spread = [(13, 1.35, 0.7, 0.22, 1.5, 0.7), (10, 1.15, 0.7, 0.22, 1.5, 0.7), (7, 0.95, 0.7, 0.2, 1.4, 0.7)][variant]
    else:
        count, size, width, bend, rise, spread = [(11, 1.6, 1.0, 0.3, 1.2, 0.8), (9, 1.35, 1.0, 0.28, 1.3, 0.75)][variant]
    offset = rng.uniform(0, TAU)
    for k in range(count):
        a = offset + k * TAU / count + rng.uniform(-0.3, 0.3)
        d = Vector((math.cos(a) * spread, math.sin(a) * spread, rise)).normalized()
        across = Vector((-math.sin(a), math.cos(a), 0))
        root = Vector((math.cos(a) * 0.1, math.sin(a) * 0.1, -0.05))
        s = size * rng.uniform(0.85, 1.15)
        if lod == 0 or k % 2 == 0:
            cards.card(root, d, across, s, width * s, bend=bend, segments=3 if lod == 0 else 1, shade=rng.uniform(0.7, 1.0), centre=centre)
        if lod == 0 and k % 3 == 0:
            wood.limb([root, root + d * s * 0.25], [0.012, 0.008], 3, cap=False)
    if not wood.bm.faces:
        wood.limb([Vector((0, 0, -0.05)), Vector((0, 0, 0.15))], [0.012, 0.008], 3, cap=False)
    return wood, cards, size * 0.95


PLANTS = {
    "plant-bracken": {"variants": 3, "card": bracken_frond, "kind": "bracken", "thicken": 1.5},
    "plant-bramble": {"variants": 2, "card": bramble_cane, "kind": "bramble", "thicken": 1.6},
}


def build_plant(name, spec, out, samples):
    """A tree-layout file for undergrowth: lod0 (stems and cards), lod1 (half the cards) and a 128 px impostor."""
    rng = random.Random(f"korovany2:{name}")
    card = w0.card_texture(out, name, spec["card"](rng), samples, size=256, thicken=spec["thicken"])
    material = w0.card_material(f"{name}-leaves", card)
    exported, report = [], {"variants": []}
    for variant in range(spec["variants"]):
        group = bpy.data.objects.new(f"variant-{variant}", None)
        w0.link(group)
        parts = {}
        for lod in (0, 1):
            wood, cards, height = clump(random.Random(f"korovany2:{name}:{variant}"), variant, spec["kind"], lod)
            parts[f"lod{lod}-wood"] = w0.mesh_object(f"lod{lod}-wood-{variant}", wood.finish(f"lod{lod}-wood-{variant}"), w0.kit_placeholder())
            parts[f"lod{lod}-leaves"] = w0.mesh_object(f"lod{lod}-leaves-{variant}", cards.finish(f"lod{lod}-leaves-{variant}"), material)
            w0.bake_ao([parts[f"lod{lod}-wood"], parts[f"lod{lod}-leaves"]], parts[f"lod{lod}-wood"], samples)
            parts[f"lod{lod}-wood"].data.materials.append(w0.kit_placeholder())
        render = parts["lod0-leaves"].copy()
        render.data = parts["lod0-leaves"].data.copy()
        render.data.materials.clear()
        render.data.materials.append(w0.emission_material(f"{name}-leaf-albedo", image=card, use_alpha=True, vertex_shade=True))
        w0.link(render)
        imp_mesh, imp_image = small_impostor(out, f"{name}-{variant}", [render], height, samples)
        bpy.data.objects.remove(render, do_unlink=True)
        parts["impostor"] = w0.mesh_object(f"impostor-{variant}", imp_mesh, w0.card_material(f"{name}-impostor-{variant}", imp_image))
        for obj in parts.values():
            obj.parent = group
        exported.extend([group, *parts.values()])
        report["variants"].append({"variant": variant, "height": height, "triangles": {key: w0.triangles(obj) for key, obj in parts.items()}})
    path = out / f"{name}.glb"
    w0.export(exported, path)
    report["bytes"] = path.stat().st_size
    for obj in exported:
        bpy.data.objects.remove(obj, do_unlink=True)
    return report


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--samples", type=int, default=24)
    parser.add_argument("--dev", action="store_true", help="render impostors with a stand-in bark if a W3 surface is missing")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    report = {"blender": bpy.app.version_string, "layers": LAYERS, "assets": {}}
    wanted = lambda name: not args.only or name in args.only or any(name.startswith(prefix) for prefix in args.only)  # noqa: E731
    for name, spec in SPECIES.items():
        if wanted(name):
            report["assets"][name] = build_species(name, spec, args.out, args.samples, args.dev)
    for style in CRAG_STYLES:
        for shape in range(4):
            if wanted(f"rock-crag-{style}-{'abcd'[shape]}"):
                name, crag_report = crag_model(style, shape, args.out, args.samples)
                report["assets"][name] = crag_report
    for name, spec in NATURE.items():
        if wanted(name):
            report["assets"][name] = nature_model(name, spec, args.out, args.samples)
    for name, spec in PLANTS.items():
        if wanted(name):
            report["assets"][name] = build_plant(name, spec, args.out, args.samples)
    (args.out / "nature-w3-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({k: {key: v[key] for key in ("bytes", "variants", "triangles", "size", "radius", "radiusAbove", "height", "lowest") if key in v}
                      for k, v in report["assets"].items()}))


if __name__ == "__main__":
    main()
