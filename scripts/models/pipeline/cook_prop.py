"""Cook a korovany-2 static prop (Echo Well) in Blender 5.2.2 LTS from an approved high-detail TRELLIS mesh.

blender -b --factory-startup --python cook_prop.py -- --raw <raw.glb> --recipe <recipe.json> --out <new dir>

The approved raw mesh is kept as the bake source. A decimated copy within the triangle budget receives
base colour baked from the source, a tangent-space normal map baked from the source plus colour-derived
relief, geometric AO, and colour-derived roughness/metalness. One GLB is written per albedo size in the
recipe so the in-game A/B can choose.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as m  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-prop-cook/2", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {name: k.sha(here / name) for name in ("cook_prop.py", "k2cook.py", "k2materials.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()


def normalize_prop(body):
    points = k.coords(body)
    low, high = points.min(axis=0), points.max(axis=0)
    base = points[points[:, 2] < low[2] + (high[2] - low[2]) * 0.03]
    centre = np.array([(base[:, 0].min() + base[:, 0].max()) / 2, (base[:, 1].min() + base[:, 1].max()) / 2, low[2]])
    shifted = points - centre
    yaw = math.radians(recipe.get("yawDegrees", 0.0))
    rotation = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    shifted = shifted @ rotation.T
    reach = float(np.hypot(shifted[:, 0], shifted[:, 1]).max())
    scale = recipe["reachMeters"] / reach
    k.set_coords(body, shifted * scale)
    final = k.coords(body)
    return {"uniformScale": scale, "sourceReach": reach, "reachMeters": recipe["reachMeters"], "yawDegrees": recipe.get("yawDegrees", 0.0),
            "heightMeters": float(final[:, 2].max()), "baseCentre": centre.tolist(),
            "axes": "glTF +Y up/+Z forward -> Blender import -> glTF export_yup; no extra axis rotation"}


def decimate(body, budget):
    triangles = k.triangle_count(body)
    if triangles <= budget:
        return {"applied": False, "triangles": triangles}
    k.select_only(body)
    ratio = budget / triangles * 0.985
    modifier = body.modifiers.new("budget", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return {"applied": True, "before": triangles, "triangles": k.triangle_count(body), "ratio": ratio}


def source_albedo(material):
    return next(n for n in material.node_tree.nodes if n.type == "TEX_IMAGE").outputs["Color"]


def bake(high, body):
    B = recipe["material"]
    bake_size = max(recipe["albedoSizes"])
    maps_size = B["mapsSize"]
    extrusion, distance = B["cageExtrusionMeters"], B["maxRayMeters"]
    m.cycles_cpu(1)
    body.data.materials[0] = body.data.materials[0].copy()
    # Base colour: re-rasterise the approved source colour onto the decimated surface and its UVs.
    colour_image = m.image("bake-colour", bake_size, "sRGB")
    m.bake_selected_to_active(high, body, "EMIT", colour_image, extrusion, distance, emission_from=source_albedo)
    colour = m.pixels(colour_image)[..., :3]
    normal_image = m.image("bake-normal", maps_size, "Non-Color")
    m.bake_selected_to_active(high, body, "NORMAL", normal_image, extrusion, distance)
    geometric_normal = m.pixels(normal_image)[..., :3]
    high.hide_render = True
    m.cycles_cpu(B["aoSamples"])
    ao_image = m.image("bake-ao", maps_size, "Non-Color")
    m.bake_type(body, body.data.materials[0], "AO", ao_image)
    high.hide_render = False
    ao = np.clip(m.pixels(ao_image)[..., 0] ** B["aoPower"], B["aoFloor"], 1)
    factor = bake_size // maps_size
    m.cycles_cpu(1)
    position, coverage = m.bake_geometry(body, maps_size, "Position")
    _, coverage_bake = m.bake_geometry(body, bake_size, "Position")
    linear = m.fill_gutters(m.srgb_to_linear(colour), coverage_bake)
    small = m.linear_to_srgb(m.downsample(linear, factor))
    value = small.max(axis=2)
    saturation = (value - small.min(axis=2)) / np.maximum(value, 1e-4)
    lum = m.luminance(m.srgb_to_linear(small))
    detail = lum - m.blur(lum, 6)
    red, green, blue = small[..., 0], small[..., 1], small[..., 2]
    classes = {
        "moss": (green > red * 1.08) & (green > blue * 1.25) & (saturation > 0.3),
        "salt": (value > 0.72) & (saturation < 0.14),
        "ceramic": (red > green * 1.3) & (saturation > 0.35) & (value > 0.3),
        "stone": (saturation < 0.2) & (value >= 0.22) & (value <= 0.72),
    }
    rough = np.full(value.shape, B["roughness"], dtype=np.float32)
    for name, mask in classes.items():
        rough[mask] = B["roughnessByClass"][name]
    iron = (value < B["metal"]["maxValue"]) & (saturation < B["metal"]["maxSaturation"]) & m.in_boxes(position, B["metal"]["regions"])
    metal = m.blur(iron.astype(np.float32), 1) * B["metal"]["weight"]
    rough = np.where(iron, B["roughnessByClass"]["iron"], rough)
    rough = np.clip(m.blur(rough, 1) - detail * B["roughnessFromDetail"], B["roughnessMin"], B["roughnessMax"])
    relief = m.height_normal(m.blur(detail, 1), B["reliefStrength"])
    normal = m.fill_gutters(m.blend_normals(geometric_normal, relief), coverage) * 2 - 1
    normal = normal / np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6) * 0.5 + 0.5
    ao, rough, metal = (m.fill_gutters(channel, coverage) for channel in (ao, rough, metal))
    ones = np.ones_like(ao)
    normal_final = m.image("prop-normal", maps_size, "Non-Color")
    m.set_pixels(normal_final, np.dstack([normal, ones]))
    orm_final = m.image("prop-orm", maps_size, "Non-Color")
    m.set_pixels(orm_final, np.dstack([ao, rough, metal, ones]))
    bases = {}
    for size in recipe["albedoSizes"]:
        tone = m.linear_to_srgb(m.downsample(linear, bake_size // size) * B["albedoGain"])
        image = m.image(f"prop-base-{size}", size, "sRGB")
        m.set_pixels(image, np.dstack([tone, np.ones(tone.shape[:2])]))
        bases[size] = image
    for image in (normal_final, orm_final, *bases.values()):
        image.pack()
    np.save(out / "normal-geometric.npy", geometric_normal.astype(np.float16))
    for label, array in (("ao", ao), ("roughness", rough), ("metalness", metal)):
        m.encode_webp(np.dstack([array, array, array, ones]), out / f"debug-{label}.webp", 90, "Non-Color")
    return bases, normal_final, orm_final, {
        "bakeSize": bake_size, "mapsSize": maps_size, "albedoSizes": recipe["albedoSizes"], "albedoGain": B["albedoGain"],
        "cageExtrusionMeters": extrusion, "maxRayMeters": distance, "atlasCoverage": float(coverage.mean()),
        "metalFractionOfSurface": float((metal[coverage] > 0.5).mean()),
        "roughnessClassFractions": {name: float(mask[coverage].mean()) for name, mask in classes.items()},
        "roughnessMean": float(rough[coverage].mean()), "aoMean": float(ao[coverage].mean()),
        "provenance": "Base colour re-baked (Cycles CPU, emission, selected-to-active) from the approved TRELLIS source mesh; "
                      "tangent normals baked from the approved source mesh and whiteout-blended with relief derived from colour; "
                      "AO baked from the decimated geometry; roughness and metalness derived from colour. Artistic derivation, not measured PBR."}


def main():
    k.setup_scene()
    body = k.import_single_mesh(args.raw, recipe["id"])
    receipt["rawTopology"] = k.topology_report(body)
    receipt["normalization"] = normalize_prop(body)
    receipt["cleanup"] = k.clean_mesh(body)
    high = body.copy()
    high.data = body.data.copy()
    high.name = f"{recipe['id']}-source"
    bpy.context.scene.collection.objects.link(high)
    receipt["uvBefore"] = m.uv_report(body)
    receipt["decimation"] = decimate(body, recipe["triangleBudget"])
    receipt["uvAfter"] = m.uv_report(body)
    k.select_only(body)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(recipe["smoothAngle"]))
    receipt["topology"] = k.topology_report(body)
    bases, normal, orm, receipt["materials"] = bake(high, body)
    bpy.data.objects.remove(high, do_unlink=True)
    outputs = []
    for size, base in bases.items():
        material = m.gltf_material(recipe["id"], base, normal, orm, recipe["material"]["normalMapStrength"])
        body.data.materials.clear()
        body.data.materials.append(material)
        path = out / f"{recipe['id']}-albedo{size}.glb"
        k.export_glb(path, [body], animations=False, tangents=True)
        doc, _ = k.read_glb(path)
        k.require(len(doc["meshes"]) == 1 and len(doc["meshes"][0]["primitives"]) == 1, "Prop must export one mesh primitive")
        k.require("TANGENT" in doc["meshes"][0]["primitives"][0]["attributes"], "Tangents are required for the baked normal map")
        outputs.append({"file": path.name, "albedoSize": size, "bytes": path.stat().st_size, "sha256": k.sha(path),
                        "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]})
    receipt["outputs"] = outputs
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-review"


try:
    main()
except Exception as error:
    receipt["status"] = "failed"
    receipt["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    receipt["seconds"] = time.monotonic() - started
    (out / "cook.json").write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("K2_COOK=" + json.dumps({key: receipt.get(key) for key in ("status", "error", "outputs")}, default=str))
