"""Cook a korovany-2 wagon (the logistics convoy or the Crown ward-glass shipment) in Blender 5.2.2 LTS.

blender -b --factory-startup --python cook_wagon.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
    [--measure] [--parts-only]

The approved TRELLIS mesh becomes the static wagon body: normalized to game scale and heading, its blobby
reconstructed wheels cut away (TRELLIS cannot resolve spokes), decimated to budget, given fresh smart-projected UVs and
re-baked (base colour from the approved source, tangent normals, AO, roughness and metalness from colour inside declared
regions). Blender-authored parts replace what TRELLIS cannot build and what must move:

  wagon-wheels-front, wagon-wheels-rear   one node per axle, spun by the game about its local X axis by distance
                                          travelled / wheel radius
  wagon-harness                           shafts, the duga arch with its warding bell and the pennant; the game
                                          pitches it about its hinge to follow the ox's hame hooks
  socket-cargo (convoy)                   where the separate cargo load sits in the open bed

Parts share one small atlas (base colour with the pennant's dye mask in alpha, and ORM); wood carries procedural
grain. Coordinates are cooked metres on Blender axes: +Z up, the wagon faces -Y, its left is +X.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as m  # noqa: E402
import k2rig as r  # noqa: E402
import k2sheet as g  # noqa: E402
import k2uv as u  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--measure", action="store_true", help="report the normalized raw mesh around its wheels and stop")
parser.add_argument("--parts-only", action="store_true", help="development: skip the body bake")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-wagon-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {name: k.sha(here / name) for name in ("cook_wagon.py", "k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py", "k2uv.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()


# ---------------------------------------------------------------- body

def normalize(body, N):
    """Yaw the raw wagon to face -Y, scale its full length (with the reconstructed wheels) to `lengthMeters`, and put
    the origin at the centre of its ground footprint."""
    points = k.coords(body)
    yaw = math.radians(N.get("yawDegrees", 0.0))
    rotation = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    points = points @ rotation.T
    low, high = points.min(axis=0), points.max(axis=0)
    scale = N["lengthMeters"] / (high[1] - low[1])
    centre = np.array([(low[0] + high[0]) / 2, (low[1] + high[1]) / 2 + N.get("centreShiftY", 0.0) / scale, low[2]])
    k.set_coords(body, (points - centre) * scale)
    final = k.coords(body)
    return {"uniformScale": scale, "yawDegrees": N.get("yawDegrees", 0.0), "lengthMeters": N["lengthMeters"],
            "size": (final.max(axis=0) - final.min(axis=0)).round(4).tolist(),
            "axes": "glTF +Y up/+Z forward -> Blender import -> glTF export_yup; no extra axis rotation"}


def wheel_cylinders(recipe):
    for axle in ("front", "rear"):
        A = {**recipe["wheels"]["common"], **recipe["wheels"][axle]}
        for sign in (1, -1):
            yield axle, sign, Vector((sign * A["track"], A["y"], A["radius"])), A["radius"], A["width"]


def cut(body, recipe):
    """Delete the reconstructed wheels (cylinders around each authored wheel, with margins) and declared boxes."""
    C = recipe["cut"]
    points = k.coords(body)
    remove = np.zeros(len(points), dtype=bool)
    for _, sign, centre, radius, width in wheel_cylinders(recipe):
        radial = np.hypot(points[:, 1] - centre.y, points[:, 2] - centre.z)
        lateral = np.abs(points[:, 0] - centre.x)
        inner = C.get("innerWheelMargin", 0.02)
        remove |= (radial < radius + C["radialMargin"]) & (lateral < width / 2 + C["lateralMargin"]) \
            & (points[:, 0] * sign > centre.x * sign - width / 2 - inner)
    for box in C.get("boxes", []):
        low, high = np.array(box["min"]), np.array(box["max"])
        remove |= np.all((points >= low) & (points <= high), axis=1)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.flatnonzero(remove)], context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()
    return {"verticesRemoved": int(remove.sum()), "fractionRemoved": round(float(remove.mean()), 4), **{key: C[key] for key in C if key != "boxes"},
            "boxes": len(C.get("boxes", []))}


def measure(body, recipe):
    points = k.coords(body)
    report = {"bounds": [points.min(axis=0).round(3).tolist(), points.max(axis=0).round(3).tolist()]}
    # Wheel candidates: vertices outside the bed's side planes, below mid height, per quadrant.
    half = recipe.get("measureBedHalfWidth", 0.7)
    for name, sign_y in (("front", -1), ("rear", 1)):
        for sign_x in (1, -1):
            mask = (points[:, 0] * sign_x > half) & (points[:, 1] * sign_y > 0) & (points[:, 2] < 1.4)
            if mask.sum() < 20:
                continue
            chosen = points[mask]
            report[f"{name}{'L' if sign_x > 0 else 'R'}"] = {
                "count": int(mask.sum()), "min": chosen.min(axis=0).round(3).tolist(), "max": chosen.max(axis=0).round(3).tolist(),
                "centreYZ": [round(float((chosen[:, 1].min() + chosen[:, 1].max()) / 2), 3), round(float((chosen[:, 2].min() + chosen[:, 2].max()) / 2), 3)],
                "radiusFromY": round(float((chosen[:, 1].max() - chosen[:, 1].min()) / 2), 3)}
    for z in (0.1, 0.4, 0.7, 1.0, 1.3, 1.6, 1.9, 2.2):
        band = np.abs(points[:, 2] - z) < 0.03
        if band.any():
            report[f"slice{z}"] = [points[band].min(axis=0).round(3).tolist(), points[band].max(axis=0).round(3).tolist()]
    return report


# ---------------------------------------------------------------- authored parts

def paint(obj, rgb, metal, rough, dye=0.0, grain=0.0):
    r.paint(obj, rgb, metal, rough, dye)
    mesh = obj.data
    values = mesh.attributes.get("grain") or mesh.attributes.new("grain", "FLOAT", "CORNER")
    for loop in mesh.loops:
        values.data[loop.index].value = grain


def ring(name, radius_outer, radius_inner, width, segments, x0=0.0):
    """Annulus in the YZ plane around the X axis, `width` along X starting at x0."""
    vertices, faces = [], []
    for index in range(segments):
        angle = 2 * math.pi * index / segments
        c, s = math.cos(angle), math.sin(angle)
        for x in (x0, x0 + width):
            vertices.append((x, radius_outer * c, radius_outer * s))
            vertices.append((x, radius_inner * c, radius_inner * s))
    for index in range(segments):
        a, b = index * 4, ((index + 1) % segments) * 4
        # vertex layout per segment: 0 outer@x0, 1 inner@x0, 2 outer@x1, 3 inner@x1
        faces += [(a, b, b + 2, a + 2), (a + 1, a + 3, b + 3, b + 1), (a, a + 1, b + 1, b), (a + 2, b + 2, b + 3, a + 3)]
    obj = r.mesh_object(name, vertices, faces)
    return fix_normals(obj)


def fix_normals(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def cylinder_x(name, radius, x0, x1, sides):
    return r.sweep(name, [(x0, 0, 0), (x1, 0, 0)], [(Vector((0, 1, 0)), Vector((0, 0, 1)))] * 2, lambda i: r.ellipse(radius, radius, sides))


def make_wheel(W, name):
    """One spoked wheel around the X axis, its outer face toward +X, dished outward by W['dish']."""
    R, segments = W["radius"], W.get("segments", 28)
    tyre_depth, felloe_depth = W.get("tyreDepth", 0.022), W.get("felloeDepth", 0.06)
    width, dish = W["width"], W.get("dish", 0.025)
    parts = []
    tyre = ring(f"{name}-tyre", R, R - tyre_depth, width, segments, dish - width / 2)
    paint(tyre, W["ironColor"], 1.0, 0.55, grain=0.12)
    parts.append(tyre)
    felloe = ring(f"{name}-felloe", R - tyre_depth + 0.002, R - tyre_depth - felloe_depth, width * 0.9, segments, dish - width * 0.45)
    paint(felloe, W["woodColor"], 0.0, 0.8, grain=0.4)
    parts.append(felloe)
    hub_r, hub_len = W.get("hubRadius", 0.09), W.get("hubLength", 0.24)
    hub = r.sweep(f"{name}-hub", [(-hub_len / 2, 0, 0), (-0.03, 0, 0), (0.03, 0, 0), (hub_len / 2, 0, 0)],
                  [(Vector((0, 1, 0)), Vector((0, 0, 1)))] * 4,
                  lambda i: r.ellipse(*(2 * [hub_r * (0.72, 1.0, 1.0, 0.72)[i]]), 14))
    paint(hub, W["woodColor"], 0.0, 0.75, grain=0.35)
    parts.append(hub)
    for x in (-0.06, 0.06):
        band = ring(f"{name}-band", hub_r * 1.06, hub_r * 0.9, 0.022, 14, x - 0.011)
        paint(band, W["ironColor"], 1.0, 0.5, grain=0.1)
        parts.append(band)
    cap = cylinder_x(f"{name}-cap", hub_r * 0.55, hub_len / 2, hub_len / 2 + 0.035, 12)
    paint(cap, W.get("capColor", W["ironColor"]), 1.0, 0.45, grain=0.08)
    parts.append(cap)
    spokes = W.get("spokes", 12)
    for index in range(spokes):
        angle = 2 * math.pi * (index + 0.5) / spokes
        direction = Vector((0, math.cos(angle), math.sin(angle)))
        inner = Vector((0.0, 0, 0)) + direction * hub_r * 0.95
        outer = Vector((dish, 0, 0)) + direction * (R - tyre_depth - felloe_depth + 0.01)
        along = (outer - inner).normalized()
        side = Vector((1, 0, 0)).cross(along).normalized()
        normal = along.cross(side).normalized()
        spoke = r.sweep(f"{name}-spoke{index}", [inner, outer], [(side, normal)] * 2,
                        lambda i: r.ellipse(W.get("spokeWidth", 0.022) * (1.0 if i == 0 else 0.8), W.get("spokeDepth", 0.028), 6), cap=False)
        paint(spoke, W["woodColor"], 0.0, 0.8, grain=0.35)
        parts.append(spoke)
    return r.join(parts, name)


def make_axle(A, name):
    """Both wheels of one axle and the axle tree between them; origin at the axle centre, spun about X."""
    left = make_wheel(A, f"{name}-l")
    left.location.x = A["track"]
    bpy.ops.object.select_all(action="DESELECT")
    left.select_set(True)
    bpy.context.view_layer.objects.active = left
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    right = make_wheel(A, f"{name}-r")
    right.scale.x = -1
    right.location.x = -A["track"]
    bpy.context.view_layer.objects.active = right
    k.select_only(right)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    fix_normals(right)
    tree = cylinder_x(f"{name}-tree", A.get("axleRadius", 0.045), -A["track"] + 0.1, A["track"] - 0.1, 10)
    paint(tree, A["woodColor"], 0.0, 0.8, grain=0.3)
    return r.join([left, right, tree], name)


def bezier(p0, p1, p2, t):
    return p0 * (1 - t) ** 2 + p1 * 2 * t * (1 - t) + p2 * t * t


def make_harness(H, colours):
    """Shafts from the hinge to the ox's hame hooks, a crossbar, the duga arch over the neck with a small warding bell
    and the pennant on a staff at the arch's crown. Origin at the hinge midpoint."""
    hinge, hook = Vector(H["hinge"]), Vector(H["hook"])
    parts = []
    tips = []
    curves = []
    for sign in (1, -1):
        start = Vector((sign * hinge.x, hinge.y, hinge.z))
        end = Vector((sign * hook.x, hook.y + H.get("shaftPastHook", -0.12), hook.z + H.get("shaftDrop", 0.0)))
        control = (start + end) / 2 + Vector((sign * H["bow"], 0, H.get("sag", 0.0)))
        curves.append((start, control, end))
        centres = [bezier(start, control, end, i / 10) for i in range(11)]
        frames = []
        for i in range(11):
            tangent = (centres[min(10, i + 1)] - centres[max(0, i - 1)]).normalized()
            side = Vector((0, 0, 1)).cross(tangent).normalized()
            frames.append((side, tangent.cross(side).normalized()))
        radius = H["shaftRadius"]
        shaft = r.sweep(f"shaft{sign}", centres, frames, lambda i: r.ellipse(radius * (1 - 0.3 * i / 10), radius * (1 - 0.3 * i / 10), 8))
        paint(shaft, colours["wood"], 0.0, 0.75, grain=0.4)
        parts.append(shaft)
        tips.append(end)
        # Iron shoe and a leather loop where the shaft meets the hook.
        shoe = r.sweep(f"shoe{sign}", [bezier(start, control, end, 0.9), end], [frames[9], frames[10]],
                       lambda i: r.ellipse(radius * 0.85, radius * 0.85, 8))
        paint(shoe, colours["iron"], 1.0, 0.5, grain=0.1)
        parts.append(shoe)
    t = H.get("crossbarT", 0.12)
    cross = [bezier(*curve, t) for curve in curves]
    bar = r.sweep("crossbar", cross, [(Vector((0, 1, 0)), Vector((0, 0, 1)))] * 2, lambda i: r.ellipse(0.03, 0.03, 8))
    paint(bar, colours["wood"], 0.0, 0.75, grain=0.4)
    parts.append(bar)
    # Duga: a flattened arch standing up from the shaft tips over the ox's neck.
    D = H["duga"]
    base_y = hook.y + D.get("behindHook", 0.06)
    centres, frames = [], []
    for i in range(19):
        angle = math.pi * i / 18
        x = hook.x * math.cos(angle) * D.get("spread", 1.0)
        z = hook.z + D["rise"] * math.sin(angle) ** D.get("shape", 0.8)
        centres.append(Vector((x, base_y, z)))
    for i in range(19):
        tangent = (centres[min(18, i + 1)] - centres[max(0, i - 1)]).normalized()
        frames.append((Vector((0, 1, 0)), tangent.cross(Vector((0, 1, 0))).normalized()))
    duga = r.sweep("duga", centres, frames, lambda i: r.ellipse(D["depth"] / 2, D["thickness"] / 2, 8))
    paint(duga, colours["duga"], 0.0, 0.6, grain=0.3)
    parts.append(duga)
    crown = centres[9]
    B = H["bell"]
    strap = r.sweep("strap", [crown - Vector((0, 0, D["thickness"] / 2)), crown - Vector((0, 0, B["drop"]))],
                    [(Vector((1, 0, 0)), Vector((0, 1, 0)))] * 2, lambda i: r.ellipse(0.012, 0.006, 6))
    paint(strap, colours["leather"], 0.0, 0.85, grain=0.1)
    parts.append(strap)
    top = crown - Vector((0, 0, B["drop"]))
    profile = [(0.012, 0.0), (0.03, -0.012), (0.042, -0.045), (0.05, -0.08), (B["radius"], -B["height"])]
    bell_centres = [top + Vector((0, 0, dz)) for _, dz in profile]
    bell = r.sweep("bell", bell_centres, [(Vector((1, 0, 0)), Vector((0, 1, 0)))] * len(profile),
                   lambda i: r.ellipse(profile[i][0], profile[i][0], 14))
    paint(bell, colours["bronze"], 1.0, 0.42, grain=0.08)
    parts.append(bell)
    P = H["pennant"]
    staff_top = crown + Vector((0, 0, P["staff"]))
    staff = r.sweep("staff", [crown, staff_top], [(Vector((1, 0, 0)), Vector((0, 1, 0)))] * 2, lambda i: r.ellipse(0.012, 0.012, 6))
    paint(staff, colours["wood"], 0.0, 0.7, grain=0.3)
    parts.append(staff)
    length, drop = P["length"], P["height"]
    # A swallow-tailed pennant streaming back from the staff (toward +Y), dyed by the game. Its cloth ripples sideways,
    # more toward the tails, so the allegiance colour still reads from straight behind or ahead.
    W = P.get("wave", {})
    amplitude, cycles, segments = W.get("amplitude", 0.0), W.get("cycles", 1.0), W.get("segments", 1)
    notch = 0.78

    def cloth(along, v):
        x = amplitude * (along / length) * math.sin(2 * math.pi * cycles * along / length)
        return staff_top + Vector((x, along, v - 0.01))

    vertices, faces = [], []
    for i in range(segments + 1):
        along = notch * length * i / segments
        upper, lower = -drop * 0.35 * along / length, -drop + drop * 0.35 * along / length
        vertices += [cloth(along, upper), cloth(along, (upper + lower) / 2), cloth(along, lower)]
    for i in range(segments):
        a, b = 3 * i, 3 * (i + 1)
        faces += [(a, b, b + 1, a + 1), (a + 1, b + 1, b + 2, a + 2)]
    last = 3 * segments
    vertices += [cloth(length, -drop * 0.35), cloth(length, -drop * 0.65)]
    faces += [(last, last + 3, last + 1), (last + 1, last + 4, last + 2)]
    flag = r.mesh_object("pennant", vertices, faces)
    solid = flag.modifiers.new("t", "SOLIDIFY")
    solid.thickness = 0.008
    k.select_only(flag)
    bpy.ops.object.modifier_apply(modifier=solid.name)
    fix_normals(flag)
    paint(flag, colours["pennant"], 0.0, 0.85, dye=1.0, grain=0.15)
    parts.append(flag)
    harness = r.join(parts, "wagon-harness")
    return harness, {"tips": [list(t) for t in tips], "crown": list(crown), "bellTop": list(top)}


def bake_parts(objects, P):
    """Shared atlas for the authored parts: paint x procedural grain in base RGB, the dye mask in alpha, ORM."""
    for index, obj in enumerate(objects):
        attribute = obj.data.attributes.new("part", "INT", "POINT")
        for vertex in obj.data.vertices:
            attribute.data[vertex.index].value = index
    names = [obj.name for obj in objects]
    combined = r.join(list(objects), "parts-bake")
    m.ensure_uv(combined, 0.01, force=True)
    k.select_only(combined)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin=P.get("packMargin", 0.004))
    bpy.ops.object.mode_set(mode="OBJECT")
    size = P["textureSize"]
    material = bpy.data.materials.new("parts-bake")
    combined.data.materials.append(material)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    m.cycles_cpu(1)
    paint_node = nodes.new("ShaderNodeVertexColor")
    paint_node.layer_name = "paint"
    grain = nodes.new("ShaderNodeAttribute")
    grain.attribute_name = "grain"
    coords = nodes.new("ShaderNodeTexCoord")
    stretch = nodes.new("ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = P.get("grainScale", (6.0, 6.0, 60.0))
    links.new(coords.outputs["Object"], stretch.inputs["Vector"])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = P.get("noiseScale", 3.0)
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.65
    links.new(stretch.outputs["Vector"], noise.inputs["Vector"])
    centred = nodes.new("ShaderNodeMath")
    centred.operation = "SUBTRACT"
    links.new(noise.outputs["Fac"], centred.inputs[0])
    centred.inputs[1].default_value = 0.5
    scaled = nodes.new("ShaderNodeMath")
    scaled.operation = "MULTIPLY"
    links.new(centred.outputs[0], scaled.inputs[0])
    links.new(grain.outputs["Fac"], scaled.inputs[1])
    factor = nodes.new("ShaderNodeMath")
    factor.operation = "MULTIPLY_ADD"
    links.new(scaled.outputs[0], factor.inputs[0])
    factor.inputs[1].default_value = 2.0
    factor.inputs[2].default_value = 1.0
    shaded = nodes.new("ShaderNodeVectorMath")
    shaded.operation = "SCALE"
    links.new(paint_node.outputs["Color"], shaded.inputs[0])
    links.new(factor.outputs[0], shaded.inputs["Scale"])
    maps = {}
    for channel in ("paint", "metal", "rough", "dye"):
        target = m.image(f"parts-{channel}", size, "sRGB" if channel == "paint" else "Non-Color")
        if channel == "paint":
            socket = shaded.outputs["Vector"]
        else:
            source = nodes.new("ShaderNodeAttribute")
            source.attribute_name = channel
            socket = source.outputs["Fac"]
        m.bake_emission(combined, material, socket, target)
        maps[channel] = m.pixels(target)
    _, coverage = m.bake_geometry(combined, size, "Position")
    colour = m.fill_gutters(np.clip(maps["paint"][..., :3], 0, 1), coverage)
    dye = m.fill_gutters(maps["dye"][..., 0], coverage)
    metal = m.fill_gutters(maps["metal"][..., 0], coverage)
    rough = m.fill_gutters(maps["rough"][..., 0], coverage)
    ones = np.ones_like(dye)
    base = m.image("parts-base", size, "sRGB", alpha=True)
    m.set_pixels(base, np.dstack([colour, np.clip(dye, 0, 1)]))
    orm = m.image("parts-orm", size, "Non-Color")
    m.set_pixels(orm, np.dstack([ones, rough, metal, ones]))
    base.pack()
    orm.pack()
    final = m.gltf_material("wagon-parts", base, None, orm, occlusion=False)
    k.select_only(combined)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.startswith("parts-bake")]
    groups = {index: [] for index in range(len(names))}
    for piece in pieces:
        groups[piece.data.attributes["part"].data[0].value].append(piece)
    result = []
    for index, name in enumerate(names):
        obj = r.join(groups[index], name)
        obj.data.materials.clear()
        obj.data.materials.append(final)
        mesh = obj.data
        if mesh.color_attributes.get("paint"):
            mesh.color_attributes.remove(mesh.color_attributes["paint"])
        for attribute in ("metal", "rough", "dye", "part", "grain"):
            if mesh.attributes.get(attribute):
                mesh.attributes.remove(mesh.attributes[attribute])
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        mesh.update()
        result.append(obj)
    bpy.data.materials.remove(material)
    return result, {"textureSize": size, "coverage": round(float(coverage.mean()), 4),
                    "dyeFraction": round(float((dye[coverage] > 0.5).mean()), 4),
                    "authoring": "Blender-authored low-poly parts; paint x procedural noise grain, metal, roughness and the pennant's "
                                 "dye mask baked (Cycles CPU emission) into one atlas"}


def place_origin(obj, origin):
    """Move `obj`'s origin to `origin` without moving its geometry."""
    offset = Vector(origin)
    obj.data.transform(Matrix.Translation(-offset))
    obj.location = offset


# ---------------------------------------------------------------- main

def main():
    k.setup_scene()
    receipt["stage"] = "import"
    body = k.import_single_mesh(args.raw, "wagon-body")
    receipt["rawTopology"] = k.topology_report(body)
    receipt["groundSheet"] = g.remove_ground_sheet(body, recipe.get("groundSheet"))
    receipt["normalization"] = normalize(body, recipe["normalize"])
    if args.measure:
        receipt["measure"] = measure(body, recipe)
        receipt["status"] = "measured"
        return
    receipt["stage"] = "cut"
    receipt["cut"] = cut(body, recipe)
    receipt["cleanup"] = k.clean_mesh(body)
    receipt["specks"] = r.keep_largest(body, recipe.get("minComponentFraction", 0.002))
    receipt["holes"] = r.fill_small_holes(body, recipe.get("fillHoleSides", 24))
    high = body.copy()
    high.data = body.data.copy()
    high.name = "wagon-body-source"
    bpy.context.scene.collection.objects.link(high)
    receipt["decimation"] = r.decimate(body, recipe["triangleBudget"])
    k.select_only(body)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(recipe.get("smoothAngle", 35)))
    receipt["topology"] = k.topology_report(body)
    k.require(receipt["topology"]["triangles"] <= recipe["triangleBudget"], "Body exceeds its triangle budget")
    receipt["stage"] = "materials"
    if args.parts_only:
        receipt["materials"] = {"skipped": "parts-only development cook; source material kept"}
    else:
        receipt["uv"] = u.reunwrap(body, recipe["body"])
        receipt["materials"] = r.bake_body(recipe, high, body, out)
        # k2rig's generic provenance text describes the troops' rear-view projection and tone calibration; the recipe
        # states what this asset's bake actually did.
        k.require("provenance" in recipe["body"], "recipe body.provenance must describe this bake")
        receipt["materials"]["provenance"] = recipe["body"]["provenance"]
        # The body is never dyed: an opaque base colour lets it share the plain prop material and program.
        base = bpy.data.images["body-base"]
        pixels = m.pixels(base)
        pixels[..., 3] = 1.0
        m.set_pixels(base, pixels)
        base.pack()
        receipt["materials"]["dye"] = "none: base alpha set opaque"
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "parts"
    W = recipe["wheels"]
    axles = {}
    for axle in ("front", "rear"):
        obj = make_axle({**W["common"], **W[axle]}, f"wagon-wheels-{axle}")
        obj.location = (0, W[axle]["y"], W[axle]["radius"])
        k.select_only(obj)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
        axles[axle] = obj
    front, rear = axles["front"], axles["rear"]
    harness, harness_facts = make_harness(recipe["harness"], recipe["colours"])
    parts, receipt["parts"] = bake_parts([front, rear, harness], recipe["parts"])
    front, rear, harness = parts
    for axle, obj in (("front", front), ("rear", rear)):
        place_origin(obj, (0, W[axle]["y"], W[axle]["radius"]))
    place_origin(harness, (0, recipe["harness"]["hinge"][1], recipe["harness"]["hinge"][2]))
    receipt["parts"]["wheels"] = {axle: {"radius": W[axle]["radius"], "track": W[axle]["track"], "y": W[axle]["y"],
                                         "triangles": k.triangle_count(obj)} for axle, obj in (("front", front), ("rear", rear))}
    receipt["parts"]["harness"] = {"triangles": k.triangle_count(harness), "hinge": recipe["harness"]["hinge"], **harness_facts}
    for obj in parts:
        k.require(k.triangle_count(obj) <= recipe["partBudgets"][obj.name], f"{obj.name} exceeds its triangle budget")
    sockets = []
    for name, at in recipe.get("sockets", {}).items():
        empty = bpy.data.objects.new(name, None)
        empty.location = Vector(at)
        bpy.context.scene.collection.objects.link(empty)
        sockets.append(empty)
    receipt["stage"] = "export"
    path = out / f"{recipe['id']}.glb"
    k.export_glb(path, [body, front, rear, harness, *sockets], animations=False, tangents=not args.parts_only)
    np.save(out / "parts-base.npy", m.pixels(bpy.data.images["parts-base"]))
    receipt["baseEncoding"] = {"pending": ["parts-base"], "encoder": "webp_exact.py"}
    doc, _ = k.read_glb(path)
    names = sorted(node.get("name") for node in doc["nodes"])
    k.require({"wagon-body", "wagon-wheels-front", "wagon-wheels-rear", "wagon-harness"} <= set(names), f"Missing nodes: {names}")
    receipt["output"] = {"file": path.name, "bytes": path.stat().st_size, "sha256": k.sha(path), "nodes": names,
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-encoding"
    receipt["stage"] = "complete"


try:
    main()
except Exception as error:
    receipt["status"] = "failed"
    receipt["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    receipt["seconds"] = time.monotonic() - started
    (out / "cook.json").write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("K2_COOK=" + json.dumps({key: receipt.get(key) for key in ("status", "stage", "error", "output")}, default=str))
