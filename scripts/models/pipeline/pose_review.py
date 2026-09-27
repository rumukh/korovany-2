"""Render cooked-character poses with per-vertex edge strain as colour, for rig and clip diagnosis.

blender -b --python pose_review.py -- <cook.blend> <outDir> <clip>:<frame>[,<clip>:<frame>...] [--views front,side,back]
Colour: grey = within 1.25x, yellow to red = stretched up to 3x, cyan to blue = crushed down to 0.3x.
Writes <clip>-<frame>-<view>.png and strain.json (worst vertices and their dominant bones).
"""
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
blend, out, requests = Path(args[0]), Path(args[1]), args[2].split(",")
views = args[args.index("--views") + 1].split(",") if "--views" in args else ["front", "side"]
out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(blend))
scene = bpy.context.scene
rig = next(o for o in scene.objects if o.type == "ARMATURE")
body = next(o for o in scene.objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers))
mesh = body.data
edges = np.empty(len(mesh.edges) * 2, dtype=np.int64)
mesh.edges.foreach_get("vertices", edges)
edges = edges.reshape(-1, 2)
rest = np.empty(len(mesh.vertices) * 3)
mesh.vertices.foreach_get("co", rest)
rest = rest.reshape(-1, 3)
rest_length = np.linalg.norm(rest[edges[:, 0]] - rest[edges[:, 1]], axis=1)
keep = rest_length >= 0.004
groups = {g.index: g.name for g in body.vertex_groups}
dominant = []
for vertex in mesh.vertices:
    best = max(vertex.groups, key=lambda g: g.weight, default=None)
    dominant.append(groups.get(best.group, "?") if best else "?")

scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "VERTEX"
scene.render.resolution_x, scene.render.resolution_y = 700, 900
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
colour = mesh.color_attributes.get("strain") or mesh.color_attributes.new("strain", "FLOAT_COLOR", "POINT")
mesh.color_attributes.active_color = colour
for obj in scene.objects:
    if obj.type == "MESH" and obj is not body:
        obj.hide_render = False
camera_data = bpy.data.cameras.new("review")
camera_data.type = "ORTHO"
camera_data.ortho_scale = 3.0
camera = bpy.data.objects.new("review", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
placements = {"front": ((0, -6, 1.1), (math.radians(90), 0, 0)), "side": ((6, 0, 1.1), (math.radians(90), 0, math.radians(90))),
              "back": ((0, 6, 1.1), (math.radians(90), 0, math.radians(180))), "top": ((0, -3, 5), (math.radians(35), 0, 0))}
report = {}
for request in requests:
    clip, frame = request.split(":")
    frame = int(frame)
    action = bpy.data.actions.get(clip)
    if action is None:
        raise SystemExit(f"no action {clip}")
    rig.animation_data.action = action
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    scene.frame_set(frame)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = body.evaluated_get(depsgraph).to_mesh()
    posed = np.empty(len(evaluated.vertices) * 3)
    evaluated.vertices.foreach_get("co", posed)
    posed = (np.array(body.matrix_world) @ np.c_[posed.reshape(-1, 3), np.ones(len(evaluated.vertices))].T).T[:, :3]
    body.evaluated_get(depsgraph).to_mesh_clear()
    ratio = np.linalg.norm(posed[edges[:, 0]] - posed[edges[:, 1]], axis=1) / np.maximum(rest_length, 1e-9)
    ratio[~keep] = 1.0
    stretch = np.ones(len(rest))
    crush = np.ones(len(rest))
    np.maximum.at(stretch, edges[:, 0], ratio)
    np.maximum.at(stretch, edges[:, 1], ratio)
    np.minimum.at(crush, edges[:, 0], ratio)
    np.minimum.at(crush, edges[:, 1], ratio)
    rgba = np.full((len(rest), 4), (0.7, 0.7, 0.7, 1.0))
    s = np.clip((stretch - 1.25) / 1.75, 0, 1)
    c = np.clip((0.8 - crush) / 0.5, 0, 1)
    rgba[:, 0] = np.where(s > 0, 1.0, rgba[:, 0] * (1 - c))
    rgba[:, 1] = np.where(s > 0, 1.0 - s, rgba[:, 1])
    rgba[:, 2] = np.where(s > 0, 0.0, np.maximum(rgba[:, 2], c))
    colour.data.foreach_set("color", rgba.ravel())
    worst = np.argsort(-stretch)[:12]
    report[request] = {"maxStretch": float(stretch.max()), "minCrush": float(crush.min()),
                       "worst": [{"vertex": int(i), "ratio": round(float(stretch[i]), 2), "bone": dominant[i],
                                  "rest": [round(float(v), 3) for v in rest[i]]} for i in worst]}
    for view in views:
        location, rotation = placements[view]
        camera.location, camera.rotation_euler = location, rotation
        scene.render.filepath = str(out / f"{clip}-{frame}-{view}.png")
        bpy.ops.render.render(write_still=True)
(out / "strain.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print("POSE-REVIEW", json.dumps({key: [value["maxStretch"], value["minCrush"]] for key, value in report.items()}))
