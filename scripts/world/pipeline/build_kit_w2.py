"""Korovany II world kit, W2 castles and ruins: scripted Blender 5.2 fortifications at the heroic scale standard.

Extends the W0 and W1 kits (build_kit.py and build_kit_w1.py, imported unchanged) with a castle curtain module and its
ruined variant, round, square and ruined towers, a keep, a gate arch over a road, a roofless ruined chapel and house,
and a timber camp tower for the military posts. Same conventions: one mesh per asset; UV0 is a world-scale planar
mapping; UV1.x is the surface layer index (+0.5) into the game's texture array and UV1.y baked ambient occlusion. Walls
and everything below 3 m stay inside the collider the v3 generator gives the piece (a rectangle, width along local X
and length along Z, or for round pieces the inscribed circle); only parts above 3 m overhang it, by at most 0.8 m.
The gate arch is presentation only (it spans a road between two towers and never collides).

    blender -b --factory-startup --python build_kit_w2.py -- --out <dir> [--only kit-keep ...] [--samples 48]
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
import build_kit_w1 as w1  # noqa: E402  (the W1 kit, unchanged)
from build_kit import UP, Builder, bake_ao, bounds, export  # noqa: E402

# The game's surface array order (WORLD_SURFACES in src/view/world-assets.ts): W0's fifteen layers, W1's eleven, then W2's.
SURFACES = w1.SURFACES + ["reedmud", "pebbles", "ash", "snow", "cobbles", "coldgrass", "castle", "mossruin"]
assert SURFACES[:len(w1.SURFACES)] == w1.SURFACES
kit.LAYERS[:] = SURFACES
kit.TILE.update({"castle": 3.0, "mossruin": 2.0})
keep_faces, sorted_box = w1.keep, w1.sorted_box


def polar(r, a, z):
    return (r * math.sin(a), r * math.cos(a), z)


def ring_faces(b, r0, z0, r1, z1, sides, layer, inward=False, phase=0.5, arc=None):
    """A many-sided frustum's side faces (outward, or inward for the inside of a hollow piece); `arc` limits it to a
    list of segment indices."""
    for i in arc if arc is not None else range(sides):
        a0, a1 = 2 * math.pi * (i + phase - 0.5) / sides, 2 * math.pi * (i + phase + 0.5) / sides
        p = [polar(r0, a0, z0), polar(r0, a1, z0), polar(r1, a1, z1), polar(r1, a0, z1)]
        mid = (a0 + a1) / 2
        out = (math.sin(mid), math.cos(mid), 0)
        b.quad(*p, layer, grain=UP, outward=tuple(-c for c in out) if inward else out)


def annulus(b, r_in, r_out, z, sides, layer, down=False):
    """A flat ring (r_in may be 0 for a disc) facing up, or down for a corbel's underside."""
    for i in range(sides):
        a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
        if r_in < 1e-6:
            b.tri(polar(r_out, a0, z), polar(r_out, a1, z), (0, 0, z), layer, grain=(0, 1, 0), outward=(0, 0, -1 if down else 1))
        else:
            b.quad(polar(r_in, a0, z), polar(r_out, a0, z), polar(r_out, a1, z), polar(r_in, a1, z), layer, grain=(0, 1, 0),
                   outward=(0, 0, -1 if down else 1))


def cone(b, r, z0, apex, sides, layer, phase=0.5):
    for i in range(sides):
        a0, a1 = 2 * math.pi * (i + phase - 0.5) / sides, 2 * math.pi * (i + phase + 0.5) / sides
        mid = (a0 + a1) / 2
        b.tri(polar(r, a0, z0), polar(r, a1, z0), (0, 0, apex), layer, grain=UP,
              outward=(math.sin(mid), math.cos(mid), 0.4))


def ring_merlons(b, r_in, r_out, z0, z1, count, layer, fill=0.55):
    """Merlons round a circular parapet: each a curved block covering `fill` of its share of the circle."""
    for i in range(count):
        c = 2 * math.pi * (i + 0.5) / count
        half = math.pi / count * fill
        a0, a1 = c - half, c + half
        centre = polar((r_in + r_out) / 2, c, (z0 + z1) / 2)
        pts = lambda r, z: [polar(r, a0, z), polar(r, a1, z)]
        o0, o1 = pts(r_out, z0)
        o3, o2 = pts(r_out, z1)[0], pts(r_out, z1)[1]
        i0, i1 = pts(r_in, z0)
        i3, i2 = pts(r_in, z1)[0], pts(r_in, z1)[1]
        b.quad(o0, o1, o2, o3, layer, grain=UP, centre=centre)
        b.quad(i0, i1, i2, i3, layer, grain=UP, centre=centre)
        b.quad(o0, i0, i3, o3, layer, grain=UP, centre=centre)
        b.quad(o1, i1, i2, o2, layer, grain=UP, centre=centre)
        b.quad(o3, o2, i2, i3, layer, grain=(0, 1, 0), centre=centre)


def merlon_row(b, axis, coord_in, coord_out, a0, a1, z0, z1, layer, step=1.75, width=0.95):
    """Merlons standing on a straight parapet between coord_in and coord_out (across the wall), from a0 to a1 along it."""
    count = max(1, round((a1 - a0) / step))
    pitch = (a1 - a0) / count
    lo, hi = min(coord_in, coord_out), max(coord_in, coord_out)
    for i in range(count):
        c = a0 + (i + 0.5) * pitch
        if axis == "y":  # the parapet runs along Y
            b.box((lo, c - width / 2, z0), (hi, c + width / 2, z1), layer, skip=("-z",))
        else:
            b.box((c - width / 2, lo, z0), (c + width / 2, hi, z1), layer, skip=("-z",))


def slit(b, axis, coord, side, u, z0, z1, width=0.22):
    """A dark arrow slit flush on a wall face (0.01 proud so it never z-fights)."""
    p = lambda uu, zz: w1.wall_point(axis, coord, side, uu, zz, -0.012)
    out = (side, 0, 0) if axis == "x" else (0, side, 0)
    b.quad(p(u - width / 2, z0), p(u + width / 2, z0), p(u + width / 2, z1), p(u - width / 2, z1), "dark", grain=UP, outward=out)


def parapet_square(b, h, z, height, merlon, layer="castle", thick=0.6):
    """A square parapet ring of half size h (outer face) standing at z, with merlons on top."""
    for s in (-1, 1):
        sorted_box(b, (s * h, -h, z), (s * (h - thick), h, z + height), layer, grain=(0, 1, 0), skip=("-z",))
        sorted_box(b, (-h + thick, s * h, z), (h - thick, s * (h - thick), z + height), layer, grain=(1, 0, 0), skip=("-z",))
        merlon_row(b, "y", s * (h - thick), s * h, -h, h, z + height, z + height + merlon, layer)
        merlon_row(b, "x", s * (h - thick), s * h, -h + thick, h - thick, z + height, z + height + merlon, layer)


def curtain(spec):
    """A 6 m curtain module: battered plinth, wall body, string course, wall-walk between two crenellated parapets."""
    b = Builder()
    w, l, walk = spec["width"], spec["length"], spec["walk"]
    t = 0.18
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, 1.4), "castle", skip=("-z",))
    b.box((-w / 2 + t, -l / 2, 1.4), (w / 2 - t, l / 2, walk), "castle", skip=("-z", "+z"))
    for s in (-1, 1):
        sorted_box(b, (s * (w / 2 - t), -l / 2, walk - 2.2), (s * (w / 2 - t + 0.1), l / 2, walk - 1.9), "castle", skip=keep_faces(
            "+x" if s > 0 else "-x", "+z", "-z"))
        sorted_box(b, (s * (w / 2 - t), -l / 2, walk), (s * (w / 2 - t - 0.6), l / 2, walk + 1.0), "castle", grain=(0, 1, 0), skip=("-z",))
        merlon_row(b, "y", s * (w / 2 - t - 0.6), s * (w / 2 - t), -l / 2, l / 2, walk + 1.0, walk + 2.6, "castle", step=2.0)
        slit(b, "x", s * (w / 2 - t), s, 0.0, 5.6, 7.2)
    b.box((-w / 2 + t + 0.6, -l / 2, walk - 0.05), (w / 2 - t - 0.6, l / 2, walk), "castle", grain=(0, 1, 0), skip=keep_faces("+z"))
    return b, walk + 2.6


def curtain_ruin(spec):
    """A ruined 6 m curtain module: the wall broken off between 3.5 and 10 m along a jagged sloping line, a mossy
    coping, fallen blocks at its foot."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    rng = random.Random(spec.get("seed", 7))
    t = 0.18
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, 1.0), "castle", skip=("-z",))
    strips = 6
    heights = [6.0 + 3.5 * math.sin(math.pi * (i + 0.5) / strips) * rng.uniform(0.55, 1.0) for i in range(strips)]
    heights[rng.randrange(strips)] = rng.uniform(3.5, 4.5)
    broken_wall(b, "x", w / 2 - t, 1, -l / 2, l / 2, w - 2 * t - 0.25, heights, z0=1.0)
    for s in (-1, 1):
        for k in range(3):
            y = rng.uniform(-l / 2 + 0.6, l / 2 - 0.6)
            size = rng.uniform(0.45, 0.8)
            x_in = s * (w / 2 - t - 0.25)
            sorted_box(b, (x_in, y - size, 1.0), (s * (w / 2 - 0.02), y + size, 1.0 + size * 0.8), "castle" if k else "mossruin",
                       skip=("-z",))
    return b, max(heights)


def tower_round(spec):
    """A round tower: battered plinth, slightly tapering body with slits, corbelled crenellated parapet, conical slate roof."""
    b = Builder()
    r, top, sides = spec["width"] / 2, spec["top"], 20
    w1.frustum(b, 0, 0, 0, r, 1.8, r - 0.25, sides, "castle")
    annulus(b, r - 0.35, r - 0.25, 1.8, sides, "castle")
    w1.frustum(b, 0, 0, 1.8, r - 0.35, top - 1.2, r - 0.5, sides, "castle")
    w1.frustum(b, 0, 0, 11.0, r - 0.3, 11.35, r - 0.3, sides, "castle")
    annulus(b, r - 0.42, r - 0.3, 11.0, sides, "castle", down=True)
    annulus(b, r - 0.42, r - 0.3, 11.35, sides, "castle")
    w1.frustum(b, 0, 0, top - 1.2, r - 0.5, top, r + 0.25, sides, "castle")
    w1.frustum(b, 0, 0, top, r + 0.25, top + 1.0, r + 0.25, sides, "castle")
    ring_faces(b, r - 0.35, top + 0.3, r - 0.35, top + 1.0, sides, "castle", inward=True)
    annulus(b, r - 0.35, r + 0.25, top + 1.0, sides, "castle")
    ring_merlons(b, r - 0.35, r + 0.25, top + 1.0, top + 2.4, 10, "castle")
    annulus(b, 0, r - 0.35, top + 0.3, sides, "castle")
    cone(b, r - 0.45, top + 0.3, top + spec["roof"], sides, "slate")
    b.beam((0, 0, top + spec["roof"] - 0.4), (0, 0, top + spec["roof"] + 1.2), 0.14, "dark")
    for k in range(4):
        # Face centres of the 20-gon lie at multiples of 18 degrees; a slit sits flush on one, 12 mm proud.
        a = math.pi / 2 * k
        for z0 in (5.0, 13.5):
            rr = (r - 0.35 - (z0 - 1.8) / (top - 3.0) * 0.15) * math.cos(math.pi / sides) + 0.012
            tangent = (math.cos(a), -math.sin(a), 0)
            c = Vector(polar(rr, a, 0))
            pts = [c + Vector(tangent) * -0.12 + Vector((0, 0, z0)), c + Vector(tangent) * 0.12 + Vector((0, 0, z0)),
                   c + Vector(tangent) * 0.12 + Vector((0, 0, z0 + 1.5)), c + Vector(tangent) * -0.12 + Vector((0, 0, z0 + 1.5))]
            b.quad(*[tuple(p) for p in pts], "dark", grain=UP, outward=(math.sin(a), math.cos(a), 0))
    return b, top + spec["roof"] + 1.2


def tower_square(spec):
    """A square tower: plinth, body with slits and two string courses, corbelled crenellated parapet, flat walk."""
    b = Builder()
    h, top = spec["width"] / 2, spec["top"]
    t = 0.15
    b.box((-h, -h, 0), (h, h, 1.6), "castle", skip=("-z",))
    b.box((-h + t, -h + t, 1.6), (h - t, h - t, top - 0.7), "castle", skip=("-z", "+z"))
    for z in (9.0, 16.0):
        b.box((-h + t - 0.08, -h + t - 0.08, z), (h - t + 0.08, h - t + 0.08, z + 0.3), "castle", skip=())
    b.box((-h - 0.25, -h - 0.25, top - 0.7), (h + 0.25, h + 0.25, top), "castle", skip=("+z",))
    parapet_square(b, h + 0.25, top, 1.0, 1.5)
    b.box((-h + 0.4, -h + 0.4, top - 0.05), (h - 0.4, h - 0.4, top), "castle", skip=keep_faces("+z"))
    for key, (axis, coord, side, span) in w1.walls(2 * (h - t), 2 * (h - t)).items():
        for z0 in (4.5, 12.0, 18.5):
            slit(b, axis, coord, side, 0.0, z0, z0 + 1.5)
    return b, top + 2.5


def keep(spec):
    """The keep: a tall square tower house with a raised door, lancets, string courses, corbelled crenellated parapet,
    corner bartizans with cones and a pyramid slate roof inside the walk."""
    b = Builder()
    w, top = spec["width"], spec["top"]
    plinth = 0.8
    b.box((-w / 2, -w / 2, 0), (w / 2, w / 2, plinth), "castle", skip=("-z",))
    floors = (plinth, 9.5, 17.0)
    openings = {"+x": [w1.door(0.0, plinth, (2.2, 3.6))] + [(0.0, 1.1, z + 2.0, z + 4.4, "lancet") for z in floors[1:]],
                "-x": [(u, 0.3, z + 2.2, z + 3.8, "slit") for z in floors for u in (-3.0, 3.0)],
                "+y": [(0.0, 1.1, z + 2.0, z + 4.4, "lancet") for z in floors[1:]] + [(0.0, 0.3, 4.0, 5.6, "slit")],
                "-y": [(0.0, 1.1, z + 2.0, z + 4.4, "lancet") for z in floors[1:]] + [(0.0, 0.3, 4.0, 5.6, "slit")]}
    w1.masonry_walls(b, w, w, plinth, top - 0.8, "castle", 1.2, openings, "ashlar", quoins=False)
    for z in floors[1:]:
        w1.band(b, w - 2 * w1.INSET, w - 2 * w1.INSET, z, 0.3, "castle", proud=0.06)
    b.box((-w / 2 - 0.3, -w / 2 - 0.3, top - 0.8), (w / 2 + 0.3, w / 2 + 0.3, top), "castle", skip=("+z",))
    parapet_square(b, w / 2 + 0.3, top, 1.0, 1.5)
    w1.pyramid_roof(b, 0, 0, w / 2 - 0.8, w / 2 - 0.8, top + 0.3, top + spec["roof"], "slate", soffit="castle")
    for sx in (-1, 1):
        for sy in (-1, 1):
            # Bartizans overhang the 15 m footprint by at most 0.75 m (the cones), within the kit's 0.8 m eaves rule.
            c = Shift(b, sx * (w / 2 - 0.75), sy * (w / 2 - 0.75))
            c.frustum(top - 4.2, 0.4, top - 2.2, 1.4, 12, "castle")
            c.frustum(top - 2.2, 1.4, top + 2.6, 1.4, 12, "castle")
            c.cone(1.5, top + 2.6, top + 6.2, 12, "slate")
            for k in range(3):
                # Face centres of the 12-gon lie at (i + 0.5) x 30 degrees.
                a = math.radians(30 * (4 * k + (1.5 if sx * sy > 0 else 3.5)))
                c.slit_round(1.4 * math.cos(math.pi / 12), a, top - 0.6, top + 1.0)
    return b, top + spec["roof"]


class Shift:
    """Round pieces of the keep's bartizans, built about a moved centre."""

    def __init__(self, b, x, y):
        self.b, self.x, self.y = b, x, y

    def _p(self, p):
        return (p[0] + self.x, p[1] + self.y, p[2])

    def frustum(self, z0, r0, z1, r1, sides, layer):
        for i in range(sides):
            a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
            mid = (a0 + a1) / 2
            p = [polar(r0, a0, z0), polar(r0, a1, z0), polar(r1, a1, z1), polar(r1, a0, z1)]
            self.b.quad(*[self._p(q) for q in p], layer, grain=UP, outward=(math.sin(mid), math.cos(mid), (r0 - r1) * 0.5))

    def cone(self, r, z0, apex, sides, layer):
        for i in range(sides):
            a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
            mid = (a0 + a1) / 2
            self.b.tri(self._p(polar(r, a0, z0)), self._p(polar(r, a1, z0)), self._p((0, 0, apex)), layer, grain=UP,
                       outward=(math.sin(mid), math.cos(mid), 0.4))

    def slit_round(self, r, a, z0, z1, width=0.2):
        tangent = Vector((math.cos(a), -math.sin(a), 0))
        c = Vector(self._p(polar(r + 0.012, a, 0)))  # r is the face (apothem) radius
        pts = [c - tangent * width / 2 + Vector((0, 0, z0)), c + tangent * width / 2 + Vector((0, 0, z0)),
               c + tangent * width / 2 + Vector((0, 0, z1)), c - tangent * width / 2 + Vector((0, 0, z1))]
        self.b.quad(*[tuple(p) for p in pts], "dark", grain=UP, outward=(math.sin(a), math.cos(a), 0))


def gate_arch(spec):
    """The gatehouse arch spanning a road between two gate towers (along Y), as deep as the towers (X): a segmental
    vault springing at 6.8 m, a portcullis slot, and the wall-walk with crenellated parapets. Each end runs `embed`
    metres into a round gate tower, deep enough that both façades meet its curved face. Presentation only."""
    b = Builder()
    depth, span, embed, walk = spec["width"], spec["span"], spec["embed"], spec["walk"]
    half = span / 2
    spring, rise = spec["spring"], spec["rise"]
    radius = (half * half + rise * rise) / (2 * rise)
    centre_z = spring + rise - radius
    n = 12
    ys = [-half + i * span / n for i in range(n + 1)]
    zs = [centre_z + math.sqrt(max(0.0, radius * radius - y * y)) for y in ys]
    for s in (-1, 1):
        x = s * depth / 2
        for i in range(n):
            b.quad((x, ys[i], zs[i]), (x, ys[i + 1], zs[i + 1]), (x, ys[i + 1], walk), (x, ys[i], walk), "castle", grain=UP,
                   outward=(s, 0, 0))
        for y0, y1 in ((-half - embed, -half), (half, half + embed)):
            b.quad((x, y0, spring), (x, y1, spring), (x, y1, walk), (x, y0, walk), "castle", grain=UP, outward=(s, 0, 0))
        # Voussoir ring: dressed stone round the arch head on both faces.
        for i in range(n):
            a, c = (ys[i], zs[i]), (ys[i + 1], zs[i + 1])
            b.quad((x + s * 0.025, a[0], a[1]), (x + s * 0.025, c[0], c[1]), (x + s * 0.025, c[0], c[1] + 0.75),
                   (x + s * 0.025, a[0], a[1] + 0.75), "ashlar", grain=UP, outward=(s, 0, 0))
        sorted_box(b, (x, -half - embed, walk - 2.2), (x + s * 0.1, half + embed, walk - 1.9), "castle",
                   skip=keep_faces("+x" if s > 0 else "-x", "+z", "-z"))
        sorted_box(b, (x, -half - embed, walk), (x - s * 0.6, half + embed, walk + 1.0), "castle", grain=(0, 1, 0), skip=("-z",))
        merlon_row(b, "y", x - s * 0.6, x, -half - embed, half + embed, walk + 1.0, walk + 2.6, "castle", step=2.0)
    for i in range(n):
        b.quad((-depth / 2, ys[i], zs[i]), (depth / 2, ys[i], zs[i]), (depth / 2, ys[i + 1], zs[i + 1]), (-depth / 2, ys[i + 1], zs[i + 1]),
               "castle", grain=(1, 0, 0), outward=(0, 0, -1))
    # The portcullis, raised: a dark iron grille in its slot just under the vault.
    for k in range(7):
        y = -half + 0.8 + k * (span - 1.6) / 6
        b.beam((0.6, y, spring + rise - 0.7), (0.6, y, zs[min(n, max(0, round((y + half) / span * n)))] - 0.05), 0.12, "dark")
    b.beam((0.6, -half + 0.6, spring + rise - 0.6), (0.6, half - 0.6, spring + rise - 0.6), 0.14, "dark")
    b.box((-depth / 2 + 0.6, -half - embed, walk - 0.05), (depth / 2 - 0.6, half + embed, walk), "castle", grain=(0, 1, 0),
          skip=keep_faces("+z"))
    return b, walk + 2.6


def tower_ruin(spec):
    """A ruined round tower: a hollow shell broken off along a jagged line from 15 m down to 3 m on one side, with a
    breach, mossy wall tops, a rubble floor and fallen stones hugging the base."""
    b = Builder()
    r, sides = spec["width"] / 2, 20
    rng = random.Random(spec.get("seed", 11))
    r_out, r_in = r - 0.25, r - 1.45
    w1.frustum(b, 0, 0, 0, r, 1.2, r_out, sides, "castle")
    # Wall-top heights at the shell's corners: the top slopes between them (a V-shaped breach at corners 6 and 7).
    heights = []
    for i in range(sides):
        a = 2 * math.pi * i / sides
        heights.append(max(3.0, 9.0 + 6.0 * math.cos(a - 0.6) * rng.uniform(0.75, 1.0) - (4.0 if i in (6, 7) else 0.0)))
    for i in range(sides):
        a0, a1 = 2 * math.pi * i / sides, 2 * math.pi * (i + 1) / sides
        h0, h1 = heights[i], heights[(i + 1) % sides]
        mid = (a0 + a1) / 2
        out = (math.sin(mid), math.cos(mid), 0)
        b.quad(polar(r_out, a0, 1.2), polar(r_out, a1, 1.2), polar(r_out, a1, h1), polar(r_out, a0, h0), "castle", grain=UP, outward=out)
        b.quad(polar(r_in, a0, 0.2), polar(r_in, a1, 0.2), polar(r_in, a1, h1), polar(r_in, a0, h0), "castle", grain=UP,
               outward=tuple(-c for c in out))
        b.quad(polar(r_in, a0, h0), polar(r_out, a0, h0), polar(r_out, a1, h1), polar(r_in, a1, h1), "mossruin", grain=(0, 1, 0),
               outward=(0, 0, 1))
    annulus(b, 0, r_in, 0.2, sides, "mossruin")
    for k in range(4):
        a = rng.uniform(0, 2 * math.pi)
        rr = rng.uniform(0.5, r_in - 0.8)
        size = rng.uniform(0.35, 0.6)
        x, y, _ = polar(rr, a, 0)
        b.box((x - size, y - size, 0.2), (x + size, y + size, 0.2 + size * 1.2), "mossruin" if k % 2 else "castle", skip=("-z",))
    return b, max(heights)


def slab(b, axis, coord, side, u0, u1, thickness, bottom, top, layer, faces):
    """A piece of wall from u0 to u1, `thickness` metres inward from the wall face at axis=coord: its bottom edge runs
    straight from bottom[0] (at u0) to bottom[1] (at u1) and its top edge from top[0] to top[1]. `faces` names the
    faces to build: outer, inner, top, bottom, start (at u0) and end (at u1)."""
    (lo0, lo1), (h0, h1) = bottom, top
    o = lambda u, z: w1.wall_point(axis, coord, side, u, z, 0.0)
    i = lambda u, z: w1.wall_point(axis, coord, side, u, z, thickness)
    centre = w1.wall_point(axis, coord, side, (u0 + u1) / 2, (lo0 + lo1 + h0 + h1) / 4, thickness / 2)
    along = (0, 1, 0) if axis == "x" else (1, 0, 0)
    if "outer" in faces:
        b.quad(o(u0, lo0), o(u1, lo1), o(u1, h1), o(u0, h0), layer, grain=UP, centre=centre)
    if "inner" in faces:
        b.quad(i(u1, lo1), i(u0, lo0), i(u0, h0), i(u1, h1), layer, grain=UP, centre=centre)
    if "top" in faces:
        b.quad(o(u0, h0), o(u1, h1), i(u1, h1), i(u0, h0), layer, grain=along, centre=centre)
    if "bottom" in faces:
        b.quad(i(u0, lo0), i(u1, lo1), o(u1, lo1), o(u0, lo0), layer, grain=along, centre=centre)
    if "start" in faces:
        b.quad(i(u0, lo0), o(u0, lo0), o(u0, h0), i(u0, h0), layer, grain=UP, centre=centre)
    if "end" in faces:
        b.quad(o(u1, lo1), i(u1, lo1), i(u1, h1), o(u1, h1), layer, grain=UP, centre=centre)


def broken_wall(b, axis, coord, side, u0, u1, thickness, heights, gaps=(), layer="castle", top="mossruin", z0=0.0):
    """A roofless masonry wall from u0 to u1 whose broken top runs along a jagged line: each of the n equal strips peaks
    at its height near its middle and slopes to meet its neighbours halfway, or breaks off in a step where they differ
    by more than 2.5 m, under a 0.3 m mossy coping; open both sides. `gaps` are (u_from, u_to, z_bottom, z_top) holes
    (doorways reach the ground: z_bottom 0); a hole whose top reaches the broken line leaves the wall open above its
    sill."""
    n = len(heights)
    step = (u1 - u0) / n
    # Each strip's top at its two edges: shared with the neighbour (a slope) or its own (a step).
    edges = []
    for k, h in enumerate(heights):
        left = h if k == 0 else heights[k - 1]
        right = h if k + 1 == n else heights[k + 1]
        edges.append(((h + left) / 2 if abs(h - left) <= 2.5 else h - 0.3, (h + right) / 2 if abs(h - right) <= 2.5 else h - 0.3))
    pieces = []
    for k, h in enumerate(heights):
        # The peak moves off the strip's middle by up to a quarter strip, deterministically from its height.
        shift = ((h * 7.31) % 1.0 - 0.5) * 0.5
        middle = u0 + (k + 0.5 + shift) * step
        pieces.append((u0 + k * step, middle, edges[k][0], h))
        pieces.append((middle, u0 + (k + 1) * step, h, edges[k][1]))
    segments = []
    for ua, ub, ha, hb in pieces:
        low = min(ha, hb)
        spans = [(z0, low)]
        for g0, g1, gb, gt in gaps:
            if g0 < ub - 1e-6 and g1 > ua + 1e-6:
                cut = []
                for lo, hi in spans:
                    if gt <= lo or gb >= hi:
                        cut.append((lo, hi))
                        continue
                    if gb > lo:
                        cut.append((lo, gb))
                    if gt < hi:
                        cut.append((gt, hi))
                spans = cut
        # A span reaching the broken line carries the sloping coping; any other span ends flat. Masonry over a hole
        # thinner than 0.6 m has fallen.
        keyed = [((lo, "top") if abs(hi - low) < 1e-6 and hi - lo > 0.35 else (lo, hi), lo, hi) for lo, hi in spans
                 if hi - lo >= (0.05 if lo <= z0 + 1e-6 else 0.6)]
        segments.append((ua, ub, ha, hb, keyed))
    # Masonry above a hole stands only where it still joins wall rising from the ground beside the hole; the rest has
    # fallen (otherwise a lintel could float over a breach in the broken line).
    def rises(k, height):
        return 0 <= k < len(segments) and any(lo <= z0 + 1e-6 and hi >= height for _, lo, hi in segments[k][4])

    for sill in sorted({lo for segment in segments for _, lo, _ in segment[4] if lo > z0 + 1e-6}):
        k = 0
        while k < len(segments):
            if not any(abs(lo - sill) < 1e-6 for _, lo, _ in segments[k][4]):
                k += 1
                continue
            first = k
            while k < len(segments) and any(abs(lo - sill) < 1e-6 for _, lo, _ in segments[k][4]):
                k += 1
            if not (rises(first - 1, sill + 0.3) or rises(k, sill + 0.3)):
                for j in range(first, k):
                    segments[j] = segments[j][:4] + ([s for s in segments[j][4] if abs(s[1] - sill) > 1e-6],)
    for index, (ua, ub, ha, hb, keyed) in enumerate(segments):
        previous = segments[index - 1] if index else None
        following = segments[index + 1] if index + 1 < len(segments) else None
        for key, lo, hi in keyed:
            # An end face closes a span wherever its neighbour has no matching span or, under the broken line, breaks
            # off at another height.
            joined_before = previous is not None and key in {k for k, _, _ in previous[4]} and (key[1] != "top" or abs(previous[3] - ha) < 1e-6)
            joined_after = following is not None and key in {k for k, _, _ in following[4]} and (key[1] != "top" or abs(following[2] - hb) < 1e-6)
            ends = ([] if joined_before else ["start"]) + ([] if joined_after else ["end"])
            floor = ["bottom"] if lo > 0.01 else []
            if key[1] == "top":
                slab(b, axis, coord, side, ua, ub, thickness, (lo, lo), (ha - 0.3, hb - 0.3), layer, ["outer", "inner"] + floor + ends)
                slab(b, axis, coord, side, ua, ub, thickness, (ha - 0.3, hb - 0.3), (ha, hb), top, ["outer", "inner", "top"] + ends)
            else:
                slab(b, axis, coord, side, ua, ub, thickness, (lo, lo), (hi, hi), layer, ["outer", "inner", "top"] + floor + ends)


def profile(rng, n, low, high, peak=None):
    """Jagged wall-top heights: random between low and high, rising towards `peak` (an index) if given."""
    out = []
    for i in range(n):
        h = rng.uniform(low, high)
        if peak is not None:
            h = low + (high - low) * max(0.0, 1.0 - abs(i - peak) / max(1, n / 2)) * rng.uniform(0.75, 1.0) + rng.uniform(0, 0.6)
        out.append(round(h, 2))
    return out


def ruin_chapel(spec):
    """A roofless ruined chapel: buttressed side walls broken at 3-8 m with lancet gaps, a tall broken west gable with
    its great window open, a collapsed east end with a doorway, a rubble floor."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    rng = random.Random(spec.get("seed", 23))
    t, bt = 0.8, 0.6
    ow = w - 2 * bt
    floor_z = 0.08
    strips = 16
    for s in (-1, 1):
        heights = [round(rng.uniform(3.2, 7.8) if i not in (2, 3, 11) else rng.uniform(1.4, 2.6), 2) for i in range(strips)]
        gaps = [(-l / 2 + (k + 0.3) * l / 5, -l / 2 + (k + 0.7) * l / 5, 2.4, 5.4) for k in range(1, 5)]
        broken_wall(b, "x", s * ow / 2, s, -l / 2 + t, l / 2 - t, t, heights, gaps)
        for k in range(6):
            y = -l / 2 + t + k * (l - 2 * t) / 5
            sorted_box(b, (s * ow / 2, y - 0.35, 0), (s * w / 2, y + 0.35, min(3.0, heights[min(strips - 1, k * 3)])), "castle",
                       skip=("-z",))
    gable = profile(rng, 9, 3.0, spec["gable"], peak=4)
    gable[6] = min(gable[6], 4.0)
    broken_wall(b, "y", -l / 2, -1, -ow / 2, ow / 2, t, gable, [(-0.9, 0.9, 3.0, 8.2)])
    east = [round(rng.uniform(1.2, 3.2), 2) for _ in range(9)]
    broken_wall(b, "y", l / 2, 1, -ow / 2, ow / 2, t, east, [(-1.0, 1.0, 0.0, 9.0)])
    b.quad((-ow / 2 + t, -l / 2 + t, floor_z), (ow / 2 - t, -l / 2 + t, floor_z), (ow / 2 - t, l / 2 - t, floor_z),
           (-ow / 2 + t, l / 2 - t, floor_z), "mossruin", grain=(0, 1, 0), outward=(0, 0, 1))
    for k in range(6):
        x, y = rng.uniform(-ow / 2 + t + 0.6, ow / 2 - t - 0.6), rng.uniform(-l / 2 + t + 0.8, l / 2 - t - 0.8)
        size = rng.uniform(0.35, 0.7)
        b.box((x - size, y - size, floor_z), (x + size, y + size, floor_z + size * 1.1), "castle" if k % 2 else "mossruin", skip=("-z",))
    return b, max(max(gable), 7.8)


def ruin_house(spec):
    """A roofless ruined stone house: rubble walls broken at 1.5-5 m, one gable standing to 7 m, a doorway and window
    gaps, fallen stones inside."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    rng = random.Random(spec.get("seed", 31))
    t = 0.6
    long_heights = lambda: [round(rng.uniform(1.6, 4.8), 2) for _ in range(8)]
    broken_wall(b, "x", w / 2, 1, -l / 2 + t, l / 2 - t, t, long_heights(), [(-1.9, -0.6, 0.0, 9.0), (1.4, 2.4, 1.5, 2.8)],
                layer="rubble")
    broken_wall(b, "x", -w / 2, -1, -l / 2 + t, l / 2 - t, t, long_heights(), [(-0.5, 0.5, 1.5, 2.8)], layer="rubble")
    gable = profile(rng, 6, 2.5, spec["gable"], peak=2)
    broken_wall(b, "y", -l / 2, -1, -w / 2, w / 2, t, gable, [(-0.4, 0.4, 3.6, 4.8)], layer="rubble")
    broken_wall(b, "y", l / 2, 1, -w / 2, w / 2, t, [round(rng.uniform(1.0, 3.4), 2) for _ in range(6)], layer="rubble")
    b.quad((-w / 2 + t, -l / 2 + t, 0.06), (w / 2 - t, -l / 2 + t, 0.06), (w / 2 - t, l / 2 - t, 0.06), (-w / 2 + t, l / 2 - t, 0.06),
           "mossruin", grain=(0, 1, 0), outward=(0, 0, 1))
    for k in range(4):
        x, y = rng.uniform(-w / 2 + 1.2, w / 2 - 1.2), rng.uniform(-l / 2 + 1.2, l / 2 - 1.2)
        size = rng.uniform(0.3, 0.6)
        b.box((x - size, y - size, 0.06), (x + size, y + size, 0.06 + size), "rubble", skip=("-z",))
    return b, max(gable)


def camp_tower(spec):
    """A timber watch tower on a stone foot for a military post's circular footing: four braced posts, a planked
    platform with a breastwork, a ladder and a shingle cap. Below 3 m everything stays inside the inscribed circle."""
    b = Builder()
    r = spec["width"] / 2
    deck, cap, apex = spec["deck"], spec["cap"], spec["apex"]
    w1.frustum(b, 0, 0, 0, r - 0.05, 0.8, r - 0.2, 8, "rubble", cap="rubble")
    c = 1.05
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box((sx * c - 0.16, sy * c - 0.16, 0.8), (sx * c + 0.16, sy * c + 0.16, cap), "timber", skip=("-z", "+z"))
    for key, (axis, coord, side, span) in w1.walls(2 * c, 2 * c).items():
        p = (lambda u, z, cc=coord, a=axis: (cc, u, z) if a == "x" else (u, cc, z))
        b.beam(p(-c, 1.2), p(c, deck - 0.3), 0.16)
        b.beam(p(-c, deck - 0.2), p(c, deck - 0.2), 0.2)
    e = r - 0.1
    b.box((-e, -e, deck), (e, e, deck + 0.2), "planks", grain=(1, 0, 0))
    for sx in (-1, 1):
        sorted_box(b, (sx * e, -e, deck + 0.2), (sx * (e - 0.08), e, deck + 1.25), "planks", grain=(0, 1, 0), skip=("-z",))
    for sy in (-1, 1):
        sorted_box(b, (-e + 0.08, sy * e, deck + 0.2), (e - 0.08, sy * (e - 0.08), deck + 1.25), "planks", grain=(1, 0, 0), skip=("-z",))
    # The cap's corners stay within 0.8 m of the circular footing (its half size is the footing's radius).
    w1.pyramid_roof(b, 0, 0, r, r, cap, apex, "shingle")
    x = c - 0.3
    for y in (-0.28, 0.28):
        b.beam((x, y, 0.8), (x, y, deck + 0.2), 0.09)
    for i in range(1, 7):
        z = 0.8 + i * (deck - 0.8) / 7
        b.beam((x, -0.28, z), (x, 0.28, z), 0.06)
    return b, apex


BUILDINGS = {
    "kit-curtain": dict(kind="curtain", width=3.5, length=6.0, walk=11.4),
    "kit-curtain-ruin": dict(kind="curtain-ruin", width=3.5, length=6.0, seed=7),
    "kit-tower-round": dict(kind="tower-round", width=9.0, top=21.0, roof=8.5, round=True),
    "kit-tower-square": dict(kind="tower-square", width=8.0, top=22.0),
    "kit-tower-ruin": dict(kind="tower-ruin", width=9.0, seed=11, round=True),
    "kit-keep": dict(kind="keep", width=15.0, top=27.0, roof=8.0),
    "kit-gate-arch": dict(kind="gate-arch", width=7.0, span=10.0, embed=3.0, walk=11.4, spring=6.8, rise=1.9),
    "kit-ruin-chapel": dict(kind="ruin-chapel", width=9.0, length=20.0, gable=11.0, seed=23),
    "kit-ruin-house": dict(kind="ruin-house", width=7.0, length=10.0, gable=7.0, seed=31),
    "kit-camp-tower": dict(kind="camp-tower", width=3.6, deck=6.0, cap=7.6, apex=9.6, round=True),
}
BUILDERS = {"curtain": curtain, "curtain-ruin": curtain_ruin, "tower-round": tower_round, "tower-square": tower_square,
            "tower-ruin": tower_ruin, "keep": keep, "gate-arch": gate_arch, "ruin-chapel": ruin_chapel, "ruin-house": ruin_house,
            "camp-tower": camp_tower}


def footprint(spec):
    """The collider of the finished model: [width along X, length along Z]; round pieces collide as the inscribed circle;
    the gate arch is presentation only and reports the span it covers plus its embedding in the towers."""
    if spec["kind"] == "gate-arch":
        return [spec["width"], spec["span"] + 2 * spec["embed"]]
    w = spec["width"]
    return [w, spec.get("length", w)]


def build(name, spec):
    builder, top = BUILDERS[spec["kind"]](spec)
    mesh = builder.finish(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, top


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--samples", type=int, default=48)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    report = {"blender": bpy.app.version_string, "build": bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash,
              "layers": SURFACES, "tileMetres": kit.TILE, "assets": {}}
    for name, spec in BUILDINGS.items():
        if args.only and name not in args.only:
            continue
        obj, top = build(name, spec)
        bake_ao(obj, args.samples)
        path = args.out / f"{name}.glb"
        export(obj, path)
        report["assets"][name] = {"triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons), "vertices": len(obj.data.vertices),
                                 "top": top, "bounds": bounds(obj), "footprint": footprint(spec), "round": bool(spec.get("round")),
                                 "file": path.name, "bytes": path.stat().st_size}
        bpy.data.objects.remove(obj, do_unlink=True)
    (args.out / "kit-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({name: {k: v for k, v in a.items() if k in ("triangles", "bytes", "top")} for name, a in report["assets"].items()}))


if __name__ == "__main__":
    main()
