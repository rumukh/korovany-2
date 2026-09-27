"""Project an approved, registered rear-view painting onto the back of a raw TRELLIS mesh.

blender -b --factory-startup --python project_rear.py -- <asset.glb> <rear-camera.json> <painting-registered.png> <outDir>
    [--facing0 0.0] [--facing1 0.35] [--gain 1.0]

Only texels whose surface faces the rear camera and are not occluded along the view ray receive paint; the weight
ramps with facing so the sides blend into the TRELLIS texture, and front, face and hidden texels are unchanged.
Outputs: albedo-rear.png (same size and UV layout as the TRELLIS base colour), weights.png, asset-rear.glb (the raw
GLB with only its base-colour image bytes replaced: geometry, UVs and material are byte-identical), reprojection.png
(the repaired mesh rendered from the rear camera next to the painting) and projection.json.
"""
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as km  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
source, camera_path, painting_path, out = Path(args[0]), Path(args[1]), Path(args[2]), Path(args[3])


def option(name, default):
    return float(args[args.index(name) + 1]) if name in args else default


FACING0, FACING1, GAIN = option("--facing0", 0.0), option("--facing1", 0.35), option("--gain", 1.0)
out.mkdir(parents=True, exist_ok=True)
camera = json.loads(camera_path.read_text(encoding="utf-8"))
require = k.require
require(camera["schema"] == "korovany2-projection-camera/1" and camera["view"] == "back", "Unsupported camera")
require(camera["meshSha256"] == k.sha(source), "Camera was rendered from a different mesh")

k.setup_scene()
body = k.import_single_mesh(source, "raw")
clean = k.clean_mesh(body, weld=1e-6)
require(clean == camera["clean"], "Mesh processing differs from render_rear.py")
km.cycles_cpu(1)
material = body.data.materials[0]
texture_node = next(n for n in material.node_tree.nodes if n.type == "TEX_IMAGE")
texture = texture_node.image
size = texture.size[0]
require(texture.size[0] == texture.size[1] and not texture.is_float, "Expected a square 8-bit base colour")
albedo = km.pixels(texture).copy()                      # sRGB-encoded bytes / 255, rows bottom-up

positions, coverage = km.bake_geometry(body, size, "Position")
normals, coverage_n = km.bake_geometry(body, size, "Normal")
coverage &= coverage_n
lengths = np.linalg.norm(normals, axis=2, keepdims=True)
normals = normals / np.maximum(lengths, 1e-8)

paint_image = bpy.data.images.load(str(painting_path))
paint_image.colorspace_settings.name = "sRGB"
pw, ph = paint_image.size
require([pw, ph] == camera["resolution"], "Painting resolution differs from the camera")
paint = km.pixels(paint_image)[..., :3] * GAIN          # rows bottom-up

view = np.array(camera["viewDirection"], dtype=np.float64)   # (0,-1,0): camera looks along -Y
toward_camera = -view
facing = (normals * toward_camera).sum(axis=2)
candidates = coverage & (facing > FACING0)

depsgraph = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(body.evaluated_get(depsgraph), depsgraph)
ys, xs = np.nonzero(candidates)
visible = np.zeros(candidates.shape, dtype=bool)
direction = Vector(toward_camera.tolist())
span = camera["boundsMax"][1] - camera["boundsMin"][1] + 1.0
for y, x in zip(ys.tolist(), xs.tolist()):
    p = positions[y, x]
    n = normals[y, x]
    origin = Vector((p[0] + n[0] * 3e-4, p[1] + n[1] * 3e-4 + 1e-4, p[2] + n[2] * 3e-4))
    hit = bvh.ray_cast(origin, direction, span)
    if hit[0] is None:
        visible[y, x] = True

t = np.clip((facing - FACING0) / (FACING1 - FACING0), 0, 1)
weight = np.where(visible, t * t * (3 - 2 * t), 0.0).astype(np.float32)

cx, cz = camera["centreXZ"]
fw, fh = camera["frameMeters"]
u = (0.5 - (positions[..., 0] - cx) / fw) * pw - 0.5      # image right = world -X
v = (0.5 + (positions[..., 2] - cz) / fh) * ph - 0.5      # rows bottom-up
u0 = np.clip(np.floor(u).astype(int), 0, pw - 2)
v0 = np.clip(np.floor(v).astype(int), 0, ph - 2)
du = np.clip(u - u0, 0, 1)[..., None]
dv = np.clip(v - v0, 0, 1)[..., None]
sampled = (paint[v0, u0] * (1 - du) * (1 - dv) + paint[v0, u0 + 1] * du * (1 - dv) +
           paint[v0 + 1, u0] * (1 - du) * dv + paint[v0 + 1, u0 + 1] * du * dv)
repaired = albedo.copy()
w = weight[..., None]
repaired[..., :3] = np.clip(albedo[..., :3] * (1 - w) + sampled * w, 0, 1)
repaired[..., :3] = km.fill_gutters(repaired[..., :3], coverage)
repaired[..., 3] = 1.0

result = bpy.data.images.new("albedo-rear", size, size, alpha=False)
result.colorspace_settings.name = "sRGB"
km.set_pixels(result, repaired)
result.filepath_raw = str(out / "albedo-rear.png")
result.file_format = "PNG"
result.save()
weights_image = bpy.data.images.new("weights", size, size, alpha=False)
weights_image.colorspace_settings.name = "Non-Color"
km.set_pixels(weights_image, np.dstack([weight, weight, weight, np.ones_like(weight)]))
weights_image.filepath_raw = str(out / "weights.png")
weights_image.file_format = "PNG"
weights_image.save()

# Raw GLB with only the base-colour bytes swapped (PNG, lossless).
doc, binary = k.read_glb(source)
views = [binary[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]] for bv in doc["bufferViews"]]
require(len(doc.get("images", [])) == 1, "Expected one image in the raw GLB")
views[doc["images"][0]["bufferView"]] = (out / "albedo-rear.png").read_bytes()
doc["images"][0]["mimeType"] = "image/png"
k.write_glb(out / "asset-rear.glb", doc, views)

# Reprojection check: render the repaired mesh (unlit) from the rear camera and compare with the painting.
texture.pixels.foreach_set(np.ascontiguousarray(repaired, dtype=np.float32).ravel())
texture.update()
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 16
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = pw, ph
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
nodes, links = material.node_tree.nodes, material.node_tree.links
emission = nodes.new("ShaderNodeEmission")
links.new(texture_node.outputs["Color"], emission.inputs["Color"])
output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
links.new(emission.outputs[0], output.inputs["Surface"])
data = bpy.data.cameras.new("rear")
data.type, data.ortho_scale, data.sensor_fit = "ORTHO", camera["orthoScale"], "AUTO"
cam = bpy.data.objects.new("rear", data)
cam.location = (cx, camera["cameraY"], cz)
cam.rotation_euler = (np.pi / 2, 0.0, np.pi)
scene.collection.objects.link(cam)
scene.camera = cam
scene.render.filepath = str(out / "reprojection-render.png")
bpy.ops.render.render(write_still=True)
rendered = bpy.data.images.load(str(out / "reprojection-render.png"))
rendered_pixels = km.pixels(rendered)
alpha = rendered_pixels[..., 3] > 0.99
difference = np.abs(rendered_pixels[..., :3] - paint).mean(axis=2) * 255

# Facing-bin statistics on the repaired texture (same bins as facing-albedo.py, value = max channel).
value_before = albedo[..., :3].max(axis=2)
value_after = repaired[..., :3].max(axis=2)
torso = coverage & (positions[..., 2] > -0.2) & (positions[..., 2] < 0.25)
back_bin = torso & (normals[..., 1] > 0.5)
front_bin = torso & (normals[..., 1] < -0.5)
report = {
    "schema": "korovany2-rear-projection/1",
    "source": {"file": source.name, "sha256": k.sha(source)},
    "painting": {"file": painting_path.name, "sha256": k.sha(painting_path), "gain": GAIN},
    "camera": {"file": camera_path.name, "sha256": k.sha(camera_path)},
    "facingRamp": [FACING0, FACING1],
    "texels": {"covered": int(coverage.sum()), "candidates": int(candidates.sum()), "visible": int(visible.sum()),
               "painted": int((weight > 0).sum()), "fullyPainted": int((weight > 0.999).sum())},
    "backTorsoValue": {"before": float(value_before[back_bin].mean()), "after": float(value_after[back_bin].mean())},
    "frontTorsoValue": {"before": float(value_before[front_bin].mean()), "after": float(value_after[front_bin].mean())},
    "frontTexelsChanged": int((np.abs(repaired[..., :3] - albedo[..., :3]).max(axis=2)[coverage & (facing <= FACING0)] > 1e-6).sum()),
    "reprojection": {"pixels": int(alpha.sum()), "meanAbsDiff255": float(difference[alpha].mean()),
                     "p95AbsDiff255": float(np.percentile(difference[alpha], 95))},
    "outputs": {"albedo": k.sha(out / "albedo-rear.png"), "glb": k.sha(out / "asset-rear.glb"),
                "glbBytes": (out / "asset-rear.glb").stat().st_size},
    "blender": k.blender_facts(),
}
(out / "projection.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("PROJECT", json.dumps({key: report[key] for key in ("texels", "backTorsoValue", "frontTorsoValue", "frontTexelsChanged", "reprojection")}))
