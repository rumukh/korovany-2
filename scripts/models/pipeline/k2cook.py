"""Reusable Blender 5.2 helpers for korovany-2 character and prop cooking.

Coordinates here are Blender's: metres, +Z up, the character's front faces -Y. The glTF exporter
converts to the game's +Y up / +Z forward once; nothing here rotates axes a second time.
"""
import hashlib
import json
import math
import struct
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def blender_facts():
    build = bpy.app.build_hash
    return {"executable": bpy.app.binary_path, "version": bpy.app.version_string,
            "buildHash": build.decode() if isinstance(build, bytes) else build}


def setup_scene(frame_end=600):
    require(bpy.app.version[:2] == (5, 2), "Blender 5.2 LTS is required")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # Must precede import: frame 1 would shift imported strips and lengthen re-exported clips.
    scene.render.fps, scene.render.fps_base = 60, 1
    scene.frame_start, scene.frame_end = 0, frame_end
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    return scene


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def import_single_mesh(path, name):
    bpy.ops.import_scene.gltf(filepath=str(path), disable_bone_shape=True, merge_vertices=True)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    require(len(meshes) == 1, f"Expected exactly one raw mesh in {path}, found {len(meshes)}")
    body = meshes[0]
    world = body.matrix_world.copy()
    body.data.transform(world)
    body.parent = None
    body.matrix_world = Matrix.Identity(4)
    for obj in list(bpy.context.scene.objects):
        if obj != body:
            bpy.data.objects.remove(obj, do_unlink=True)
    body.name = name
    return body


def coords(obj):
    data = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get("co", data)
    return data.reshape(-1, 3)


def set_coords(obj, points):
    obj.data.vertices.foreach_set("co", points.astype(np.float64).ravel())
    obj.data.update()


def normalize(obj, height, yaw_degrees=0.0, feet_fraction=0.035):
    points = coords(obj)
    low, high = points.min(axis=0), points.max(axis=0)
    span = high[2] - low[2]
    require(span > 1e-6, "Degenerate raw mesh")
    feet = points[points[:, 2] < low[2] + span * feet_fraction]
    centre = np.array([(feet[:, 0].min() + feet[:, 0].max()) / 2, feet[:, 1].mean(), low[2]])
    scale = height / span
    yaw = math.radians(yaw_degrees)
    rotation = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    set_coords(obj, ((points - centre) @ rotation.T) * scale)
    return {"uniformScale": scale, "sourceHeight": span, "feetCentre": centre.tolist(), "yawDegrees": yaw_degrees,
            "targetHeightMeters": height,
            "axes": "glTF +Y up/+Z forward -> Blender import -> glTF export_yup; no extra axis rotation"}


def clean_mesh(obj, weld=1e-5):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=weld)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    degenerate = [f for f in bm.faces if f.calc_area() < 1e-12]
    bmesh.ops.delete(bm, geom=degenerate, context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    after = len(bm.verts)
    bm.free()
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.update()
    return {"weldDistance": weld, "verticesBefore": before, "verticesAfter": after, "looseRemoved": len(loose),
            "degenerateRemoved": len(degenerate)}


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def topology_report(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    boundary = sum(1 for e in bm.edges if e.is_boundary)
    nonmanifold = sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary)
    degenerate = sum(1 for f in bm.faces if f.calc_area() < 1e-12)
    inconsistent = sum(1 for e in bm.edges if e.is_manifold and not e.is_contiguous)
    bm.verts.ensure_lookup_table()
    seen, components, sizes = set(), 0, []
    for vert in bm.verts:
        if vert.index in seen:
            continue
        components += 1
        stack = [vert]
        seen.add(vert.index)
        count = 1
        while stack:
            current = stack.pop()
            for edge in current.link_edges:
                other = edge.other_vert(current)
                if other.index not in seen:
                    seen.add(other.index)
                    stack.append(other)
                    count += 1
        sizes.append(count)
    report = {"vertices": len(bm.verts), "faces": len(bm.faces), "triangles": triangle_count(obj),
              "boundaryEdges": boundary, "nonManifoldEdges": nonmanifold, "components": components,
              "componentVertexCounts": sorted(sizes, reverse=True)[:8], "degenerateFaces": degenerate,
              "inconsistentWindingEdges": inconsistent}
    bm.free()
    return report


def adjacency(obj):
    edges = np.empty(len(obj.data.edges) * 2, dtype=np.int64)
    obj.data.edges.foreach_get("vertices", edges)
    return edges.reshape(-1, 2)


def components(indices, edges):
    """Connected components of the subgraph induced by `indices`."""
    members = set(int(i) for i in indices)
    neighbours = {}
    for a, b in edges:
        a, b = int(a), int(b)
        if a in members and b in members:
            neighbours.setdefault(a, []).append(b)
            neighbours.setdefault(b, []).append(a)
    unseen = set(members)
    result = []
    while unseen:
        start = unseen.pop()
        stack, group = [start], [start]
        while stack:
            for other in neighbours.get(stack.pop(), ()):
                if other in unseen:
                    unseen.remove(other)
                    stack.append(other)
                    group.append(other)
        result.append(np.array(group, dtype=np.int64))
    return sorted(result, key=len, reverse=True)


def build_armature(name, definitions):
    """definitions: ordered {bone: (head, tail, parent, deform)} in Blender coordinates."""
    data = bpy.data.armatures.new(f"{name}-skeleton")
    rig = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(rig)
    select_only(rig)
    bpy.ops.object.mode_set(mode="EDIT")
    for bone_name, (head, tail, parent, deform) in definitions.items():
        bone = data.edit_bones.new(bone_name)
        bone.head, bone.tail = Vector(head), Vector(tail)
        bone.roll = 0
        if parent:
            bone.parent = data.edit_bones[parent]
        bone.use_deform = deform
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def segment_distance(points, head, tail):
    head, tail = np.asarray(head), np.asarray(tail)
    direction = tail - head
    along = np.clip(((points - head) @ direction) / max(direction @ direction, 1e-12), 0, 1)
    return np.linalg.norm(points - (head + along[:, None] * direction), axis=1), along


def bind(body, rig, definitions, allowed, locked=None, relax=48, falloff=0.03, power=4, max_influences=4):
    """Region-constrained, surface-connected weights along adjacent joint chains.

    allowed: (vertices x deform-bones) bool mask of which joints may influence each vertex.
    locked: {vertex index: bone} vertices rigidly bound to one joint (for example planted soles).
    """
    names = [name for name, (_, _, _, deform) in definitions.items() if deform]
    points = coords(body)
    edges = adjacency(body)
    distances = np.empty((len(points), len(names)))
    for column, name in enumerate(names):
        head, tail, _, _ = definitions[name]
        distances[:, column], _ = segment_distance(points, head, tail)
    masked = np.where(allowed, distances, np.inf)
    require(np.isfinite(masked.min(axis=1)).all(), "Some vertices have no allowed joint")
    nearest = np.argmin(masked, axis=1)
    parent_of = {name: definitions[name][2] for name in names}
    chain = np.zeros((len(names), len(names)), dtype=bool)
    for i, name in enumerate(names):
        for j, other in enumerate(names):
            chain[i, j] = other == name or parent_of.get(name) == other or parent_of.get(other) == name
    allowed = allowed & chain[nearest]
    weights = np.where(allowed, 1 / (distances + falloff) ** power, 0)
    weights /= weights.sum(axis=1, keepdims=True)
    degree = np.zeros(len(points))
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    require((degree > 0).all(), "Mesh contains isolated vertices")
    locked = locked or {}
    lock_index = np.array(list(locked.keys()), dtype=np.int64)
    lock_rows = np.zeros((len(lock_index), len(names)))
    for row, bone in enumerate(locked.values()):
        lock_rows[row, names.index(bone)] = 1
    for _ in range(relax):
        spread = np.zeros_like(weights)
        np.add.at(spread, edges[:, 0], weights[edges[:, 1]])
        np.add.at(spread, edges[:, 1], weights[edges[:, 0]])
        weights = 0.5 * weights + 0.5 * spread / degree[:, None]
        weights = np.where(allowed, weights, 0)
        if len(lock_index):
            weights[lock_index] = lock_rows
        weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
    for name in names:
        body.vertex_groups.new(name=name)
    order = np.argsort(-weights, axis=1)[:, :max_influences]
    for vertex in range(len(points)):
        chosen = [(names[c], weights[vertex, c]) for c in order[vertex] if weights[vertex, c] > 1e-4]
        total = sum(w for _, w in chosen)
        require(total > 0, f"Unweighted vertex {vertex}")
        for name, value in chosen:
            body.vertex_groups[name].add([vertex], float(value / total), "REPLACE")
    modifier = body.modifiers.new("skin", "ARMATURE")
    modifier.object = rig
    modifier.use_deform_preserve_volume = False
    body.parent = rig
    return {"joints": len(names), "maxInfluences": max_influences, "relaxationIterations": relax,
            "lockedVertices": len(locked), "falloffMeters": falloff, "power": power}


def bind_heat(body, rig, definitions, allowed, locked=None, relax=4, max_influences=4, blends=(), final_relax=2):
    """Blender bone-heat weights (visibility-aware diffusion inside the closed surface), then region limits,
    rigid sole locks, joint blend ramps, light Laplacian relaxation, 4 influences and normalization. Vertices
    heat leaves empty fall back to the region-constrained distance weights.

    blends: [{"joint": xyz, "axis": xyz (toward the distal limb), "band": m, "ramp": m, "distal": [bones],
    "proximal": [bones]}]; inside the band, the distal share follows smoothstep(-ramp, ramp, along-axis offset)."""
    names = [name for name, (_, _, _, deform) in definitions.items() if deform]
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    require("FINISHED" in result, "Bone-heat binding failed")
    points = coords(body)
    weights = np.zeros((len(points), len(names)))
    index_of = {group.index: names.index(group.name) for group in body.vertex_groups if group.name in names}
    for vertex in body.data.vertices:
        for element in vertex.groups:
            column = index_of.get(element.group)
            if column is not None:
                weights[vertex.index, column] = element.weight
    empty_before = int((weights.sum(axis=1) < 1e-6).sum())
    weights = np.where(allowed, weights, 0)
    empty = weights.sum(axis=1) < 1e-6
    if empty.any():
        distances = np.empty((len(points), len(names)))
        for column, name in enumerate(names):
            head, tail, _, _ = definitions[name]
            distances[:, column], _ = segment_distance(points, head, tail)
        fallback = np.where(allowed, 1 / (distances + 0.03) ** 4, 0)
        weights[empty] = fallback[empty]
    edges = adjacency(body)
    degree = np.zeros(len(points))
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    locked = locked or {}
    lock_index = np.array(list(locked.keys()), dtype=np.int64)
    lock_rows = np.zeros((len(lock_index), len(names)))
    for row, bone in enumerate(locked.values()):
        lock_rows[row, names.index(bone)] = 1
    weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)

    def smooth(values, iterations):
        for _ in range(iterations):
            spread = np.zeros_like(values)
            np.add.at(spread, edges[:, 0], values[edges[:, 1]])
            np.add.at(spread, edges[:, 1], values[edges[:, 0]])
            values = 0.5 * values + 0.5 * spread / np.maximum(degree[:, None], 1)
            values = np.where(allowed, values, 0)
            if len(lock_index):
                values[lock_index] = lock_rows
            values /= np.maximum(values.sum(axis=1, keepdims=True), 1e-12)
        return values

    # Smooth the raw heat weights first; the joint ramps below then define the final gradients across each joint.
    weights = smooth(weights, relax)
    blend_facts = []
    for spec in blends:
        if spec.get("kind") == "skirt":
            # Vertical ramp: hem follows the thighs (split left/right by x), the waist follows pelvis/tabard. With
            # hip helpers ("middle", left then right), the ramp passes through the half-rotation helper so the hem
            # never interpolates the full thigh swing in one linear blend.
            left, right = names.index(spec["distal"][0]), names.index(spec["distal"][1])
            proximal = [names.index(b) for b in spec["proximal"] if b in names]
            middle = [names.index(b) for b in spec.get("middle", []) if b in names]
            inside = spec["mask"]
            zt = np.clip((spec["zTop"] - points[:, 2]) / (spec["zTop"] - spec["zHem"]), 0, 1)
            share = zt * zt * (3 - 2 * zt) * spec.get("maxShare", 1.0)
            xs = np.clip((points[:, 0] + spec["sideRamp"]) / (2 * spec["sideRamp"]), 0, 1)
            side = xs * xs * (3 - 2 * xs)
            rows = np.flatnonzero(inside)
            for row in rows:
                p_sum = weights[row, proximal].sum()
                m_sum = weights[row, middle].sum() if len(middle) == 2 else 0.0
                mass = max(p_sum + weights[row, left] + weights[row, right] + m_sum, 1e-6)
                p_share = weights[row, proximal] / p_sum if p_sum > 1e-9 else np.where(allowed[row, proximal], 1.0, 0) / max(1, allowed[row, proximal].sum())
                s = share[row]
                if len(middle) == 2:
                    d, h, p = max(0.0, 2 * s - 1), 1 - abs(2 * s - 1), max(0.0, 1 - 2 * s)
                    weights[row, middle[0]] = h * side[row] * mass
                    weights[row, middle[1]] = h * (1 - side[row]) * mass
                else:
                    d, p = s, 1 - s
                weights[row, left] = d * side[row] * mass
                weights[row, right] = d * (1 - side[row]) * mass
                weights[row, proximal] = p_share * p * mass
            blend_facts.append({"kind": "skirt", "vertices": int(len(rows)), "helpers": len(middle) == 2})
            continue
        joint, axis = np.array(spec["joint"]), np.array(spec["axis"], dtype=np.float64)
        axis /= np.linalg.norm(axis)
        inside = np.linalg.norm(points - joint, axis=1) < spec["band"]
        if spec.get("mask") is not None:
            inside &= spec["mask"]
        along = (points - joint) @ axis - spec.get("shift", 0.0)
        t = np.clip((along + spec["ramp"]) / (2 * spec["ramp"]), 0, 1)
        target = t * t * (3 - 2 * t)
        distal = [names.index(b) for b in spec["distal"] if b in names]
        proximal = [names.index(b) for b in spec["proximal"] if b in names]
        middle = [names.index(b) for b in spec.get("middle", []) if b in names]
        rows = np.flatnonzero(inside)
        for row in rows:
            d_sum, p_sum = weights[row, distal].sum(), weights[row, proximal].sum()
            if (spec.get("helperBeyondProximal") and middle and allowed[row, distal].any() and allowed[row, middle].any()
                    and not allowed[row, proximal].any()):
                # Limb surface beyond the proximal part's reach: ramp from the helper to the distal joint only.
                m_sum = weights[row, middle].sum()
                d_share = weights[row, distal] / d_sum if d_sum > 1e-9 else np.where(allowed[row, distal], 1.0, 0) / allowed[row, distal].sum()
                m_share = weights[row, middle] / m_sum if m_sum > 1e-9 else np.where(allowed[row, middle], 1.0, 0) / allowed[row, middle].sum()
                mass = max(d_sum + m_sum, 1e-6)
                d = max(0.0, 2 * target[row] - 1)
                weights[row, distal] = d_share * d * mass
                weights[row, middle] = m_share * (1 - d) * mass
                continue
            if not allowed[row, distal].any() or not allowed[row, proximal].any():
                continue
            d_share = weights[row, distal] / d_sum if d_sum > 1e-9 else np.where(allowed[row, distal], 1.0, 0) / allowed[row, distal].sum()
            p_share = weights[row, proximal] / p_sum if p_sum > 1e-9 else np.where(allowed[row, proximal], 1.0, 0) / allowed[row, proximal].sum()
            if middle and allowed[row, middle].any():
                m_sum = weights[row, middle].sum()
                m_share = weights[row, middle] / m_sum if m_sum > 1e-9 else np.where(allowed[row, middle], 1.0, 0) / allowed[row, middle].sum()
                mass = max(d_sum + p_sum + m_sum, 1e-6)
                t = target[row]
                weights[row, distal] = d_share * max(0.0, 2 * t - 1) * mass
                weights[row, middle] = m_share * (1 - abs(2 * t - 1)) * mass
                weights[row, proximal] = p_share * max(0.0, 1 - 2 * t) * mass
                continue
            mass = max(d_sum + p_sum, 1e-6)
            weights[row, distal] = d_share * target[row] * mass
            weights[row, proximal] = p_share * (1 - target[row]) * mass
        blend_facts.append({"joint": spec["joint"], "vertices": int(len(rows))})
    weights = smooth(weights, final_relax)
    for group in list(body.vertex_groups):
        body.vertex_groups.remove(group)
    for name in names:
        body.vertex_groups.new(name=name)
    order = np.argsort(-weights, axis=1)[:, :max_influences]
    for vertex in range(len(points)):
        chosen = [(names[c], weights[vertex, c]) for c in order[vertex] if weights[vertex, c] > 1e-4]
        total = sum(w for _, w in chosen)
        require(total > 0, f"Unweighted vertex {vertex}")
        for name, value in chosen:
            body.vertex_groups[name].add([vertex], float(value / total), "REPLACE")
    modifier = next(mod for mod in body.modifiers if mod.type == "ARMATURE")
    modifier.use_deform_preserve_volume = False
    return {"method": "bone-heat", "joints": len(names), "maxInfluences": max_influences, "relaxationIterations": relax,
            "finalRelaxation": final_relax, "lockedVertices": len(locked), "heatEmptyVertices": empty_before,
            "fallbackVertices": int(empty.sum()), "blends": blend_facts}


def rotate_about(point, rotation):
    point = Vector(point)
    return Matrix.Translation(point) @ rotation.to_4x4() @ Matrix.Translation(-point)


def rot(x=0.0, y=0.0, z=0.0):
    """World-axis rotation in degrees: X pitches (positive tips +Z toward -Y/front), Y rolls, Z yaws."""
    return (Matrix.Rotation(math.radians(z), 3, "Z") @ Matrix.Rotation(math.radians(y), 3, "Y")
            @ Matrix.Rotation(math.radians(x), 3, "X"))


def solve_two_bone(root, target, upper, lower, pole):
    delta = target - root
    distance = min(max(delta.length, abs(upper - lower) + 1e-4), upper + lower - 1e-4)
    direction = delta.normalized()
    along = (upper * upper - lower * lower + distance * distance) / (2 * distance)
    bend = (pole - direction * pole.dot(direction)).normalized()
    return root + direction * along + bend * math.sqrt(max(0.0, upper * upper - along * along))


def aim(head, tail, new_head, new_tail):
    """Rigid transform taking a rest bone segment onto a new segment (minimal twist)."""
    rotation = (Vector(tail) - Vector(head)).rotation_difference(Vector(new_tail) - Vector(new_head))
    return Matrix.Translation(new_head) @ rotation.to_matrix().to_4x4() @ Matrix.Translation(-Vector(head))


def bake_clip(rig, definitions, name, frames, pose_at):
    """pose_at(seconds) -> {bone: armature-space motion matrix}; missing bones inherit their parent."""
    rig.animation_data_create()
    rest = {bone: rig.data.bones[bone].matrix_local.copy() for bone in definitions}
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    for frame in range(frames + 1):
        motions = pose_at(frame / 60.0)
        desired = {}
        for bone, (_, _, parent, _) in definitions.items():
            motion = motions.get(bone)
            if motion is None:
                motion = motions.get(parent, Matrix.Identity(4)) if parent else Matrix.Identity(4)
                motions[bone] = motion
            desired[bone] = motion @ rest[bone]
        for bone, (_, _, parent, _) in definitions.items():
            pose = rig.pose.bones[bone]
            pose.rotation_mode = "QUATERNION"
            parent_inverse = rest[parent] @ desired[parent].inverted() if parent else Matrix.Identity(4)
            pose.matrix_basis = rest[bone].inverted() @ parent_inverse @ desired[bone]
            pose.keyframe_insert(data_path="location", frame=frame)
            pose.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            pose.keyframe_insert(data_path="scale", frame=frame)
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = "LINEAR"
    slot = rig.animation_data.action_slot
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, action)
    strip.action_slot = slot
    strip.extrapolation = "NOTHING"
    strip.blend_type = "REPLACE"
    track.mute = True
    for bone in definitions:
        rig.pose.bones[bone].matrix_basis = Matrix.Identity(4)
    return {"name": name, "frames": frames, "seconds": frames / 60.0}


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))) if b != a else 1.0
    return t * t * (3 - 2 * t)


def export_glb(path, objects, animations=True, tangents=False):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    for track in (objects[0].animation_data.nla_tracks if objects[0].animation_data else []):
        track.mute = False
    result = bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
        export_materials="EXPORT", export_image_format="WEBP", export_image_quality=92,
        export_normals=True, export_tangents=tangents, export_texcoords=True,
        export_skins=True, export_all_influences=False, export_influence_nb=4,
        export_animations=animations, export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_frame_range=False, export_frame_step=1, export_optimize_animation_size=False,
        export_anim_slide_to_zero=False, export_def_bones=False, export_leaf_bone=False,
        export_cameras=False, export_lights=False, export_extras=False,
    )
    require("FINISHED" in result, f"GLB export failed: {path}")


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<III", data)
    require(magic == 0x46546C67 and version == 2 and length == len(data), "Invalid GLB header")
    at, doc, binary = 12, None, b""
    while at < len(data):
        size, kind = struct.unpack_from("<II", data, at)
        payload = data[at + 8:at + 8 + size]
        if kind == 0x4E4F534A:
            doc = json.loads(payload)
        elif kind == 0x004E4942:
            binary = payload
        at += size + 8
    return doc, binary


def write_glb(path, doc, views):
    """Rewrite a GLB with bufferViews given as ordered byte strings (4-byte aligned)."""
    blob = bytearray()
    for index, payload in enumerate(views):
        while len(blob) % 4:
            blob.append(0)
        doc["bufferViews"][index]["byteOffset"] = len(blob)
        doc["bufferViews"][index]["byteLength"] = len(payload)
        blob.extend(payload)
    while len(blob) % 4:
        blob.append(0)
    doc["buffers"] = [{"byteLength": len(blob)}]
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text
    out += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    Path(path).write_bytes(out)


def replace_images(path, replacements, mime="image/webp"):
    """replacements: {image name: bytes}. Keeps all other bufferViews byte-identical."""
    doc, binary = read_glb(path)
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    done = set()
    for image in doc.get("images", []):
        name = image.get("name")
        if name in replacements:
            views[image["bufferView"]] = replacements[name]
            image["mimeType"] = mime
            done.add(name)
    require(done == set(replacements), f"Images not found for replacement: {set(replacements) - done}")
    write_glb(path, doc, views)


def prune_animation(path, tolerance=1e-6):
    """Drop animation channels that hold a node at its rest value for the whole clip (scale 1, fixed bone offsets,
    unposed rotations), then compact accessors and bufferViews. glTF and three.js both resolve a missing channel to
    the node's rest transform, so playback is unchanged."""
    doc, binary = read_glb(path)
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    widths = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

    def floats(index):
        accessor = doc["accessors"][index]
        require(accessor["componentType"] == 5126, "Animation outputs must be float")
        view = doc["bufferViews"][accessor["bufferView"]]
        width = widths[accessor["type"]]
        require(view.get("byteStride", width * 4) == width * 4, "Interleaved animation data is unsupported")
        start = accessor.get("byteOffset", 0)
        data = np.frombuffer(views[accessor["bufferView"]], dtype="<f4", count=accessor["count"] * width, offset=start)
        return data.reshape(accessor["count"], width)

    removed = {"scale": 0, "translation": 0, "rotation": 0}
    kept_channels = 0
    for animation in doc.get("animations", []):
        channels, samplers, remap = [], [], {}
        for channel in animation["channels"]:
            node = doc["nodes"][channel["target"]["node"]]
            kind = channel["target"]["path"]
            values = floats(animation["samplers"][channel["sampler"]]["output"])
            rest = {"scale": node.get("scale", [1, 1, 1]), "translation": node.get("translation", [0, 0, 0]),
                    "rotation": node.get("rotation", [0, 0, 0, 1])}.get(kind)
            if rest is not None:
                rest = np.array(rest, dtype=np.float64)
                error = np.abs(values - rest).max(axis=1)
                if kind == "rotation":
                    error = np.minimum(error, np.abs(values + rest).max(axis=1))
                if error.max() <= (1e-5 if kind == "scale" else tolerance):
                    removed[kind] += 1
                    continue
            if channel["sampler"] not in remap:
                remap[channel["sampler"]] = len(samplers)
                samplers.append(animation["samplers"][channel["sampler"]])
            channel["sampler"] = remap[channel["sampler"]]
            channels.append(channel)
        require(channels, f"Animation {animation.get('name')} lost every channel")
        animation["channels"], animation["samplers"] = channels, samplers
        kept_channels += len(channels)

    used = set()
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            used.update(primitive["attributes"].values())
            if "indices" in primitive:
                used.add(primitive["indices"])
            for target in primitive.get("targets", []):
                used.update(target.values())
    for skin in doc.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    for animation in doc.get("animations", []):
        for sampler in animation["samplers"]:
            used.update((sampler["input"], sampler["output"]))
    order = sorted(used)
    accessor_map = {old: new for new, old in enumerate(order)}
    accessors = [doc["accessors"][old] for old in order]
    used_views = sorted({a["bufferView"] for a in accessors if "bufferView" in a} | {i["bufferView"] for i in doc.get("images", []) if "bufferView" in i})
    view_map = {old: new for new, old in enumerate(used_views)}
    for accessor in accessors:
        if "bufferView" in accessor:
            accessor["bufferView"] = view_map[accessor["bufferView"]]
    for image in doc.get("images", []):
        if "bufferView" in image:
            image["bufferView"] = view_map[image["bufferView"]]
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {key: accessor_map[value] for key, value in primitive["attributes"].items()}
            if "indices" in primitive:
                primitive["indices"] = accessor_map[primitive["indices"]]
    for skin in doc.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = accessor_map[skin["inverseBindMatrices"]]
    for animation in doc.get("animations", []):
        for sampler in animation["samplers"]:
            sampler["input"], sampler["output"] = accessor_map[sampler["input"]], accessor_map[sampler["output"]]
    doc["accessors"] = accessors
    doc["bufferViews"] = [doc["bufferViews"][old] for old in used_views]
    before = Path(path).stat().st_size
    write_glb(path, doc, [views[old] for old in used_views])
    return {"removedChannels": removed, "keptChannels": kept_channels, "bytesBefore": before, "bytesAfter": Path(path).stat().st_size,
            "tolerance": tolerance}
