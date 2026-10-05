"""Korovany II world kit: scripted Blender 5.2 buildings at the heroic scale standard (W0 timber kit).

Each building is one mesh with one placeholder material. UV0 is a world-scale planar mapping (metres divided by the
surface's physical texture size, grain-aligned for timber, thatch and planks); UV1.x is the surface layer index into the
game's texture array (+0.5) and UV1.y, as glTF and three.js read it, a baked ambient-occlusion factor (the glTF exporter
stores V as 1 - v, so Blender holds 1 - AO). Walls and everything below 3 m stay inside the
footprint rectangle the v3 generator collides with (width along local X, the front facing +X; length along Z); only
eaves and roofs above 3 m overhang, by at most 0.8 m. Exported +Y up (glTF), so local Z = -Blender Y.

    blender -b --factory-startup --python build_kit.py -- --out <dir> [--only kit-cottage-a ...]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

LAYERS = ["daub", "timber", "thatch", "shingle", "rubble", "planks", "dark"]
TILE = {"daub": 2.0, "timber": 1.0, "thatch": 2.0, "shingle": 2.0, "rubble": 2.0, "planks": 2.0, "dark": 1.0}
DOOR = (1.3, 2.8)
WINDOW = (0.8, 1.1)
SILL = 1.3
# Plan section 4: roof eaves overhang the collider by at most 0.8 m (kept a little inside it).
MAX_EAVE = 0.78
UP = Vector((0, 0, 1))


class Builder:
    """Accumulates boxes and prisms into one bmesh with layer and grain-aligned world-scale UVs."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.layer_uv = self.bm.loops.layers.uv.new("Layer")

    def _face(self, points, layer, grain=None, outward=None):
        """`outward` (required) is any vector on the visible side; the winding is flipped to face it."""
        normal = (Vector(points[1]) - Vector(points[0])).cross(Vector(points[2]) - Vector(points[1]))
        if normal.length < 1e-9:
            normal = (Vector(points[2]) - Vector(points[0])).cross(Vector(points[3 % len(points)]) - Vector(points[1]))
        normal.normalize()
        if outward is None:
            raise ValueError("every kit face needs an outward hint")
        if normal.dot(Vector(outward)) < 0:
            points = list(reversed(points))
            normal = -normal
        verts = [self.bm.verts.new(p) for p in points]
        face = self.bm.faces.new(verts)
        g = Vector(grain) if grain is not None else UP
        v = g - normal * g.dot(normal)
        if v.length < 0.2:
            v = Vector((1, 0, 0)) - normal * normal.x
            if v.length < 0.2:
                v = Vector((0, 1, 0)) - normal * normal.y
        v.normalize()
        u = v.cross(normal)
        tile = TILE[layer]
        index = LAYERS.index(layer)
        for loop in face.loops:
            p = loop.vert.co
            loop[self.uv].uv = (p.dot(u) / tile, p.dot(v) / tile)
            loop[self.layer_uv].uv = (index + 0.5, 0.0)
        return face

    @staticmethod
    def _out(points, outward, centre):
        if outward is not None:
            return outward
        if centre is None:
            raise ValueError("every kit face needs an outward hint or the centre of its closed piece")
        mid = sum((Vector(p) for p in points), Vector()) / len(points)
        return mid - Vector(centre)

    def quad(self, a, b, c, d, layer, grain=None, outward=None, centre=None):
        return self._face([a, b, c, d], layer, grain, self._out([a, b, c, d], outward, centre))

    def tri(self, a, b, c, layer, grain=None, outward=None, centre=None):
        return self._face([a, b, c], layer, grain, self._out([a, b, c], outward, centre))

    def box(self, lo, hi, layer, grain=None, skip=()):
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        centre = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        faces = {
            "+x": [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
            "-x": [(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)],
            "+y": [(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)],
            "-y": [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
            "+z": [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
            "-z": [(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)],
        }
        for key, points in faces.items():
            if key not in skip:
                self.quad(*points, layer, grain, centre=centre)

    def beam(self, a, b, size, layer="timber"):
        """A square-section timber from a to b (grain along it)."""
        a, b = Vector(a), Vector(b)
        axis = b - a
        length = axis.length
        d = axis.normalized()
        side = d.cross(UP)
        if side.length < 1e-3:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(d).normalized()
        h = size / 2
        centre = (a + b) / 2
        corners = [a + side * sx * h + up * sz * h for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        ends = [p + d * length for p in corners]
        for i in range(4):
            j = (i + 1) % 4
            self.quad(corners[i], corners[j], ends[j], ends[i], layer, grain=d, centre=centre)
        self.quad(corners[3], corners[2], corners[1], corners[0], layer, grain=up, centre=centre)
        self.quad(ends[0], ends[1], ends[2], ends[3], layer, grain=up, centre=centre)

    def finish(self, name):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for polygon in mesh.polygons:
            polygon.use_smooth = False
        return mesh


def wall_with_openings(b, axis, coord, side, span, z0, z1, openings, layer, thickness, frame=None):
    """A wall slab in the plane axis=coord (axis 'x' or 'y'), outer face on the footprint, split around openings.

    `span` is (min, max) along the wall, `openings` a list of (centre, width, bottom, top) in wall coordinates.
    `side` is +1 when the outer face looks toward +axis.
    """
    def piece(u0, u1, w0, w1, lay):
        if u1 - u0 < 1e-3 or w1 - w0 < 1e-3:
            return
        outer, inner = coord, coord - side * thickness
        lo_n, hi_n = min(outer, inner), max(outer, inner)
        if axis == "x":
            b.box((lo_n, u0, w0), (hi_n, u1, w1), lay)
        else:
            b.box((u0, lo_n, w0), (u1, hi_n, w1), lay)

    cuts = sorted(openings)
    u = span[0]
    for centre, width, bottom, top in cuts:
        left, right = centre - width / 2, centre + width / 2
        piece(u, left, z0, z1, layer)
        piece(left, right, z0, bottom, layer)
        piece(left, right, top, z1, layer)
        u = right
    piece(u, span[1], z0, z1, layer)


def opening_details(b, axis, coord, side, centre, width, bottom, top, kind, inset=0.12):
    """Frame (jambs, lintel, sill) flush with the outer face and an inset leaf: a plank door or closed shutters."""
    def p(u, w, d):
        # d: depth inward from the outer face
        n = coord - side * d
        return (n, u, w) if axis == "x" else (u, n, w)

    f = 0.14
    jamb_lo, jamb_hi = 0.0, 0.18
    for u0, u1 in ((centre - width / 2 - f, centre - width / 2), (centre + width / 2, centre + width / 2 + f)):
        lo, hi = p(u0, bottom, jamb_hi), p(u1, top + f, jamb_lo)
        b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), "timber")
    lo, hi = p(centre - width / 2 - f, top, jamb_hi), p(centre + width / 2 + f, top + f, jamb_lo)
    b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), "timber", grain=(0, 1, 0) if axis == "x" else (1, 0, 0))
    if kind == "window":
        lo, hi = p(centre - width / 2 - f * 1.4, bottom - 0.1, 0.24), p(centre + width / 2 + f * 1.4, bottom, -0.0)
        b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), "timber", grain=(0, 1, 0) if axis == "x" else (1, 0, 0))
    # Dark reveal behind the leaf, then the leaf itself.
    lo, hi = p(centre - width / 2, bottom, 0.3), p(centre + width / 2, top, 0.28)
    b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), "dark")
    leaf = "planks"
    if kind == "door":
        lo, hi = p(centre - width / 2 + 0.02, bottom, inset + 0.06), p(centre + width / 2 - 0.02, top - 0.02, inset)
        b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), leaf, grain=UP)
        # Iron strap hinges read as two dark bands.
        for h in (bottom + 0.5, top - 0.6):
            lo, hi = p(centre - width / 2 + 0.05, h, inset - 0.01), p(centre + width / 2 - 0.25, h + 0.08, inset)
            b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), "dark")
    else:
        half = width / 2
        for u0, u1 in ((centre - half + 0.02, centre - 0.01), (centre + 0.01, centre + half - 0.02)):
            lo, hi = p(u0, bottom + 0.02, inset + 0.05), p(u1, top - 0.02, inset)
            b.box(tuple(map(min, lo, hi)), tuple(map(max, lo, hi)), leaf, grain=UP)


def gabled_roof(b, w, l, eave, pitch, overhang, gable_overhang, layer, thickness):
    """Two slabs from the eaves (overhang beyond the walls) to the ridge along Blender Y, plus a ridge cap."""
    # The slab's outer top edge stands out by the overhang plus its thickness across the slope; keep it within MAX_EAVE.
    overhang = min(overhang, MAX_EAVE - math.sin(math.radians(pitch)) * thickness)
    half = w / 2 + overhang
    rise = (w / 2) * math.tan(math.radians(pitch))
    ridge = eave + rise
    y0, y1 = -l / 2 - gable_overhang, l / 2 + gable_overhang
    drop = overhang * math.tan(math.radians(pitch))
    t = thickness
    nz = math.cos(math.radians(pitch))
    nx = math.sin(math.radians(pitch))
    for s in (-1, 1):
        eave_out = Vector((s * half, 0, eave - drop))
        top = Vector((0, 0, ridge))
        normal = Vector((s * nx, 0, nz))
        a0, a1 = eave_out + normal * t, top + normal * t
        slope = (eave_out - top).normalized()
        centre = (eave_out + top + a0 + a1) / 4
        b.quad((a1.x, y0, a1.z), (a0.x, y0, a0.z), (a0.x, y1, a0.z), (a1.x, y1, a1.z), layer, grain=-slope, outward=normal)
        b.quad((eave_out.x, y0, eave_out.z), (top.x, y0, top.z), (top.x, y1, top.z), (eave_out.x, y1, eave_out.z), "timber",
               grain=(0, 1, 0), outward=-normal)
        b.quad((a0.x, y0, a0.z), (eave_out.x, y0, eave_out.z), (eave_out.x, y1, eave_out.z), (a0.x, y1, a0.z), layer,
               grain=(0, 1, 0), centre=centre)
        for y in (y0, y1):
            pts = [(eave_out.x, y, eave_out.z), (a0.x, y, a0.z), (a1.x, y, a1.z), (top.x, y, top.z)]
            b.quad(*pts, layer, grain=UP, outward=(0, y, 0))
    return ridge


def gable_infill(b, w, l, eave, ridge, layer, thickness, frame=True):
    for s in (-1, 1):
        y_out = s * l / 2
        y_in = y_out - s * thickness
        b.tri((-w / 2, y_out, eave), (w / 2, y_out, eave), (0, y_out, ridge - 0.05), layer, outward=(0, s, 0))
        b.tri((-w / 2, y_in, eave), (w / 2, y_in, eave), (0, y_in, ridge - 0.05), layer, outward=(0, -s, 0))
        if frame:
            y = y_out - s * 0.06
            b.beam((-w / 2 + 0.15, y, eave + 0.05), (w / 2 - 0.15, y, eave + 0.05), 0.2)
            b.beam((0, y, eave + 0.1), (0, y, ridge - 0.25), 0.18)
            collar = eave + (ridge - eave) * 0.45
            span = (w / 2) * (1 - 0.45)
            b.beam((-span, y, collar), (span, y, collar), 0.16)


def timber_frame(b, w, l, z0, z1, openings_by_wall, spacing=1.3):
    """Posts, sill, rail, plate and braces flush with the footprint; panels between them are the inset daub wall."""
    size = 0.26
    walls = {
        "+x": ("x", w / 2, 1, (-l / 2, l / 2)),
        "-x": ("x", -w / 2, -1, (-l / 2, l / 2)),
        "+y": ("y", l / 2, 1, (-w / 2, w / 2)),
        "-y": ("y", -l / 2, -1, (-w / 2, w / 2)),
    }
    rail = z0 + (z1 - z0) * 0.48
    for key, (axis, coord, side, span) in walls.items():
        n = coord - side * size / 2
        point = (lambda u, z, n=n, axis=axis: (n, u, z) if axis == "x" else (u, n, z))
        b.beam(point(span[0], z0 + size / 2), point(span[1], z0 + size / 2), size)
        b.beam(point(span[0], z1 - size / 2), point(span[1], z1 - size / 2), size)
        openings = openings_by_wall.get(key, [])
        blocked = lambda u: any(c - wd / 2 - 0.2 < u < c + wd / 2 + 0.2 for c, wd, _, _ in openings)
        count = max(2, round((span[1] - span[0]) / spacing))
        posts = [span[0] + size / 2 + i * (span[1] - span[0] - size) / count for i in range(count + 1)]
        for u in posts:
            if blocked(u) and u not in (posts[0], posts[-1]):
                continue
            b.beam(point(u, z0 + size), point(u, z1 - size), size)
        for c, wd, bottom, top in openings:
            for u in (c - wd / 2 - 0.2, c + wd / 2 + 0.2):
                b.beam(point(u, z0 + size), point(u, z1 - size), size * 0.9)
        # Rail segments between openings, and a brace at each end of the wall.
        u = span[0] + size
        for c, wd, bottom, top in sorted(openings):
            left = c - wd / 2 - 0.3
            if left - u > 0.4:
                b.beam(point(u, rail), point(left, rail), size * 0.8)
            u = c + wd / 2 + 0.3
        if span[1] - size - u > 0.4:
            b.beam(point(u, rail), point(span[1] - size, rail), size * 0.8)
        for end in (0, 1):
            corner = span[0] + size if end == 0 else span[1] - size
            towards = 1 if end == 0 else -1
            if not blocked(corner + towards * 1.2):
                b.beam(point(corner, z0 + size), point(corner + towards * 1.3, rail), size * 0.7)


def chimney(b, x, y, z0, top, size=1.0):
    b.box((x - size / 2, y - size / 2, z0), (x + size / 2, y + size / 2, top), "rubble")
    b.box((x - size / 2 - 0.08, y - size / 2 - 0.08, top), (x + size / 2 + 0.08, y + size / 2 + 0.08, top + 0.18), "rubble")
    b.box((x - size / 2 + 0.2, y - size / 2 + 0.2, top + 0.18), (x + size / 2 - 0.2, y + size / 2 - 0.2, top + 0.2), "dark")


def house(spec):
    b = Builder()
    w, l = spec["width"], spec["length"]
    plinth, eave, pitch = spec.get("plinth", 0.45), spec["eave"], spec["pitch"]
    wall_layer = spec.get("walls", "daub")
    t = 0.3
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, plinth), "rubble")
    openings = {}
    front = []
    for u in spec.get("doors", []):
        front.append((u, DOOR[0], plinth, plinth + DOOR[1]))
    for u in spec.get("windows", []):
        front.append((u, WINDOW[0], plinth + SILL, plinth + SILL + WINDOW[1]))
    if spec.get("barn_door"):
        width, height = spec["barn_door"]
        front.append((0.0, width, plinth, plinth + height))
    openings["+x"] = front
    back = [(u, WINDOW[0], plinth + SILL, plinth + SILL + WINDOW[1]) for u in spec.get("back_windows", [])]
    openings["-x"] = back
    gable_windows = spec.get("gable_windows", [])
    openings["+y"] = [(u, WINDOW[0], plinth + SILL, plinth + SILL + WINDOW[1]) for u in gable_windows]
    inset = 0.05 if wall_layer == "daub" else 0.0
    for key, (axis, coord, side, span) in {
        "+x": ("x", w / 2 - inset, 1, (-l / 2 + inset, l / 2 - inset)),
        "-x": ("x", -w / 2 + inset, -1, (-l / 2 + inset, l / 2 - inset)),
        "+y": ("y", l / 2 - inset, 1, (-w / 2 + inset, w / 2 - inset)),
        "-y": ("y", -l / 2 + inset, -1, (-w / 2 + inset, w / 2 - inset)),
    }.items():
        wall_with_openings(b, axis, coord, side, span, plinth, eave, openings.get(key, []), wall_layer, t)
        for c, width, bottom, top in openings.get(key, []):
            kind = "door" if bottom <= plinth + 0.01 else "window"
            opening_details(b, axis, w / 2 if axis == "x" and side > 0 else -w / 2 if axis == "x" else side * l / 2,
                            side, c, width, bottom, top, kind)
    if wall_layer == "daub":
        timber_frame(b, w, l, plinth, eave, openings)
    else:
        for x in (-w / 2, w / 2):
            for y in (-l / 2, l / 2):
                sx, sy = (1 if x > 0 else -1), (1 if y > 0 else -1)
                b.box((x - sx * 0.3 if sx > 0 else x, y - sy * 0.3 if sy > 0 else y, plinth),
                      (x if sx > 0 else x + 0.3, y if sy > 0 else y + 0.3, eave), "timber")
        b.beam((w / 2 - 0.13, -l / 2, eave - 0.13), (w / 2 - 0.13, l / 2, eave - 0.13), 0.26)
        b.beam((-w / 2 + 0.13, -l / 2, eave - 0.13), (-w / 2 + 0.13, l / 2, eave - 0.13), 0.26)
    roof = spec["roof"]
    ridge = gabled_roof(b, w, l, eave, pitch, spec.get("overhang", 0.6), spec.get("gable_overhang", 0.45), roof,
                        0.32 if roof == "thatch" else 0.16)
    gable_infill(b, w, l, eave, ridge, "planks" if wall_layer == "planks" else "daub", t, frame=wall_layer != "planks")
    if roof == "thatch":
        segments = 8
        radius = 0.32
        for i in range(segments):
            a0, a1 = math.pi * i / segments, math.pi * (i + 1) / segments
            p0 = (math.cos(a0) * radius, math.sin(a0) * radius + ridge + 0.1)
            p1 = (math.cos(a1) * radius, math.sin(a1) * radius + ridge + 0.1)
            y0, y1 = -l / 2 - spec.get("gable_overhang", 0.45) - 0.05, l / 2 + spec.get("gable_overhang", 0.45) + 0.05
            b.quad((p0[0], y0, p0[1]), (p0[0], y1, p0[1]), (p1[0], y1, p1[1]), (p1[0], y0, p1[1]), "thatch", grain=(0, 1, 0),
                   centre=(0, 0, ridge + 0.1))
    else:
        b.beam((0, -l / 2 - spec.get("gable_overhang", 0.45), ridge + 0.12),
               (0, l / 2 + spec.get("gable_overhang", 0.45), ridge + 0.12), 0.22)
    for cx, cy in spec.get("chimneys", []):
        chimney(b, cx * w / 2, cy * l / 2, plinth, ridge + 1.0)
    for porch in spec.get("porches", []):
        y = porch
        b.box((w / 2 - 0.05, y - 1.1, eave - 1.0), (w / 2 + 0.75, y + 1.1, eave - 0.85), "shingle")
    return b, ridge


def shed(spec):
    b = Builder()
    w, l = spec["width"], spec["length"]
    low, high = spec["eave"], spec["ridge"]
    b.box((-w / 2, -l / 2, 0), (w / 2, l / 2, 0.25), "rubble")
    t = 0.18
    door = (0.0, DOOR[0], 0.25, 0.25 + DOOR[1] - 0.2)
    wall_with_openings(b, "x", w / 2, 1, (-l / 2, l / 2), 0.25, high, [door], "planks", t)
    wall_with_openings(b, "x", -w / 2, -1, (-l / 2, l / 2), 0.25, low, [], "planks", t)
    opening_details(b, "x", w / 2, 1, door[0], door[1], door[2], door[3], "door")
    for s in (-1, 1):
        y_out = s * l / 2
        y_in = y_out - s * t
        pts = [(-w / 2, y_out, 0.25), (w / 2, y_out, 0.25), (w / 2, y_out, high), (-w / 2, y_out, low)]
        pts_in = [(p[0], y_in, p[2]) for p in pts]
        b.quad(*pts, "planks", outward=(0, s, 0))
        b.quad(*pts_in, "planks", outward=(0, -s, 0))
    over = 0.5
    rise = (high - low) / w
    a = Vector((-w / 2 - over, 0, low - over * rise))
    c = Vector((w / 2 + over, 0, high + over * rise))
    top = [(a.x, -l / 2 - 0.35, a.z + 0.12), (c.x, -l / 2 - 0.35, c.z + 0.12), (c.x, l / 2 + 0.35, c.z + 0.12), (a.x, l / 2 + 0.35, a.z + 0.12)]
    bottom = [(p[0], p[1], p[2] - 0.12) for p in top]
    centre = (a + c) / 2
    b.quad(*top, "shingle", grain=(-(c - a)).normalized(), outward=UP)
    b.quad(*bottom, "timber", grain=(0, 1, 0), outward=-UP)
    for i in range(4):
        j = (i + 1) % 4
        b.quad(bottom[i], bottom[j], top[j], top[i], "shingle", grain=UP, centre=centre)
    for y in (-l / 2 + 0.1, l / 2 - 0.1):
        for x, z in ((-w / 2 + 0.1, low), (w / 2 - 0.1, high)):
            b.box((x - 0.1, y - 0.1, 0.25), (x + 0.1, y + 0.1, z), "timber")
    return b, high


def fence_module(length=2.0, height=1.3):
    """A 2 m pale fence module along Blender Y (game local Z), 0.24 m thick, centred."""
    b = Builder()
    for y in (-length / 2 + 0.07, length / 2 - 0.07):
        b.box((-0.07, y - 0.07, 0), (0.07, y + 0.07, height + 0.15), "timber")
    for z in (0.35, height - 0.25):
        b.beam((0.05, -length / 2, z), (0.05, length / 2, z), 0.08)
    count = 11
    for i in range(count):
        y = -length / 2 + (i + 0.5) * length / count
        top = height - 0.06 * ((i * 7) % 3)
        b.box((-0.12, y - 0.075, 0.02), (-0.04, y + 0.075, top), "timber", skip=("+z",))
        b.tri((-0.12, y - 0.075, top), (-0.12, y + 0.075, top), (-0.12, y, top + 0.12), "timber", outward=(-1, 0, 0))
        b.tri((-0.04, y + 0.075, top), (-0.04, y - 0.075, top), (-0.04, y, top + 0.12), "timber", outward=(1, 0, 0))
        for s in (-1, 1):
            b.quad((-0.12, y + s * 0.075, top), (-0.04, y + s * 0.075, top), (-0.04, y, top + 0.12), (-0.12, y, top + 0.12),
                   "timber", outward=(0, s, 0.6))
    return b, height + 0.15


BUILDINGS = {
    "kit-cottage-a": dict(kind="house", width=6.5, length=10, eave=4.0, pitch=52, roof="thatch", walls="daub",
                          doors=[0.6], windows=[-2.6, 3.2], back_windows=[1.5], gable_windows=[],
                          chimneys=[(0.0, -0.8)]),
    "kit-cottage-b": dict(kind="house", width=6.5, length=10, eave=4.2, pitch=54, roof="shingle", walls="daub",
                          doors=[-1.2], windows=[1.4, 3.4], back_windows=[-2.0], gable_windows=[0.0],
                          chimneys=[(0.0, 0.8)], porches=[-1.2]),
    "kit-cottage-c": dict(kind="house", width=7.0, length=9.0, eave=3.8, pitch=50, roof="thatch", walls="rubble",
                          doors=[1.5], windows=[-1.6], back_windows=[], gable_windows=[0.0],
                          chimneys=[(0.0, 0.78)]),
    "kit-longhouse": dict(kind="house", width=8.0, length=18.0, eave=4.2, pitch=50, roof="thatch", walls="daub",
                          doors=[-4.5, 4.0], windows=[-7.0, -1.5, 1.8, 7.0], back_windows=[-4.0, 3.0],
                          gable_windows=[], chimneys=[(0.0, -0.3), (0.0, 0.55)]),
    "kit-barn": dict(kind="house", width=9.0, length=15.0, eave=4.6, pitch=45, roof="shingle", walls="planks",
                     plinth=0.35, doors=[], windows=[], barn_door=(3.5, 4.2), back_windows=[], gable_windows=[],
                     chimneys=[], overhang=0.7),
    "kit-shed": dict(kind="shed", width=4.0, length=5.0, eave=3.2, ridge=4.2),
}


def build(name, spec):
    if spec["kind"] == "house":
        builder, top = house(spec)
    elif spec["kind"] == "shed":
        builder, top = shed(spec)
    else:
        builder, top = fence_module()
    mesh = builder.finish(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj, top


def bake_ao(obj, samples):
    """Cycles AO baked into a temporary colour attribute (with a ground plane), stored in UV 'Layer'.y."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, -0.001))
    ground = bpy.context.active_object
    material = bpy.data.materials.new("bake")
    material.use_nodes = True
    obj.data.materials.append(material)
    ground.data.materials.append(material)
    obj.data.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
    obj.data.color_attributes.active_color = obj.data.color_attributes["AO"]
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    ao = obj.data.color_attributes["AO"].data
    layer = obj.data.uv_layers["Layer"].data
    for index, item in enumerate(ao):
        value = max(0.0, min(1.0, sum(item.color[:3]) / 3))
        # glTF stores V flipped (1 - v): Blender keeps 1 - AO so the game reads UV1.y = AO.
        layer[index].uv = (layer[index].uv[0], 1.0 - (0.25 + 0.75 * value))
    obj.data.color_attributes.remove(obj.data.color_attributes["AO"])
    bpy.data.objects.remove(ground, do_unlink=True)
    obj.data.materials.clear()


def export(obj, path):
    material = bpy.data.materials.get("kit") or bpy.data.materials.new("kit")
    material.use_nodes = True
    obj.data.materials.clear()
    obj.data.materials.append(material)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_texcoords=True, export_normals=True, export_tangents=False,
                              export_materials="EXPORT", export_cameras=False, export_lights=False,
                              export_animations=False, export_skins=False, export_morph=False)


def bounds(obj):
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    return {"min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}


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
              "layers": LAYERS, "tileMetres": TILE, "assets": {}}
    items = dict(BUILDINGS)
    items["kit-fence"] = dict(kind="fence", width=0.24, length=2.0)
    for name, spec in items.items():
        if args.only and name not in args.only:
            continue
        obj, top = build(name, spec)
        bake_ao(obj, args.samples)
        path = args.out / f"{name}.glb"
        export(obj, path)
        report["assets"][name] = {"triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons), "vertices": len(obj.data.vertices),
                                 "top": top, "bounds": bounds(obj), "footprint": [spec["width"], spec["length"]], "file": path.name,
                                 "bytes": path.stat().st_size}
        bpy.data.objects.remove(obj, do_unlink=True)
    (args.out / "kit-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({name: {k: v for k, v in a.items() if k in ("triangles", "bytes", "top")} for name, a in report["assets"].items()}))


if __name__ == "__main__":
    main()
