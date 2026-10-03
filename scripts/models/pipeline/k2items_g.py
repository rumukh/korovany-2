"""Blender-authored items for the batch G faction troops (korovany-2), registered with k2rig's item makers.

Imported by cook_troop_g.py. k2rig.py and cook_troop.py stay the exact scripts of the shipped troops; these makers
follow k2rig's frame conventions so the same sockets, grips and clip solver hold them:

  roundshield  strap at the origin, painted face toward +Z, long axis +Y (as k2rig.make_shield)
  axe          one-handed: grip at the origin, haft along +Y, bearded blade toward +X, flats facing +/-Z
  glaive       two-handed: leading (right-hand) grip at the origin, haft along +Y to a leaf blade with its edges
               along +/-X; the trailing hand grips at -leftGrip (as k2rig.make_hammer)

Faces carry the dye attribute only where a recipe asks (`faceDye`), so a faction colour lands on the shield face
and nowhere else.
"""
import math

import bmesh
import bpy
from mathutils import Vector

import k2cook as k
import k2rig as r

AXIS = [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2


def _solid(obj, thickness, offset=0.0):
    modifier = obj.modifiers.new("t", "SOLIDIFY")
    modifier.thickness = thickness
    modifier.offset = offset
    bpy.context.view_layer.objects.active = obj
    k.select_only(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def _triangulated(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def make_round_shield(D):
    """Round shield: a shallow dome of `radius` with a metal rim and a domed boss; face toward +Z, strap at the
    origin. The face takes `faceColor` (dyed by `faceDye`), the back `backColor`, the rim `rimColor`."""
    radius, curve, rings, segments = D["radius"], D["curve"], D.get("rings", 4), D.get("segments", 20)
    vertices, faces = [(0.0, 0.0, curve)], []
    for ring in range(1, rings + 1):
        rr = radius * ring / rings
        for segment in range(segments):
            angle = 2 * math.pi * segment / segments
            vertices.append((rr * math.cos(angle), rr * math.sin(angle), curve * (1 - (rr / radius) ** 2)))
    for segment in range(segments):
        faces.append((0, 1 + segment, 1 + (segment + 1) % segments))
    for ring in range(1, rings):
        a, b = 1 + (ring - 1) * segments, 1 + ring * segments
        for segment in range(segments):
            nxt = (segment + 1) % segments
            faces.append((a + segment, b + segment, b + nxt, a + nxt))
    face = r.mesh_object("shield-face", vertices, faces)
    _solid(face, D["thickness"])
    r.paint(face, tuple(D.get("faceColor", (0.6, 0.58, 0.54))), 0.0, D.get("faceRoughness", 0.78), dye=D.get("faceDye", 1.0))
    mesh = face.data
    back_colour, rim_colour = tuple(D.get("backColor", (0.3, 0.21, 0.12))), tuple(D.get("rimColor", (0.2, 0.2, 0.21)))
    for polygon in mesh.polygons:
        back, edge = polygon.normal.z < -0.5, abs(polygon.normal.z) <= 0.5
        for loop in polygon.loop_indices:
            if back or edge:
                mesh.color_attributes["paint"].data[loop].color = (*(back_colour if back else rim_colour), 1)
                mesh.attributes["dye"].data[loop].value = 0.0
                mesh.attributes["metal"].data[loop].value = 0.0 if back else 1.0
                mesh.attributes["rough"].data[loop].value = 0.85 if back else 0.5
    parts = [face]
    # A metal rim band hugging the edge, proud of both faces.
    rim_width, rim_depth = D.get("rimWidth", 0.025), D["thickness"] * 1.8
    ring_vertices, ring_faces = [], []
    for segment in range(segments):
        angle = 2 * math.pi * segment / segments
        c, s = math.cos(angle), math.sin(angle)
        for rr, z in ((radius - rim_width, rim_depth / 2), (radius + 0.004, rim_depth / 2), (radius + 0.004, -rim_depth / 2),
                      (radius - rim_width, -rim_depth / 2)):
            ring_vertices.append((rr * c, rr * s, z))
    for segment in range(segments):
        a, b = segment * 4, ((segment + 1) % segments) * 4
        for j in range(4):
            ring_faces.append((a + j, b + j, b + (j + 1) % 4, a + (j + 1) % 4))
    rim = r.mesh_object("shield-rim", ring_vertices, ring_faces)
    _triangulated(rim)
    r.paint(rim, rim_colour, 1.0, D.get("rimRoughness", 0.5))
    parts.append(rim)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=D["boss"], location=(0, 0, curve + D["thickness"] * 0.3))
    boss = bpy.context.object
    boss.scale = (1, 1, D.get("bossFlatten", 0.5))
    r.paint(boss, tuple(D.get("bossColor", (0.45, 0.35, 0.17))), 1.0, 0.42)
    parts.append(boss)
    # A forearm-strapped round shield covers the hand; the stand-off keeps the fingers behind its face.
    standoff = D.get("standoff", 0.0)
    if standoff:
        for part in parts:
            part.location.z += standoff
    return r.join(parts, "item-shield")


def make_axe(A):
    """One-handed bearded axe: grip at the origin, haft along +Y, head at the top with a bearded blade toward +X and
    a short poll toward -X, flats facing +/-Z, an iron butt cap."""
    below, above = A["belowGrip"], A["aboveGrip"]
    haft = r.sweep("haft", [(0, -below, 0), (0, above, 0)], AXIS, lambda i: r.ellipse(A["haftRadius"], A["haftRadius"] * 0.85, 8))
    r.paint(haft, tuple(A.get("haftColor", (0.2, 0.13, 0.08))), 0.0, 0.7)
    parts = [haft]
    wrap = r.sweep("wrap", [(0, -0.07, 0), (0, 0.07, 0)], AXIS, lambda i: r.ellipse(A["haftRadius"] * 1.2, A["haftRadius"] * 1.05, 8))
    r.paint(wrap, tuple(A.get("wrapColor", (0.12, 0.08, 0.05))), 0.0, 0.85)
    parts.append(wrap)
    top, length, beard, reach = above - 0.02, A["headLength"], A["beard"], A["reach"]
    # Blade profile in the XY plane: the eye at the haft, the edge at +X curving down into the beard.
    profile = [(0.0, top), (reach * 0.55, top + 0.01), (reach, top + length * 0.18), (reach * 1.04, top - length * 0.35),
               (reach * 0.96, top - length * 0.75), (reach * 0.8, top - length - beard), (reach * 0.52, top - length - beard * 0.55),
               (reach * 0.3, top - length * 0.62), (0.0, top - length * 0.42)]
    blade = r.mesh_object("blade", [(x, y, 0) for x, y in profile], [tuple(range(len(profile)))])
    _solid(blade, A["bladeThickness"], 0.0)
    _triangulated(blade)
    r.paint(blade, tuple(A.get("bladeColor", (0.3, 0.3, 0.32))), 1.0, A.get("bladeRoughness", 0.45))
    parts.append(blade)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-A["poll"] / 2 + A["haftRadius"], top - length * 0.22, 0))
    poll = bpy.context.object
    poll.scale = (A["poll"], length * 0.44, A["haftRadius"] * 2.6)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    r.paint(poll, tuple(A.get("bladeColor", (0.3, 0.3, 0.32))), 1.0, 0.5)
    parts.append(poll)
    butt = r.sweep("butt", [(0, -below - 0.03, 0), (0, -below + 0.03, 0)], AXIS,
                   lambda i: r.ellipse(A["haftRadius"] * 1.35, A["haftRadius"] * 1.2, 8))
    r.paint(butt, tuple(A.get("bladeColor", (0.3, 0.3, 0.32))), 1.0, 0.5)
    parts.append(butt)
    return r.join(parts, "item-axe")


def make_glaive(G):
    """Two-handed leaf glaive: the leading (right-hand) grip at the origin, haft along +Y to a bronze socket and a
    leaf-shaped blade whose edges lie along +/-X (flats facing +/-Z); a short butt spike. The trailing hand grips at
    -leftGrip."""
    below, above = G["belowGrip"], G["aboveGrip"]
    haft = r.sweep("haft", [(0, -below, 0), (0, above, 0)], AXIS, lambda i: r.ellipse(G["haftRadius"], G["haftRadius"], 8))
    r.paint(haft, tuple(G.get("haftColor", (0.2, 0.13, 0.08))), 0.0, 0.7)
    parts = [haft]
    for centre, span in ((0.0, 0.16), (-G["leftGrip"], 0.16)):
        wrap = r.sweep("wrap", [(0, centre - span / 2, 0), (0, centre + span / 2, 0)], AXIS,
                       lambda i: r.ellipse(G["haftRadius"] * 1.18, G["haftRadius"] * 1.18, 8))
        r.paint(wrap, tuple(G.get("wrapColor", (0.14, 0.09, 0.06))), 0.0, 0.85)
        parts.append(wrap)
    socket = r.sweep("socket", [(0, above - 0.12, 0), (0, above + 0.02, 0)], AXIS,
                     lambda i: r.ellipse(G["haftRadius"] * (1.25 if i == 0 else 1.45), G["haftRadius"] * (1.25 if i == 0 else 1.45), 10))
    r.paint(socket, tuple(G.get("socketColor", (0.42, 0.3, 0.14))), 1.0, 0.45)
    parts.append(socket)
    length, width, base = G["bladeLength"], G["bladeWidth"], above + 0.02
    # Leaf outline: narrow at the socket, widest at `widest` of its length, curving to the point.
    widest, steps = G.get("widest", 0.38), 10
    left, right = [], []
    for step in range(steps + 1):
        u = step / steps
        if u <= widest:
            half = width / 2 * (0.35 + 0.65 * math.sin(math.pi / 2 * u / widest))
        else:
            half = width / 2 * math.cos(math.pi / 2 * (u - widest) / (1 - widest)) ** 0.9
        y = base + u * length
        right.append((half, y))
        left.append((-half, y))
    outline = right + left[::-1][1:-1]
    blade = r.mesh_object("blade", [(x, y, 0) for x, y in outline], [tuple(range(len(outline)))])
    _solid(blade, G["bladeThickness"], 0.0)
    _triangulated(blade)
    r.paint(blade, tuple(G.get("bladeColor", (0.5, 0.42, 0.26))), 1.0, G.get("bladeRoughness", 0.42))
    parts.append(blade)
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=G["haftRadius"] * 1.15, radius2=0.004, depth=G.get("spike", 0.1),
                                    location=(0, -below - G.get("spike", 0.1) / 2, 0), rotation=(math.radians(90), 0, 0))
    spike = bpy.context.object
    r.paint(spike, tuple(G.get("socketColor", (0.42, 0.3, 0.14))), 1.0, 0.45)
    parts.append(spike)
    return r.join(parts, "item-glaive")


r.MAKERS["roundshield"] = make_round_shield
r.MAKERS["axe"] = make_axe
r.MAKERS["glaive"] = make_glaive
