"""Orthographic back-view renders of a raw TRELLIS mesh for a rear-view concept, plus the exact projection camera.

blender -b --factory-startup --python render_rear.py -- <asset.glb> <outDir> [width height]

Writes rear-clay.png (structure reference for Qwen, concept backdrop colour), rear-albedo.png (the raw TRELLIS
back, unlit), rear-mask.png (exact silhouette) and rear-camera.json (everything project_rear.py needs to map a
painted pixel back onto the mesh). The mesh is processed exactly as project_rear.py processes it. CPU Cycles only.
"""
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as km  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
backdrop_arg = None
if "--backdrop" in args:
    at = args.index("--backdrop")
    backdrop_arg = tuple(int(v) for v in args[at + 1].split(","))
    del args[at:at + 2]
source, out = Path(args[0]), Path(args[1])
width, height = (int(args[2]), int(args[3])) if len(args) >= 4 else (928, 1664)
out.mkdir(parents=True, exist_ok=True)
# Measured corners of the approved front concept (soldier 4101 by default; heroes pass their own with --backdrop).
BACKDROP_SRGB = backdrop_arg or (193, 185, 168)
CLAY = (0.42, 0.42, 0.42, 1.0)


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def load_clean(path):
    """Shared with project_rear.py: welded, loose geometry removed, identity transform, raw TRELLIS frame."""
    k.setup_scene()
    body = k.import_single_mesh(path, "raw")
    report = k.clean_mesh(body, weld=1e-6)
    return body, report


def camera_for(body, width, height, margin_w=1.12, margin_h=1.06):
    points = k.coords(body)
    low, high = points.min(axis=0), points.max(axis=0)
    aspect = width / height
    frame_h = max((high[2] - low[2]) * margin_h, (high[0] - low[0]) * margin_w / aspect)
    frame_w = frame_h * aspect
    centre = [(low[0] + high[0]) / 2, (low[2] + high[2]) / 2]
    return {"schema": "korovany2-projection-camera/1", "view": "back", "type": "ORTHO",
            "resolution": [width, height], "frameMeters": [frame_w, frame_h], "orthoScale": max(frame_w, frame_h),
            "centreXZ": centre, "viewDirection": [0, -1, 0], "imageRight": [-1, 0, 0], "imageUp": [0, 0, 1],
            "cameraY": float(high[1] + 2.0), "boundsMin": low.tolist(), "boundsMax": high.tolist(),
            "mapping": "u_px = (0.5 - (x - cx) / frameW) * width; v_px_from_top = (0.5 - (z - cz) / frameH) * height"}


def main():
    body, report = load_clean(source)
    cam = camera_for(body, width, height)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = bpy.data.worlds.new("backdrop")
    world.use_nodes = True
    backdrop_linear = [srgb_to_linear(c) for c in BACKDROP_SRGB]
    world.node_tree.nodes["Background"].inputs[0].default_value = (*backdrop_linear, 1.0)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world

    data = bpy.data.cameras.new("rear")
    data.type = "ORTHO"
    data.ortho_scale = cam["orthoScale"]
    data.sensor_fit = "AUTO"
    camera = bpy.data.objects.new("rear", data)
    camera.location = (cam["centreXZ"][0], cam["cameraY"], cam["centreXZ"][1])
    camera.rotation_euler = (math.radians(90), 0.0, math.radians(180))
    scene.collection.objects.link(camera)
    scene.camera = camera

    sun_data = bpy.data.lights.new("key", "SUN")
    sun_data.energy = 3.0
    sun_data.angle = math.radians(12)
    sun = bpy.data.objects.new("key", sun_data)
    # Light travels away from the camera (-Y), downward, toward image right (-X): lit from the viewer's upper left.
    from mathutils import Vector
    sun.rotation_euler = Vector((-0.35, -0.55, -0.76)).normalized().to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(sun)

    original = body.data.materials[0]
    clay = bpy.data.materials.new("clay")
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = CLAY
    clay.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7
    body.data.materials[0] = clay
    scene.render.filepath = str(out / "rear-clay-rgba.png")
    bpy.ops.render.render(write_still=True)

    # Unlit TRELLIS albedo from the same camera.
    body.data.materials[0] = original
    nodes, links = original.node_tree.nodes, original.node_tree.links
    texture = next(n for n in nodes if n.type == "TEX_IMAGE")
    output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
    emission = nodes.new("ShaderNodeEmission")
    links.new(texture.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs[0], output.inputs["Surface"])
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.filepath = str(out / "rear-albedo-rgba.png")
    bpy.ops.render.render(write_still=True)

    # Compositing over the backdrop and the silhouette mask are written by composite_rear.py (system Python + PIL).
    cam["backdropSrgb"] = list(BACKDROP_SRGB)
    cam["meshSha256"] = k.sha(source)
    cam["clean"] = report
    cam["blender"] = k.blender_facts()
    (out / "rear-camera.json").write_text(json.dumps(cam, indent=2), encoding="utf-8")
    print("REAR", json.dumps({k2: cam[k2] for k2 in ("resolution", "frameMeters", "centreXZ")}))


main()
