"""Front/side orthographic clay renders of a normalized raw mesh with metric grids, plus slice measurements,
for placing rig landmarks (cooked metres, Blender axes: +Z up, front faces -Y, character left is +X).

blender -b --factory-startup --python measure_landmarks.py -- <asset.glb> <outDir> <heightMeters> [recipe.json]
With a recipe, its landmarks are drawn as joints and bones on both views (landmarks.json + PNGs).
"""
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
source, out, height = Path(args[0]), Path(args[1]), float(args[2])
recipe = json.loads(Path(args[3]).read_text(encoding="utf-8")) if len(args) > 3 else None
out.mkdir(parents=True, exist_ok=True)

k.setup_scene()
body = k.import_single_mesh(source, "body")
normalization = k.normalize(body, height, recipe.get("yawDegrees", 0.0) if recipe else 0.0)
k.clean_mesh(body)
points = k.coords(body)
low, high = points.min(axis=0), points.max(axis=0)

# Slice measurements every 2 cm: x-extent of vertices near the midline (|x| < 0.35) and of the arms.
slices = []
for z in np.arange(0.0, high[2], 0.02):
    band = points[np.abs(points[:, 2] - z) < 0.01]
    if not len(band):
        continue
    core = band[np.abs(band[:, 0]) < 0.34]
    slices.append({"z": round(float(z), 3), "xMin": round(float(band[:, 0].min()), 3), "xMax": round(float(band[:, 0].max()), 3),
                   "coreXMin": round(float(core[:, 0].min()), 3) if len(core) else None,
                   "coreXMax": round(float(core[:, 0].max()), 3) if len(core) else None,
                   "yMin": round(float(band[:, 1].min()), 3), "yMax": round(float(band[:, 1].max()), 3)})

# Arms: vertices far from the midline, per side; principal axis and radius profile along it.
arms = {}
for side, sign in (("l", 1), ("r", -1)):
    selected = points[(sign * points[:, 0] > 0.36) & (points[:, 2] > 0.9)]
    centre = selected.mean(axis=0)
    _, _, vt = np.linalg.svd(selected - centre, full_matrices=False)
    axis = vt[0] * (1 if (vt[0][0] * sign) > 0 else -1)
    t = (selected - centre) @ axis
    radial = np.linalg.norm((selected - centre) - np.outer(t, axis), axis=1)
    profile = []
    for step in np.arange(t.min(), t.max(), 0.02):
        ring = (t >= step) & (t < step + 0.02)
        if ring.sum() > 8:
            point = centre + axis * (step + 0.01)
            profile.append({"t": round(float(step + 0.01), 3), "radius": round(float(np.percentile(radial[ring], 90)), 3),
                            "at": [round(float(v), 3) for v in point]})
    tip = selected[np.argmax(sign * selected[:, 0])]
    arms[side] = {"axis": axis.round(4).tolist(), "centre": centre.round(4).tolist(), "tip": tip.round(4).tolist(), "profile": profile}

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world
sun_data = bpy.data.lights.new("key", "SUN")
sun_data.energy = 2.0
sun = bpy.data.objects.new("key", sun_data)
sun.rotation_euler = (math.radians(50), math.radians(20), math.radians(-30))
scene.collection.objects.link(sun)
clay = bpy.data.materials.new("clay")
clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
body.data.materials.clear()
body.data.materials.append(clay)
PX_PER_M = 400
views = {
    "front": {"location": (0, -5, height / 2), "rotation": (math.radians(90), 0, 0), "right": (1, 0, 0), "span": (low[0], high[0])},
    "side": {"location": (5, 0, height / 2), "rotation": (math.radians(90), 0, math.radians(90)), "right": (0, 1, 0), "span": (low[1], high[1])},
}
frame = {}
for name, view in views.items():
    width_m = max(abs(view["span"][0]), abs(view["span"][1])) * 2 + 0.2
    height_m = height + 0.2
    data = bpy.data.cameras.new(name)
    data.type = "ORTHO"
    data.ortho_scale = max(width_m, height_m)
    camera = bpy.data.objects.new(name, data)
    camera.location = view["location"]
    camera.rotation_euler = view["rotation"]
    scene.collection.objects.link(camera)
    scene.camera = camera
    scene.render.resolution_x = round(width_m * PX_PER_M) if width_m >= height_m else round(width_m * PX_PER_M)
    scene.render.resolution_y = round(height_m * PX_PER_M)
    data.sensor_fit = "VERTICAL" if height_m >= width_m else "HORIZONTAL"
    scene.render.filepath = str(out / f"{name}-clay.png")
    bpy.ops.render.render(write_still=True)
    frame[name] = {"widthMeters": width_m, "heightMeters": height_m, "pxPerMeter": PX_PER_M, "centre": [0.0, height / 2],
                   "right": list(view["right"])}

report = {"normalization": normalization, "bounds": {"min": low.round(4).tolist(), "max": high.round(4).tolist()},
          "slices": slices, "arms": arms, "frames": frame, "landmarks": recipe["landmarks"] if recipe else None}
(out / "landmarks.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print("MEASURE", json.dumps({"bounds": report["bounds"], "armTips": {s: arms[s]["tip"] for s in arms}}))
