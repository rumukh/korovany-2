"""Korovany II world kit, W1 settlements: scripted Blender 5.2 buildings at the heroic scale standard.

Extends the W0 kit (build_kit.py, imported unchanged: Builder, gabled_roof, the AO bake and the export) with stone, brick,
two-storey, inn, stable, chapel, smithy, tower, market, fen and coast buildings, a kiln and a stone yard-wall module.
Same conventions as W0: one mesh per asset; UV0 is a world-scale planar mapping; UV1.x is the surface layer index (+0.5)
into the game's texture array and UV1.y baked ambient occlusion. Walls and everything below 3 m stay inside the footprint
rectangle the v3 generator collides with (width along local X, the front facing +X; length along Z); only parts above
3 m overhang it, by at most 0.8 m. Unlike W0, closed buildings emit only faces that can be seen from outside (walls are
single outer faces; frames, reveals and leaves keep their visible sides), which keeps inns and chapels within budget.

    blender -b --factory-startup --python build_kit_w1.py -- --out <dir> [--only kit-chapel ...] [--samples 48]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_kit as kit  # noqa: E402  (the W0 kit, unchanged)
from build_kit import DOOR, SILL, UP, WINDOW, Builder, bake_ao, bounds, export, gabled_roof  # noqa: E402

# The game's surface array order (WORLD_SURFACES in src/view/world-assets.ts): W0's fifteen layers, then W1's.
SURFACES = ["daub", "timber", "thatch", "shingle", "rubble", "planks", "dark", "meadow", "forest", "mud", "road", "field",
            "granite", "bark-spruce", "bark-birch", "ashlar", "slate", "lime", "tarred", "brick"]
assert SURFACES[:len(kit.LAYERS)] == kit.LAYERS
kit.LAYERS[:] = SURFACES  # the W0 Builder looks layers up in this module-level list
kit.TILE.update({"ashlar": 2.0, "slate": 2.0, "lime": 2.0, "tarred": 2.0, "brick": 2.0})
INSET = 0.05  # walls and infill sit this far behind the frames, posts and quoins on the footprint
SIDES = ("+x", "-x", "+y", "-y", "+z", "-z")


def keep(*names):
    """The `skip` argument of Builder.box that builds only the named faces."""
    return tuple(k for k in SIDES if k not in names)


def outer_key(axis, side):
    return ("+" if side > 0 else "-") + axis


def u_key(axis, sign):
    """The face of a wall piece that looks along the wall (towards +u when sign > 0)."""
    return ("+" if sign > 0 else "-") + ("y" if axis == "x" else "x")


def wall_point(axis, coord, side, u, z, d=0.0):
    """A point on the wall plane axis=coord at (u, z), `d` metres inward."""
    n = coord - side * d
    return (n, u, z) if axis == "x" else (u, n, z)


class Shifted:
    """Forwards to a Builder with every point moved by an offset (grain and outward directions are unchanged)."""

    def __init__(self, b, dx=0.0, dy=0.0, dz=0.0):
        self.b, self.d = b, Vector((dx, dy, dz))

    def _p(self, p):
        return None if p is None else tuple(Vector(p) + self.d)

    def quad(self, a, b, c, d, layer, grain=None, outward=None, centre=None):
        return self.b.quad(self._p(a), self._p(b), self._p(c), self._p(d), layer, grain, outward, self._p(centre))

    def tri(self, a, b, c, layer, grain=None, outward=None, centre=None):
        return self.b.tri(self._p(a), self._p(b), self._p(c), layer, grain, outward, self._p(centre))

    def box(self, lo, hi, layer, grain=None, skip=()):
        return self.b.box(self._p(lo), self._p(hi), layer, grain, skip)

    def beam(self, a, b, size, layer="timber"):
        return self.b.beam(self._p(a), self._p(b), size, layer)


def rotate(b, degrees):
    """Turns the finished pieces about the vertical axis (models built gable-forward are turned to face +X)."""
    bmesh.ops.rotate(b.bm, verts=b.bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(degrees), 3, "Z"))


def sorted_box(b, p, q, layer, grain=None, skip=()):
    b.box(tuple(map(min, p, q)), tuple(map(max, p, q)), layer, grain, skip)


def walls(w, l):
    """The four outer walls of a w x l rectangle: key -> (axis, coord, side, span)."""
    return {
        "+x": ("x", w / 2, 1, (-l / 2, l / 2)),
        "-x": ("x", -w / 2, -1, (-l / 2, l / 2)),
        "+y": ("y", l / 2, 1, (-w / 2, w / 2)),
        "-y": ("y", -l / 2, -1, (-w / 2, w / 2)),
    }


def wall_cut(b, axis, coord, side, span, z0, z1, cuts, layer, thickness=0.3, outer_only=True):
    """A wall split round its openings, which may be stacked in a column (towers, two storeys).

    Closed buildings build only the outer face of each piece; open ones (`outer_only=False`) build whole slabs.
    """
    skip = keep(outer_key(axis, side)) if outer_only else ()

    def piece(u0, u1, w0, w1):
        if u1 - u0 < 1e-3 or w1 - w0 < 1e-3:
            return
        sorted_box(b, wall_point(axis, coord, side, u0, w0, 0.0), wall_point(axis, coord, side, u1, w1, thickness), layer,
                   skip=skip)

    columns = []
    for c, width, bottom, top in sorted(cuts, key=lambda k: k[0] - k[1] / 2):
        left, right = c - width / 2, c + width / 2
        if columns and left < columns[-1][1] - 1e-6:
            columns[-1][1] = max(columns[-1][1], right)
            columns[-1][2].append((left, right, bottom, top))
        else:
            columns.append([left, right, [(left, right, bottom, top)]])
    u = span[0]
    for left, right, items in columns:
        piece(u, left, z0, z1)
        z = z0
        for l0, r0, bottom, top in sorted(items, key=lambda k: k[2]):
            piece(left, right, z, bottom)
            piece(left, l0, bottom, top)
            piece(r0, right, bottom, top)
            z = top
        piece(left, right, z, z1)
        u = right
    piece(u, span[1], z0, z1)


def leaves(b, axis, coord, side, centre, width, bottom, top, kind, depth, leaf="planks"):
    """The visible face of a plank door (with two iron straps) or a pair of closed shutters, `depth` inward."""
    p = lambda u, z, d: wall_point(axis, coord, side, u, z, d)
    out = keep(outer_key(axis, side))
    left, right = centre - width / 2, centre + width / 2
    if kind == "door":
        sorted_box(b, p(left + 0.02, bottom, depth + 0.06), p(right - 0.02, top - 0.02, depth), leaf, UP, out)
        for h in (bottom + 0.5, top - 0.6):
            sorted_box(b, p(left + 0.05, h, depth - 0.01), p(right - 0.25, h + 0.08, depth), "dark", skip=out)
    elif kind == "window":
        for u0, u1 in ((left + 0.02, centre - 0.01), (centre + 0.01, right - 0.02)):
            sorted_box(b, p(u0, bottom + 0.02, depth + 0.05), p(u1, top - 0.02, depth), leaf, UP, out)


def stone_opening(b, axis, coord, side, centre, width, bottom, top, kind, depth, frame="ashlar", f=0.24):
    """A dressed-stone frame filling the cut through a masonry wall (outer face at `coord`, `depth` thick).

    kind: "door" (plank door), "window" (sill and shutters), "lancet" (pointed head, dark glazing), "slit" (dark).
    """
    p = lambda u, z, d: wall_point(axis, coord, side, u, z, d)
    out = outer_key(axis, side)
    along = (0, 1, 0) if axis == "x" else (1, 0, 0)
    low = bottom - (0.16 if kind == "window" else 0.0)
    head = top if kind == "lancet" else top + 0.3
    left, right = centre - width / 2, centre + width / 2
    sorted_box(b, p(left - f, low, depth), p(left, head, 0.0), frame, skip=keep(out, u_key(axis, 1)))
    sorted_box(b, p(right, low, depth), p(right + f, head, 0.0), frame, skip=keep(out, u_key(axis, -1)))
    if kind == "lancet":
        # Frame stone fills both corners above the springing, leaving a pointed head.
        spring = top - width * 0.75
        out_dir = tuple(Vector(p(0, 0, -1)) - Vector(p(0, 0, 0)))
        for edge in (left, right):
            b.tri(p(edge, spring, 0.0), p(edge, top, 0.0), p(centre, top, 0.0), frame, outward=out_dir)
            b.quad(p(edge, spring, 0.0), p(centre, top, 0.0), p(centre, top, depth), p(edge, spring, depth), frame,
                   outward=tuple(Vector(p(centre, spring, 0.0)) - Vector(p(edge, top, 0.0))))
    else:
        sorted_box(b, p(left - f, top, depth), p(right + f, head, 0.0), frame, along, keep(out, "-z"))
    if kind == "window":
        sorted_box(b, p(left - f, low, depth), p(right + f, bottom, 0.0), frame, along, keep(out, "+z"))
    reveal = min(depth - 0.02, 0.34)
    sorted_box(b, p(left, bottom, reveal + 0.02), p(right, top, reveal), "dark", skip=keep(out))
    leaves(b, axis, coord, side, centre, width, bottom, top, kind, reveal - 0.1)


def flat_beam(b, axis, coord, side, a, c, size, proud=INSET, layer="timber"):
    """A timber standing `proud` of the infill on the wall plane, from (u, z) `a` to `c`: its face and two long sides."""
    d = Vector((c[0] - a[0], c[1] - a[1]))
    d.normalize()
    n = Vector((-d.y, d.x)) * (size / 2)
    pts = [(a[0] - n.x, a[1] - n.y), (c[0] - n.x, c[1] - n.y), (c[0] + n.x, c[1] + n.y), (a[0] + n.x, a[1] + n.y)]
    P = lambda q, depth: wall_point(axis, coord, side, q[0], q[1], depth)
    grain = tuple(Vector(P(c, 0.0)) - Vector(P(a, 0.0)))
    out_dir = tuple(Vector(P((0, 0), -1.0)) - Vector(P((0, 0), 0.0)))
    b.quad(P(pts[0], 0.0), P(pts[1], 0.0), P(pts[2], 0.0), P(pts[3], 0.0), layer, grain=grain, outward=out_dir)
    for i, j, sign in ((0, 1, -1), (3, 2, 1)):
        side_dir = tuple(Vector(P((a[0] + n.x * sign, a[1] + n.y * sign), 0.0)) - Vector(P(a, 0.0)))
        b.quad(P(pts[i], 0.0), P(pts[j], 0.0), P(pts[j], proud), P(pts[i], proud), layer, grain=grain, outward=side_dir)


def timber_opening(b, axis, coord, side, centre, width, bottom, top, kind, depth=0.3, f=0.14):
    """A door or shuttered window in a framed or planked wall: flat frame, reveal faces, dark back and the leaves."""
    p = lambda u, z, d: wall_point(axis, coord, side, u, z, d)
    out = outer_key(axis, side)
    left, right = centre - width / 2, centre + width / 2
    sorted_box(b, p(left - 0.02, bottom, INSET), p(left, top, depth), "dark" if kind == "slit" else "timber",
               skip=keep(u_key(axis, 1)))
    sorted_box(b, p(right, bottom, INSET), p(right + 0.02, top, depth), "dark" if kind == "slit" else "timber",
               skip=keep(u_key(axis, -1)))
    sorted_box(b, p(left, top, INSET), p(right, top + 0.02, depth), "timber", skip=keep("-z"))
    if kind != "door":
        sorted_box(b, p(left, bottom - 0.02, INSET), p(right, bottom, depth), "timber", skip=keep("+z"))
    sorted_box(b, p(left, bottom, depth), p(right, top, depth + 0.02), "dark", skip=keep(out))
    flat_beam(b, axis, coord, side, (left - f / 2, bottom), (left - f / 2, top + f), f)
    flat_beam(b, axis, coord, side, (right + f / 2, bottom), (right + f / 2, top + f), f)
    flat_beam(b, axis, coord, side, (left - f, top + f / 2), (right + f, top + f / 2), f)
    if kind == "window":
        flat_beam(b, axis, coord, side, (left - f * 1.4, bottom - 0.06), (right + f * 1.4, bottom - 0.06), 0.12)
    leaves(b, axis, coord, side, centre, width, bottom, top, kind, depth - 0.12)


def frame_wall(b, axis, coord, side, span, z0, z1, openings, spacing=1.6, size=0.26, braces=True):
    """W0's timber frame (sill, plate, posts, rail and end braces) as flat beams on one wall plane."""
    fb = lambda a, c, s: flat_beam(b, axis, coord, side, a, c, s)
    fb((span[0], z0 + size / 2), (span[1], z0 + size / 2), size)
    fb((span[0], z1 - size / 2), (span[1], z1 - size / 2), size)
    blocked = lambda u: any(c - wd / 2 - 0.2 < u < c + wd / 2 + 0.2 for c, wd, _, _, _ in openings)
    count = max(2, round((span[1] - span[0]) / spacing))
    posts = [span[0] + size / 2 + i * (span[1] - span[0] - size) / count for i in range(count + 1)]
    for u in posts:
        if blocked(u) and u not in (posts[0], posts[-1]):
            continue
        fb((u, z0 + size), (u, z1 - size), size)
    for c, wd, _, _, _ in openings:
        for u in (c - wd / 2 - 0.2, c + wd / 2 + 0.2):
            fb((u, z0 + size), (u, z1 - size), size * 0.9)
    rail = z0 + (z1 - z0) * 0.48
    u = span[0] + size
    for c, wd, _, _, _ in sorted(openings):
        left = c - wd / 2 - 0.3
        if left - u > 0.4:
            fb((u, rail), (left, rail), size * 0.8)
        u = c + wd / 2 + 0.3
    if span[1] - size - u > 0.4:
        fb((u, rail), (span[1] - size, rail), size * 0.8)
    if braces:
        for end in (0, 1):
            corner = span[0] + size if end == 0 else span[1] - size
            towards = 1 if end == 0 else -1
            if not blocked(corner + towards * 1.2):
                fb((corner, z0 + size), (corner + towards * 1.3, rail), size * 0.7)


def framed_walls(b, w, l, z0, z1, infill, openings, spacing=1.6, frame=True):
    """Four walls on the w x l footprint: infill or planking INSET behind a flat timber frame and timber openings.

    `openings` maps a wall key to (centre, width, bottom, top, kind) tuples.
    """
    for key, (axis, coord, side, span) in walls(w - 2 * INSET, l - 2 * INSET).items():
        cuts = [(c, wd, bt, tp) for c, wd, bt, tp, _ in openings.get(key, [])]
        wall_cut(b, axis, coord, side, span, z0, z1, cuts, infill)
    for key, (axis, coord, side, span) in walls(w, l).items():
        items = openings.get(key, [])
        for c, wd, bt, tp, kind in items:
            timber_opening(b, axis, coord, side, c, wd, bt, tp, kind)
        if frame:
            frame_wall(b, axis, coord, side, span, z0, z1, items, spacing)
        else:
            # Planked walls: corner posts and a wall plate only.
            for u in (span[0] + 0.15, span[1] - 0.15):
                flat_beam(b, axis, coord, side, (u, z0), (u, z1), 0.3)
            flat_beam(b, axis, coord, side, (span[0], z1 - 0.14), (span[1], z1 - 0.14), 0.28)


def masonry_walls(b, w, l, z0, z1, layer, thickness, openings, frame="ashlar", quoins=True, course=0.42):
    """Four masonry walls INSET behind the footprint, with dressed-stone openings and corner quoins on the footprint.

    `openings` maps a wall key to (centre, width, bottom, top, kind) tuples.
    """
    for key, (axis, coord, side, span) in walls(w - 2 * INSET, l - 2 * INSET).items():
        cuts = []
        for c, width, bottom, top, kind in openings.get(key, []):
            cuts.append((c, width + 0.48, bottom - (0.16 if kind == "window" else 0.0), top if kind == "lancet" else top + 0.3))
        wall_cut(b, axis, coord, side, span, z0, z1, cuts, layer, thickness)
    for key, (axis, coord, side, span) in walls(w, l).items():
        for c, width, bottom, top, kind in openings.get(key, []):
            stone_opening(b, axis, coord, side, c, width, bottom, top, kind, thickness + INSET, frame)
    if not quoins:
        return
    count = max(1, round((z1 - z0) / course))
    height = (z1 - z0) / count
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * w / 2, sy * l / 2
            for i in range(count):
                ax, ay = (0.62, 0.34) if i % 2 == 0 else (0.34, 0.62)
                faces = keep("+x" if sx > 0 else "-x", "+y" if sy > 0 else "-y", "-x" if sx > 0 else "+x", "-y" if sy > 0 else "+y")
                sorted_box(b, (x - sx * ax, y - sy * ay, z0 + i * height), (x, y, z0 + (i + 1) * height), frame, skip=faces)


def gables(b, w, l, eave, ridge, layer, frame=False):
    """The outer gable triangles at both ends of a w x l roof (ridge along Y), optionally with flat frame timbers."""
    for s in (-1, 1):
        y = s * l / 2
        b.tri((-w / 2, y, eave), (w / 2, y, eave), (0, y, ridge - 0.05), layer, outward=(0, s, 0))
        if frame:
            coord = y + s * INSET
            fb = lambda a, c, size: flat_beam(b, "y", coord, s, a, c, size)
            fb((-w / 2 + 0.15, eave + 0.12), (w / 2 - 0.15, eave + 0.12), 0.22)
            fb((0, eave + 0.2), (0, ridge - 0.3), 0.18)
            collar = eave + (ridge - eave) * 0.45
            span = (w / 2) * 0.55 - 0.1
            fb((-span, collar), (span, collar), 0.16)


def chimney(b, x, y, z0, top, sx=1.0, sy=1.0, layer="rubble"):
    b.box((x - sx / 2, y - sy / 2, z0), (x + sx / 2, y + sy / 2, top), layer, skip=("-z",))
    b.box((x - sx / 2 - 0.08, y - sy / 2 - 0.08, top), (x + sx / 2 + 0.08, y + sy / 2 + 0.08, top + 0.2), layer, skip=("-z",))
    b.box((x - sx / 2 + 0.18, y - sy / 2 + 0.18, top + 0.2), (x + sx / 2 - 0.18, y + sy / 2 - 0.18, top + 0.22), "dark",
          skip=keep("+z"))


def ridge_cap(b, l, ridge, gable_overhang, layer="timber", size=0.22):
    b.beam((0, -l / 2 - gable_overhang, ridge + 0.12), (0, l / 2 + gable_overhang, ridge + 0.12), size, layer)


def thatch_roll(b, l, ridge, over, radius=0.32, segments=6):
    """The rounded ridge roll of a thatched roof (as on the W0 cottages)."""
    y0, y1 = -l / 2 - over - 0.05, l / 2 + over + 0.05
    for i in range(segments):
        a0, a1 = math.pi * i / segments, math.pi * (i + 1) / segments
        p0 = (math.cos(a0) * radius, math.sin(a0) * radius + ridge + 0.1)
        p1 = (math.cos(a1) * radius, math.sin(a1) * radius + ridge + 0.1)
        b.quad((p0[0], y0, p0[1]), (p0[0], y1, p0[1]), (p1[0], y1, p1[1]), (p1[0], y0, p1[1]), "thatch", grain=(0, 1, 0),
               centre=(0, 0, ridge + 0.1))


def pyramid_roof(b, cx, cy, hx, hy, base, apex, layer, soffit="timber"):
    """A four-sided roof from the eave rectangle (half sizes hx, hy at height `base`) to the apex, with a flat soffit."""
    corners = [(cx - hx, cy - hy, base), (cx + hx, cy - hy, base), (cx + hx, cy + hy, base), (cx - hx, cy + hy, base)]
    tip = (cx, cy, apex)
    centre = (cx, cy, base + (apex - base) * 0.25)
    for i in range(4):
        a, c = corners[i], corners[(i + 1) % 4]
        mid = Vector(((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, base))
        b.tri(a, c, tip, layer, grain=tuple((Vector(tip) - mid).normalized()), centre=centre)
    b.quad(*corners, soffit, grain=(0, 1, 0), outward=(0, 0, -1))


def frustum(b, cx, cy, z0, r0, z1, r1, sides, layer, cap=None):
    """A vertical many-sided frustum (kiln cones, bells), optionally closed on top with another layer."""
    ring = lambda r, z: [(cx + r * math.cos(2 * math.pi * (i + 0.5) / sides), cy + r * math.sin(2 * math.pi * (i + 0.5) / sides), z)
                         for i in range(sides)]
    lo, hi = ring(r0, z0), ring(r1, z1)
    for i in range(sides):
        j = (i + 1) % sides
        b.quad(lo[i], lo[j], hi[j], hi[i], layer, grain=UP, centre=(cx, cy, (z0 + z1) / 2))
    if cap:
        for i in range(sides):
            b.tri(hi[i], hi[(i + 1) % sides], (cx, cy, z1), cap, outward=(0, 0, 1))


def band(b, w, l, z, height, layer="ashlar", proud=0.0):
    """A string course or floor band round a w x l rectangle, `proud` beyond it (only above 3 m)."""
    b.box((-w / 2 - proud, -l / 2 - proud, z), (w / 2 + proud, l / 2 + proud, z + height), layer, skip=("+z",))


def door(c, floor, size=DOOR, kind="door"):
    return (c, size[0], floor, floor + size[1], kind)


def window(c, floor, sill=SILL, size=WINDOW, kind="window"):
    return (c, size[0], floor + sill, floor + sill + size[1], kind)


def parapet_gables(b, w, l, eave, ridge, layer, thickness, coping="ashlar"):
    """Gable walls rising 0.4 m above the roof, with a stone coping along each slope and kneelers at the eaves."""
    for s in (-1, 1):
        y_out, y_in = s * l / 2, s * (l / 2 - thickness)
        apex = ridge + 0.4
        b.tri((-w / 2, y_out, eave), (w / 2, y_out, eave), (0, y_out, apex), layer, outward=(0, s, 0))
        b.tri((-w / 2, y_in, eave), (w / 2, y_in, eave), (0, y_in, apex), layer, outward=(0, -s, 0))
        y = s * (l / 2 - thickness / 2)
        for side in (-1, 1):
            b.beam((side * (w / 2 - 0.1), y, eave + 0.45), (0, y, apex + 0.12), thickness + 0.06, coping)
            sorted_box(b, (side * w / 2, y_out, eave - 0.2), (side * (w / 2 - 0.62), y_in, eave + 0.62), coping, skip=("-z",))


def stone_house(spec):
    """One storey and attic in rubble or brick, dressed-stone frames and quoins, a slate roof and gable chimneys."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    plinth, eave, pitch = spec.get("plinth", 0.35), spec["eave"], spec["pitch"]
    wall, roof, frame = spec["walls"], spec["roof"], spec.get("frame", "ashlar")
    t = spec.get("thickness", 0.55)
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, plinth), spec.get("plinth_layer", "rubble"), skip=("-z",))
    openings = {
        "+x": [door(u, plinth) for u in spec.get("doors", [])] + [window(u, plinth) for u in spec.get("windows", [])],
        "-x": [window(u, plinth) for u in spec.get("back_windows", [])],
        "+y": [window(u, plinth) for u in spec.get("gable_windows", [])],
    }
    masonry_walls(b, w, l, plinth, eave, wall, t, openings, frame, quoins=spec.get("quoins", True))
    parapet = spec.get("parapet", False)
    gable_over = -t if parapet else spec.get("gable_overhang", 0.2)
    iw, il = w - 2 * INSET, l - 2 * INSET
    ridge = gabled_roof(b, iw, il, eave, pitch, spec.get("overhang", 0.35), gable_over, roof, 0.16)
    if parapet:
        parapet_gables(b, iw, il, eave, ridge, wall, t, frame)
    else:
        gables(b, iw, il, eave, ridge, wall)
    ridge_cap(b, il, ridge, gable_over, roof, 0.24)
    for cx, cy in spec.get("chimneys", []):
        chimney(b, cx * iw / 2, cy * (il / 2 - 0.45), plinth, ridge + 1.1, 1.1, 0.9, spec.get("chimney", wall))
    return b, ridge + (0.52 if parapet else 0.0)


def two_storey(spec):
    """A masonry ground storey under a jettied, timber-framed upper storey with render or daub infill, steep roof.

    Built with its street front on `front` ("+x": eaves to the street; "+y": gable to the street, then turned to face +X).
    `ground` maps walls to ("door", u[, size]) / ("window", u) entries; `upper` maps walls to window positions.
    """
    b = Builder()
    w, l, front = spec["width"], spec["length"], spec.get("front", "+x")
    plinth, storey = spec.get("plinth", 0.3), spec.get("storey", 3.6)
    floor, eave = plinth + storey, plinth + 2 * storey
    jetty, pitch, t = spec.get("jetty", 0.6), spec["pitch"], spec.get("thickness", 0.5)
    roof, upper_wall = spec["roof"], spec["upper_walls"]
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, plinth), "rubble", skip=("-z",))
    ground = {key: [door(u, plinth, *rest) if kind == "door" else window(u, plinth) for kind, u, *rest in items]
              for key, items in spec["ground"].items()}
    masonry_walls(b, w, l, plinth, floor - 0.3, spec["ground_walls"], t, ground, spec.get("frame", "ashlar"),
                  spec.get("quoins", False))
    along_x = front == "+x"
    uw, ul = (w + jetty, l) if along_x else (w, l + jetty)
    up = Shifted(b, dx=jetty / 2) if along_x else Shifted(b, dy=jetty / 2)
    # The floor band carries the upper storey; under a jetty its soffit and the joist ends show.
    up.box((-uw / 2, -ul / 2, floor - 0.3), (uw / 2, ul / 2, floor), "timber", skip=("+z",))
    if jetty > 0.1:
        span = l if along_x else w
        count = int(span / 0.9)
        for i in range(count):
            u = -span / 2 + (i + 0.5) * span / count
            if along_x:
                sorted_box(b, (w / 2 - 0.05, u - 0.1, floor - 0.52), (w / 2 + jetty - 0.04, u + 0.1, floor - 0.3), "timber",
                           (1, 0, 0), keep("+x", "-z", "+y", "-y"))
            else:
                sorted_box(b, (u - 0.1, l / 2 - 0.05, floor - 0.52), (u + 0.1, l / 2 + jetty - 0.04, floor - 0.3), "timber",
                           (0, 1, 0), keep("+y", "-z", "+x", "-x"))
    upper = {key: [window(u, floor, 1.0) for u in us] for key, us in spec["upper"].items()}
    framed_walls(up, uw, ul, floor, eave, upper_wall, upper, spec.get("spacing", 1.6))
    sin = math.sin(math.radians(pitch))
    if along_x:
        overhang = min(spec.get("overhang", 0.6), 0.78 - jetty + INSET - sin * 0.16)
        gable_over = spec.get("gable_overhang", 0.4)
    else:
        overhang = spec.get("overhang", 0.6)
        gable_over = min(spec.get("gable_overhang", 0.4), 0.78 - jetty)
    ridge = gabled_roof(up, uw - 2 * INSET, ul - 2 * INSET, eave, pitch, overhang, gable_over, roof, 0.16)
    gables(up, uw - 2 * INSET, ul - 2 * INSET, eave, ridge, upper_wall, frame=True)
    ridge_cap(up, ul - 2 * INSET, ridge, gable_over, roof, 0.24)
    for x, y in spec.get("chimneys", []):
        chimney(b, x, y, plinth, ridge + 1.2, 1.1, 0.9, spec.get("chimney", spec["ground_walls"]))
    for key, u in spec.get("hoods", []):
        # A pent hood over a door, under the floor band: a shingle slab above 3 m.
        axis, coord, side, _ = walls(w, l)[key]
        sorted_box(b, wall_point(axis, coord, side, u - 1.1, floor - 0.44, 0.0),
                   wall_point(axis, coord, side, u + 1.1, floor - 0.3, -0.72), "shingle")
    for key, u in spec.get("signs", []):
        # An inn sign: an iron bracket from the upper storey and a blank board hanging above 3 m.
        axis, coord, side, _ = walls(w, l)[key]
        p = lambda uu, z, d: wall_point(axis, coord, side, uu, z, d)
        sorted_box(b, p(u - 0.05, floor + 0.35, 0.0), p(u + 0.05, floor + 0.45, -0.78), "dark")
        sorted_box(b, p(u - 0.04, 3.1, -0.24), p(u + 0.04, floor + 0.3, -0.74), "planks", grain=UP)
    if not along_x:
        rotate(b, -90)
    return b, ridge

def stable(spec):
    """An open-fronted stable: plank back and gable walls, posts and an eave beam on the yard side, stall partitions."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    plinth, eave, pitch, t = 0.25, spec["eave"], spec["pitch"], 0.18
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, plinth), "rubble", skip=("-z",))
    for key in ("-x", "+y", "-y"):
        axis, coord, side, span = walls(w, l)[key]
        wall_cut(b, axis, coord, side, span, plinth, eave, [], "planks", t, outer_only=False)
    sorted_box(b, (-w / 2 + t, -l / 2 + t, plinth), (-w / 2 + t + 0.02, l / 2 - t, eave - 0.25), "dark", skip=keep("+x"))
    bays = spec.get("bays", 4)
    for i in range(bays + 1):
        y = -l / 2 + 0.16 + i * (l - 0.32) / bays
        b.box((w / 2 - 0.32, y - 0.16, plinth), (w / 2, y + 0.16, eave), "timber", skip=("-z", "+z"))
        if 0 < i < bays:
            b.box((-w / 2 + t, y - 0.05, plinth), (w / 2 - 1.8, y + 0.05, plinth + 1.7), "planks", grain=(1, 0, 0), skip=("-z",))
    b.beam((w / 2 - 0.16, -l / 2, eave - 0.16), (w / 2 - 0.16, l / 2, eave - 0.16), 0.32)
    b.beam((-w / 2 + 0.45, -l / 2 + 0.4, plinth + 1.7), (-w / 2 + 0.45, l / 2 - 0.4, plinth + 1.7), 0.14)
    ridge = gabled_roof(b, w, l, eave, pitch, 0.7, 0.4, "shingle", 0.16)
    gables(b, w, l, eave, ridge, "planks")
    ridge_cap(b, l, ridge, 0.4)
    return b, ridge


def yard_wall(length=2.0, height=1.95, thickness=0.6):
    """A 2 m dry-stone yard wall module along Blender Y (game local Z), with an ashlar coping; ends closed."""
    b = Builder()
    core = thickness / 2 - 0.04
    b.box((-core, -length / 2, 0), (core, length / 2, height - 0.22), "rubble", skip=("-z", "+z"))
    b.box((-thickness / 2, -length / 2, height - 0.22), (thickness / 2, length / 2, height), "ashlar", grain=(0, 1, 0))
    return b, height


def chapel(spec):
    """A stone chapel: buttressed nave with lancets and a side door, parapet gables, and a west tower with belfry and spire."""
    b = Builder()
    w, l, tw = spec["width"], spec["length"], spec["tower"]
    buttress = spec.get("buttress", 0.6)
    nw, nl = w - 2 * buttress, l - tw
    plinth, eave, pitch, t = 0.4, spec["eave"], spec["pitch"], 0.6
    stone, roof = spec.get("walls", "ashlar"), spec.get("roof", "slate")
    nave = Shifted(b, dy=-l / 2 + tw + nl / 2)
    nave.box((-nw / 2, -nl / 2, 0), (nw / 2, nl / 2, plinth), "rubble", skip=("-z",))
    bays = spec.get("bays", 3)
    marks = [-nl / 2 + 0.5 + i * (nl - 1.0) / bays for i in range(bays + 1)]
    mids = [(marks[i] + marks[i + 1]) / 2 for i in range(bays)]
    lancet = lambda u, width=0.95: (u, width, plinth + 2.4, eave - 0.5, "lancet")
    openings = {
        "+x": [door(mids[0], plinth, (1.8, 3.3))] + [lancet(u) for u in mids[1:]],
        "-x": [lancet(u) for u in mids],
        "+y": [lancet(-1.1, 0.8), lancet(1.1, 0.8)],
    }
    masonry_walls(nave, nw, nl, plinth, eave, stone, t, openings, "ashlar", quoins=False)
    for s in (-1, 1):
        for u in marks[1:]:
            x_in = s * (nw / 2 - INSET - 0.02)
            sorted_box(nave, (x_in, u - 0.36, 0), (s * w / 2, u + 0.36, 3.3), stone, skip=("-z",))
            sorted_box(nave, (x_in, u - 0.3, 3.3), (s * (nw / 2 + buttress * 0.5), u + 0.3, eave - 0.9), stone, skip=("-z",))
    iw, il = nw - 2 * INSET, nl - 2 * INSET
    ridge = gabled_roof(nave, iw, il, eave, pitch, spec.get("overhang", 0.45), -t, roof, 0.16)
    parapet_gables(nave, iw, il, eave, ridge, stone, t, "ashlar")
    ridge_cap(nave, il, ridge, -t, roof, 0.24)
    # The west tower: plain below, string courses, belfry lancets on all four faces, a slate spire.
    top = spec["tower_top"]
    tower = Shifted(b, dy=-l / 2 + tw / 2)
    tower.box((-tw / 2, -tw / 2, 0), (tw / 2, tw / 2, plinth), "rubble", skip=("-z",))
    belfry = (top - 3.4, top - 1.0)
    t_open = {key: [(0.0, 1.0, belfry[0], belfry[1], "lancet")] for key in ("+x", "-x", "+y", "-y")}
    t_open["+x"] += [(0.0, 0.32, 5.2, 6.6, "slit"), (0.0, 0.32, 9.0, 10.4, "slit")]
    t_open["-y"] += [door(0.0, plinth, (1.6, 3.2)), (0.0, 0.32, 9.0, 10.4, "slit")]
    masonry_walls(tower, tw, tw, plinth, top, stone, 0.7, t_open, "ashlar", quoins=False)
    band(tower, tw - 2 * INSET, tw - 2 * INSET, belfry[0] - 0.6, 0.28, "ashlar", proud=0.12)
    band(tower, tw - 2 * INSET, tw - 2 * INSET, top - 0.3, 0.3, "ashlar", proud=0.14)
    spire = spec.get("spire", 7.0)
    pyramid_roof(tower, 0, 0, tw / 2 + 0.25, tw / 2 + 0.25, top, top + spire, roof)
    return b, top + spire


def fen_chapel(spec):
    """Reed Chapel: a tarred-plank nave on a stone sill under reed thatch, with a timber belfry tower and a hanging bell."""
    b = Builder()
    w, l, tw = spec["width"], spec["length"], spec["tower"]
    nl = l - tw
    plinth, eave, pitch = 0.6, spec["eave"], spec["pitch"]
    nave = Shifted(b, dy=-l / 2 + tw + nl / 2)
    nave.box((-w / 2, -nl / 2, 0), (w / 2, nl / 2, plinth), "rubble", skip=("-z",))
    bays = spec.get("bays", 4)
    mids = [-nl / 2 + (i + 0.5) * nl / bays for i in range(bays)]
    openings = {
        "+x": [door(mids[0], plinth, (1.8, 3.0))] + [window(u, plinth) for u in mids[1:]],
        "-x": [window(u, plinth) for u in mids],
        "+y": [window(0.0, plinth)],
    }
    framed_walls(nave, w, nl, plinth, eave, "tarred", openings, frame=False)
    for sx in (-1, 1):
        for u in mids[:-1]:
            flat_beam(nave, "x", sx * w / 2, sx, (u + nl / bays / 2, plinth), (u + nl / bays / 2, eave), 0.28)
    over = 0.45
    ridge = gabled_roof(nave, w - 2 * INSET, nl - 2 * INSET, eave, pitch, 0.7, over, "thatch", 0.32)
    gables(nave, w - 2 * INSET, nl - 2 * INSET, eave, ridge, "tarred", frame=True)
    thatch_roll(nave, nl - 2 * INSET, ridge, over)
    # Timber belfry: four posts, tarred cladding to the bell stage, an open bell stage with a bell, a shingle cap.
    tower = Shifted(b, dy=-l / 2 + tw / 2)
    h = tw / 2
    clad, stage, cap = spec["clad"], spec["stage"], spec["cap"]
    tower.box((-h, -h, 0), (h, h, plinth), "rubble", skip=("-z",))
    for sx in (-1, 1):
        for sy in (-1, 1):
            sorted_box(tower, (sx * h, sy * h, plinth), (sx * (h - 0.32), sy * (h - 0.32), stage), "timber", skip=("-z", "+z"))
    clad_open = {"-y": [door(0.0, plinth)]}
    for key, (axis, coord, side, span) in walls(tw - 2 * INSET, tw - 2 * INSET).items():
        cuts = [(c, wd, bt, tp) for c, wd, bt, tp, _ in clad_open.get(key, [])]
        wall_cut(tower, axis, coord, side, span, plinth, clad, cuts, "tarred")
    timber_opening(tower, "y", -h, -1, 0.0, DOOR[0], plinth, plinth + DOOR[1], "door")
    tower.box((-h - 0.08, -h - 0.08, clad), (h + 0.08, h + 0.08, clad + 0.25), "planks")
    for key, (axis, coord, side, span) in walls(tw - 0.3, tw - 0.3).items():
        p = (lambda u, z, c=coord, a=axis: (c, u, z) if a == "x" else (u, c, z))
        tower.beam(p(span[0], clad + 1.1), p(span[1], clad + 1.1), 0.16)
        tower.beam(p(span[0], clad + 0.3), p(0.0, stage - 0.2), 0.18)
        tower.beam(p(span[1], clad + 0.3), p(0.0, stage - 0.2), 0.18)
    tower.beam((-h + 0.3, 0, stage - 0.35), (h - 0.3, 0, stage - 0.35), 0.26)
    frustum(tower, 0, 0, stage - 1.55, 0.62, stage - 0.5, 0.3, 8, "dark", cap="dark")
    tower.box((-h - 0.1, -h - 0.1, stage), (h + 0.1, h + 0.1, stage + 0.25), "timber")
    pyramid_roof(tower, 0, 0, h + 0.55, h + 0.55, stage + 0.25, cap, "shingle")
    return b, cap


def smithy(spec):
    """An open-fronted forge: rubble back and side walls, a hearth with a brick hood and stack, posts on the front."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    plinth, eave, pitch, t = 0.3, spec["eave"], spec["pitch"], 0.55
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, plinth), "rubble", skip=("-z",))
    axis, coord, side, span = walls(w - 2 * INSET, l - 2 * INSET)["-x"]
    wall_cut(b, axis, coord, side, span, plinth, eave, [], "rubble", t, outer_only=False)
    for s in (-1, 1):
        wall_cut(b, "y", s * (l / 2 - INSET), s, (-w / 2 + INSET, w / 2 - 1.4), plinth, eave, [], "rubble", t, outer_only=False)
    # Soot: the inner face of the back wall above the hearth.
    sorted_box(b, (-w / 2 + INSET + t, -2.2, plinth + 0.9), (-w / 2 + INSET + t + 0.02, 2.2, eave - 0.2), "dark", skip=keep("+x"))
    for y in (-l / 2 + 0.2, 0.0, l / 2 - 0.2):
        b.box((w / 2 - 0.36, y - 0.18, plinth), (w / 2, y + 0.18, eave), "timber", skip=("-z", "+z"))
    b.beam((w / 2 - 0.18, -l / 2, eave - 0.16), (w / 2 - 0.18, l / 2, eave - 0.16), 0.32)
    x0 = -w / 2 + INSET + t
    b.box((x0, -1.2, plinth), (x0 + 1.9, 1.2, plinth + 0.9), "rubble", skip=("-z",))
    b.box((x0 + 0.25, -0.8, plinth + 0.9), (x0 + 1.5, 0.8, plinth + 0.93), "dark", skip=keep("+z"))
    b.box((x0, -1.1, 2.4), (x0 + 1.8, 1.1, 3.4), "brick", skip=())
    ridge = gabled_roof(b, w - 2 * INSET, l - 2 * INSET, eave, pitch, 0.7, 0.4, "shingle", 0.16)
    gables(b, w - 2 * INSET, l - 2 * INSET, eave, ridge, "planks", frame=True)
    ridge_cap(b, l - 2 * INSET, ridge, 0.4)
    chimney(b, x0 + 0.6, 0.0, 3.4, ridge + 1.4, 1.2, 1.4, "brick")
    return b, ridge + 1.6

def watchtower(spec):
    """A timber watchtower: four posts on stone pads, braced in two tiers, a parapeted deck and a shingle cap."""
    b = Builder()
    s = spec["width"] / 2
    deck, top, apex, post = spec["deck"], spec["top"], spec["apex"], 0.36
    c = s - post / 2
    for sx in (-1, 1):
        for sy in (-1, 1):
            sorted_box(b, (sx * s, sy * s, 0), (sx * (s - 0.72), sy * (s - 0.72), 0.4), "rubble", skip=("-z",))
            sorted_box(b, (sx * s, sy * s, 0.4), (sx * (s - post), sy * (s - post), top), "timber", skip=("-z", "+z"))
    tiers = [0.6, deck / 2, deck - 0.12]
    for key, (axis, coord, side, span) in walls(2 * c, 2 * c).items():
        p = (lambda u, z, cc=coord, a=axis: (cc, u, z) if a == "x" else (u, cc, z))
        for z in tiers[1:]:
            b.beam(p(-c, z), p(c, z), 0.24)
        for z0, z1 in zip(tiers[:-1], tiers[1:]):
            b.beam(p(-c, z0 + 0.1), p(c, z1 - 0.1), 0.2)
            b.beam(p(c, z0 + 0.1), p(-c, z1 - 0.1), 0.2)
    e = s + 0.3
    b.box((-e, -e, deck), (e, e, deck + 0.2), "planks", grain=(1, 0, 0))
    for sx in (-1, 1):
        sorted_box(b, (sx * e, -e, deck + 0.2), (sx * (e - 0.08), e, deck + 1.35), "planks", grain=(0, 1, 0), skip=("-z",))
    for sy in (-1, 1):
        sorted_box(b, (-e + 0.08, sy * e, deck + 0.2), (e - 0.08, sy * (e - 0.08), deck + 1.35), "planks", grain=(1, 0, 0),
                   skip=("-z",))
    for key, (axis, coord, side, span) in walls(2 * c, 2 * c).items():
        p = (lambda u, z, cc=coord, a=axis: (cc, u, z) if a == "x" else (u, cc, z))
        b.beam(p(-s, top - 0.15), p(s, top - 0.15), 0.3)
    pyramid_roof(b, 0, 0, s + 0.72, s + 0.72, top, apex, "shingle")
    # A ladder up the inside of the front (+X) face.
    x = c - 0.45
    for y in (-0.3, 0.3):
        b.beam((x, y, 0.0), (x, y, deck + 0.2), 0.1)
    for i in range(1, 9):
        z = i * deck / 9
        b.beam((x, -0.3, z), (x, 0.3, z), 0.06)
    return b, apex


def stall(spec):
    """A market stall: four posts, a front counter with goods, a plank back board and a sloping plank roof."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    hx, hy = w / 2, l / 2
    front, back = spec["front"], spec["back"]
    for sx, h in ((1, front), (-1, back)):
        for sy in (-1, 1):
            sorted_box(b, (sx * hx, sy * hy, 0), (sx * (hx - 0.16), sy * (hy - 0.16), h), "timber", skip=("-z",))
    sorted_box(b, (hx - 0.75, -hy + 0.16, 0), (hx - 0.05, hy - 0.16, 0.95), "planks", (0, 1, 0), ("-z",))
    sorted_box(b, (hx - 0.85, -hy + 0.1, 0.95), (hx, hy - 0.1, 1.05), "timber", (0, 1, 0), ("-z",))
    sorted_box(b, (-hx + 0.04, -hy + 0.16, 0), (-hx + 0.14, hy - 0.16, back - 0.15), "planks", UP, ("-z",))
    for sy in (-1, 1):
        sorted_box(b, (-hx + 0.14, sy * (hy - 0.04), 0), (hx - 0.85, sy * (hy - 0.12), 1.2), "planks", (1, 0, 0), ("-z",))
    lift = 0.06
    top = [(hx, -hy, front + lift), (hx, hy, front + lift), (-hx, hy, back + lift), (-hx, -hy, back + lift)]
    low = [(x, y, z - 0.08) for x, y, z in top]
    down = (Vector(top[3]) - Vector(top[0])).normalized()
    b.quad(*top, "planks", grain=tuple(-down), outward=(0.2, 0, 1))
    b.quad(*low, "planks", grain=tuple(-down), outward=(-0.2, 0, -1))
    for i in range(4):
        j = (i + 1) % 4
        b.quad(low[i], low[j], top[j], top[i], "planks", grain=UP, centre=(0, 0, (front + back) / 2))
    goods = [((hx - 0.7, -1.3), (0.5, 0.6, 0.4)), ((hx - 0.75, -0.4), (0.45, 0.45, 0.32)), ((hx - 0.7, 0.9), (0.55, 0.7, 0.36)),
             ((-hx + 0.6, 1.2), (0.7, 0.7, 0.7)), ((-hx + 0.6, -1.1), (0.6, 0.6, 0.55))]
    for (x, y), (sx, sy, sz) in goods:
        z0 = 1.05 if x > 0 else 0.0
        b.box((x - sx / 2, y - sy / 2, z0), (x + sx / 2, y + sy / 2, z0 + sz), "planks", skip=("-z",))
    return b, back + lift


def stilt_hut(spec):
    """A fen hut on stilts: a plank deck with a porch, tarred plank walls, a reed-thatch roof and a step ladder."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    hx, hy = w / 2, l / 2
    deck, porch, pitch = spec["deck"], spec["porch"], spec["pitch"]
    x_front = hx - 1.1
    hut_front = x_front - porch
    xs = (-hx + 0.15, (-hx + hut_front) / 2, hut_front, x_front - 0.15)
    ys = (-hy + 0.15, 0.0, hy - 0.15)
    for x in xs:
        for y in ys:
            b.box((x - 0.13, y - 0.13, 0), (x + 0.13, y + 0.13, deck), "timber", skip=("-z", "+z"))
    for x in (xs[0], xs[-1]):
        b.beam((x, ys[0], 0.3), (x, ys[1], deck - 0.1), 0.14)
        b.beam((x, ys[2], 0.3), (x, ys[1], deck - 0.1), 0.14)
    b.box((-hx, -hy, deck), (x_front, hy, deck + 0.2), "planks", grain=(1, 0, 0))
    floor = deck + 0.2
    hw = hut_front + hx
    hut = Shifted(b, dx=(-hx + hut_front) / 2)
    eave = floor + spec["wall"]
    openings = {
        "+x": [door(0.0, floor)],
        "+y": [window(0.0, floor, 1.1)],
        "-y": [window(0.0, floor, 1.1)],
    }
    framed_walls(hut, hw, l, floor, eave, "tarred", openings, frame=False)
    over = 0.45
    ridge = gabled_roof(hut, hw - 2 * INSET, l - 2 * INSET, eave, pitch, 0.75, over, "thatch", 0.32)
    gables(hut, hw - 2 * INSET, l - 2 * INSET, eave, ridge, "tarred")
    thatch_roll(hut, l - 2 * INSET, ridge, over)
    # Porch rail and a steep step ladder down from the porch edge.
    for y in (-hy + 0.1, hy - 0.1):
        b.beam((hut_front, y, floor + 1.0), (x_front - 0.05, y, floor + 1.0), 0.1)
        b.beam((x_front - 0.06, y, floor), (x_front - 0.06, y, floor + 1.05), 0.1)
    for y in (0.85, 1.75):
        b.beam((x_front - 0.05, y, floor), (hx - 0.08, y, 0.07), 0.12)
    for i in range(1, 6):
        f = i / 6
        x = x_front - 0.05 + (hx - 0.08 - (x_front - 0.05)) * (1 - f)
        b.box((x - 0.12, 0.85, floor * f - 0.04), (x + 0.12, 1.75, floor * f), "planks", grain=(0, 1, 0), skip=("-z",))
    return b, ridge + 0.42


def salt_shed(spec):
    """A coast salt store: tarred plank walls on a salt-crusted base, two big doors, a steep roof with a ridge vent."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    plinth, eave, pitch = 0.5, spec["eave"], spec["pitch"]
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, plinth), "lime", skip=("-z",))
    openings = {"+x": [door(u, plinth, (2.4, 2.8)) for u in spec["doors"]], "-y": [window(0.0, plinth)]}
    framed_walls(b, w, l, plinth, eave, "tarred", openings, frame=False)
    for u in spec["posts"]:
        for sx in (-1, 1):
            flat_beam(b, "x", sx * w / 2, sx, (u, plinth), (u, eave), 0.28)
    over = 0.4
    iw, il = w - 2 * INSET, l - 2 * INSET
    # A low eave: the overhang stays short so the roof edge keeps above 3 m.
    ridge = gabled_roof(b, iw, il, eave, pitch, 0.4, over, "shingle", 0.16)
    gables(b, iw, il, eave, ridge, "tarred", frame=True)
    ridge_cap(b, il, ridge, over, "timber", 0.24)
    b.box((-0.4, -il / 2 + 2.0, ridge - 0.1), (0.4, il / 2 - 2.0, ridge + 0.45), "dark", skip=("-z", "+z"))
    cap = gabled_roof(b, 0.8, il - 4.0, ridge + 0.45, 35, 0.25, 0.15, "shingle", 0.1)
    ridge_cap(b, il - 4.0, cap, 0.15, "timber", 0.14)
    return b, cap + 0.2


def boat_hut(spec):
    """An upturned boat hull for a roof on curved fieldstone walls, a plank end with a door and a stove pipe."""
    b = Builder()
    w, l = spec["width"], spec["length"]
    hx, hy = w / 2 - 0.02, l / 2 - 0.25
    low, keel = spec["low"], spec["keel"]
    stations, segments, n = 13, 10, 1.5

    def section(y):
        # Upturned, the hull narrows towards bow and stern and its sheer and keel both dip there.
        f = abs(y) / hy
        return hx * (1 - 0.7 * f ** 2.4), low - 0.55 * f ** 2.2, keel - 0.7 * f ** 2.5

    def point(a, g, k, y, j):
        t = math.pi * j / segments
        c, s = math.cos(t), math.sin(t)
        # A superellipse section (n < 2) gives the hull a keel line instead of a drum.
        return (a * math.copysign(abs(c) ** (2 / n), c), y, g + (k - g) * abs(s) ** (2 / n))

    ys = [-hy + i * 2 * hy / (stations - 1) for i in range(stations)]
    rings = [[point(*section(y), y, j) for j in range(segments + 1)] for y in ys]
    for i in range(stations - 1):
        for j in range(segments):
            p0, p1, p2, p3 = rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1]
            mid_y = (p0[1] + p1[1]) / 2
            a, g, k = section(mid_y)
            b.quad(p0, p1, p2, p3, "tarred", grain=(0, 1, 0), centre=(0, mid_y, g))
    # Curved fieldstone walls under both gunwales.
    for side in (0, segments):
        for i in range(stations - 1):
            q0, q1 = rings[i][side], rings[i + 1][side]
            outward = (1, 0, 0) if side == 0 else (-1, 0, 0)
            b.quad((q0[0], q0[1], 0.0), (q1[0], q1[1], 0.0), q1, q0, "rubble", grain=UP, outward=outward)
    # Plank ends: the +Y end has the door, the -Y end is closed.
    for s, ring in ((1, rings[-1]), (-1, rings[0])):
        a = ring[0][0]
        points = [(-a, ring[0][1], 0.0), (a, ring[0][1], 0.0)] + list(ring)
        b._face(points, "tarred", UP, (0, s, 0))
        if s < 0:
            b.beam((0, ring[0][1] - 0.06, 0.0), (0, ring[0][1] - 0.06, ring[segments // 2][2] + 0.3), 0.18)
    y_end = rings[-1][0][1]
    door_w, door_h = DOOR
    b.box((-door_w / 2, y_end, 0.0), (door_w / 2, y_end + 0.06, door_h), "planks", UP, keep("+y"))
    for x in (-door_w / 2 - 0.08, door_w / 2 + 0.08):
        b.beam((x, y_end + 0.08, 0.0), (x, y_end + 0.08, door_h + 0.12), 0.16)
    b.beam((-door_w / 2 - 0.16, y_end + 0.08, door_h + 0.08), (door_w / 2 + 0.16, y_end + 0.08, door_h + 0.08), 0.16)
    # Keel and stove pipe.
    for i in range(0, stations - 1, 3):
        j = min(i + 3, stations - 1)
        p, q = rings[i][segments // 2], rings[j][segments // 2]
        b.beam((0, p[1], p[2] + 0.06), (0, q[1], q[2] + 0.06), 0.2)
    b.beam((0.9, -2.6, keel - 1.0), (0.9, -2.6, keel + 1.0), 0.22, "dark")
    return b, keel + 1.0


def kiln(spec):
    """A glass furnace for the Ash Steppe: a brick base with a stoke arch and a tall tapering brick cone."""
    b = Builder()
    w, base, top = spec["width"], spec["base"], spec["top"]
    t = 0.7
    openings = {"+x": [(0.0, 1.3, 0.3, 1.9, "slit")], "-x": [(0.0, 0.9, 0.3, 1.3, "slit")]}
    b.box((-w / 2, -w / 2, 0), (w / 2, w / 2, 0.3), "rubble", skip=("-z",))
    masonry_walls(b, w, w, 0.3, base, "brick", t, openings, "ashlar", quoins=True, course=0.48)
    band(b, w - 2 * INSET, w - 2 * INSET, base, 0.3, "ashlar", proud=0.04)
    b.box((-w / 2 + INSET, -w / 2 + INSET, base + 0.3), (w / 2 - INSET, w / 2 - INSET, base + 0.32), "brick", skip=keep("+z"))
    r0 = w / 2 - 0.4
    frustum(b, 0, 0, base + 0.3, r0, top, 1.05, 12, "brick")
    frustum(b, 0, 0, top, 1.25, top + 0.45, 1.25, 12, "brick", cap="dark")
    frustum(b, 0, 0, base + 2.4, r0 - 0.22, base + 2.7, r0 - 0.25, 12, "ashlar")
    return b, top + 0.45


BUILDINGS = {
    "kit-stonehouse": dict(kind="stone", width=7.0, length=10.0, eave=4.1, pitch=48, walls="rubble", roof="slate",
                           doors=[1.3], windows=[-2.3, 3.5], back_windows=[0.0], gable_windows=[0.0],
                           chimneys=[(0.0, 1)], overhang=0.35, gable_overhang=0.2),
    "kit-brickhouse": dict(kind="stone", width=7.5, length=11.0, eave=4.3, pitch=42, walls="brick", roof="slate", parapet=True,
                           doors=[-1.6], windows=[1.2, 3.6, -3.9], back_windows=[-2.0, 2.0], gable_windows=[],
                           chimneys=[(0.0, -1), (0.0, 1)], overhang=0.3),
    "kit-townhouse-a": dict(kind="two", width=7.5, length=11.0, front="+x", jetty=0.6, pitch=55, roof="slate",
                            ground_walls="ashlar", upper_walls="lime", chimney="brick",
                            ground={"+x": [("door", -3.0), ("window", 0.4), ("window", 3.0)], "-x": [("window", -2.0), ("window", 2.4)],
                                    "+y": [("window", 0.0)]},
                            upper={"+x": [-3.6, -1.2, 1.2, 3.6], "-x": [-2.2, 2.2], "+y": [0.3], "-y": [0.3]},
                            chimneys=[(-1.6, 4.6)]),
    "kit-townhouse-b": dict(kind="two", width=7.5, length=10.5, front="+y", jetty=0.6, pitch=56, roof="shingle",
                            ground_walls="rubble", upper_walls="daub", frame="ashlar",
                            ground={"+y": [("door", -1.7), ("window", 1.7)], "+x": [("window", -2.6), ("window", 2.2)],
                                    "-x": [("window", 0.0)]},
                            upper={"+y": [-1.7, 1.7], "+x": [-2.8, 0.0, 2.8], "-x": [-1.6, 1.6]},
                            chimneys=[(2.1, -3.2)]),
    "kit-inn": dict(kind="two", width=10.0, length=20.0, front="+x", jetty=0.0, pitch=50, roof="shingle", plinth=0.4,
                    ground_walls="rubble", upper_walls="daub", spacing=1.8,
                    ground={"+x": [("door", -1.2, (2.2, 2.9)), ("window", -7.4), ("window", -4.4), ("window", 2.4),
                                   ("window", 5.2), ("window", 7.9)],
                            "-x": [("door", 5.4), ("window", -6.4), ("window", -2.2), ("window", 1.6)],
                            "+y": [("window", -2.2), ("window", 2.2)], "-y": [("window", 0.0)]},
                    upper={"+x": [-7.8, -5.2, -2.6, 0.2, 3.0, 5.6, 8.2], "-x": [-6.5, -2.5, 1.5, 5.5], "+y": [0.0], "-y": [0.0]},
                    chimneys=[(-1.4, -6.2), (-1.4, 6.2)], hoods=[("+x", -1.2)], signs=[("+x", -3.1)]),
    "kit-stable": dict(kind="stable", width=6.0, length=14.0, eave=3.6, pitch=38, bays=4),
    "kit-chapel": dict(kind="chapel", width=8.6, length=22.0, tower=5.4, eave=6.2, pitch=55, tower_top=15.4, spire=7.0, bays=3),
    "kit-chapel-fen": dict(kind="fen-chapel", width=7.5, length=18.0, tower=4.5, eave=4.6, pitch=55, clad=8.4, stage=11.2, cap=15.2,
                           bays=4),
    "kit-smithy": dict(kind="smithy", width=8.0, length=10.0, eave=3.8, pitch=38),
    "kit-watchtower": dict(kind="watchtower", width=5.0, deck=9.4, top=12.0, apex=14.6),
    "kit-stall": dict(kind="stall", width=2.6, length=4.0, front=2.6, back=3.1),
    "kit-stilthut": dict(kind="stilthut", width=6.5, length=8.0, deck=1.7, porch=1.2, wall=3.1, pitch=52),
    "kit-saltshed": dict(kind="saltshed", width=7.0, length=14.0, eave=3.6, pitch=52, doors=[-3.4, 3.4], posts=[-5.0, 0.0, 5.0]),
    "kit-boathut": dict(kind="boathut", width=6.0, length=12.0, low=1.5, keel=4.0),
    "kit-kiln": dict(kind="kiln", width=6.5, base=3.4, top=11.0),
}
BUILDERS = {"stone": stone_house, "two": two_storey, "stable": stable, "chapel": chapel, "fen-chapel": fen_chapel,
            "smithy": smithy, "watchtower": watchtower, "stall": stall, "stilthut": stilt_hut, "saltshed": salt_shed,
            "boathut": boat_hut, "kiln": kiln}


def footprint(spec):
    """The collider rectangle (width along X, length along Z) of the finished, turned model."""
    w, l = spec.get("width"), spec.get("length", spec.get("width"))
    return [l, w] if spec.get("front") == "+y" else [w, l]


def build(name, spec):
    builder, top = yard_wall() if spec["kind"] == "wall" else BUILDERS[spec["kind"]](spec)
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
    items = dict(BUILDINGS)
    items["kit-wall"] = dict(kind="wall", width=0.6, length=2.0)
    for name, spec in items.items():
        if args.only and name not in args.only:
            continue
        obj, top = build(name, spec)
        bake_ao(obj, args.samples)
        path = args.out / f"{name}.glb"
        export(obj, path)
        report["assets"][name] = {"triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons), "vertices": len(obj.data.vertices),
                                 "top": top, "bounds": bounds(obj), "footprint": footprint(spec), "file": path.name,
                                 "bytes": path.stat().st_size}
        bpy.data.objects.remove(obj, do_unlink=True)
    (args.out / "kit-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({name: {k: v for k, v in a.items() if k in ("triangles", "bytes", "top")} for name, a in report["assets"].items()}))


if __name__ == "__main__":
    main()