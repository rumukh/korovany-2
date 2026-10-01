"""Cook the korovany-2 convoy cargo load (a static prop) in Blender 5.2.2 LTS from an approved TRELLIS mesh.

blender -b --factory-startup --python cook_cargo.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir> [--measure]

The approved mesh is yawed so its long side runs along the wagon (Blender -Y is the wagon's front), uniformly scaled to
fit inside the open bed (`fit`: width X, length Y, height Z in metres), and placed with its footprint centre at the
origin and its lowest point at z = 0, where the convoy's socket-cargo sits. It is cleaned, decimated to budget, given
fresh smart-projected UVs (k2uv) and re-baked like the character bodies: base colour from the approved source, tangent
normals from the source plus colour relief, AO, and roughness and metalness derived from colour inside declared regions.
The cargo is never dyed, so its base alpha is opaque and it shares the plain prop material program.
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
import k2rig as r  # noqa: E402
import k2sheet as g  # noqa: E402
import k2uv as u  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--measure", action="store_true", help="report the normalized raw mesh and stop")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-cargo-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {name: k.sha(here / name) for name in ("cook_cargo.py", "k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py", "k2uv.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()


def normalize(body, N):
    points = k.coords(body)
    yaw = math.radians(N.get("yawDegrees", 0.0))
    rotation = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    points = points @ rotation.T
    low, high = points.min(axis=0), points.max(axis=0)
    size = high - low
    fit = np.array(N["fit"], dtype=np.float64)
    scale = float((fit / size).min())
    centre = np.array([(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2]])
    k.set_coords(body, (points - centre) * scale)
    final = k.coords(body)
    return {"uniformScale": scale, "yawDegrees": N.get("yawDegrees", 0.0), "fit": N["fit"],
            "size": (final.max(axis=0) - final.min(axis=0)).round(4).tolist(),
            "limitingAxis": "XYZ"[int((fit / size).argmin())],
            "axes": "glTF +Y up/+Z forward -> Blender import -> glTF export_yup; no extra axis rotation"}


def measure(body):
    points = k.coords(body)
    report = {"bounds": [points.min(axis=0).round(3).tolist(), points.max(axis=0).round(3).tolist()]}
    for z in np.linspace(0.05, float(points[:, 2].max()) - 0.02, 6):
        band = np.abs(points[:, 2] - z) < 0.02
        if band.any():
            report[f"slice{z:.2f}"] = [points[band].min(axis=0).round(3).tolist(), points[band].max(axis=0).round(3).tolist()]
    return report


def main():
    k.setup_scene()
    receipt["stage"] = "import"
    body = k.import_single_mesh(args.raw, recipe["id"])
    receipt["rawTopology"] = k.topology_report(body)
    receipt["groundSheet"] = g.remove_ground_sheet(body, recipe.get("groundSheet"))
    receipt["normalization"] = normalize(body, recipe["normalize"])
    if args.measure:
        receipt["measure"] = measure(body)
        receipt["status"] = "measured"
        return
    receipt["stage"] = "clean"
    receipt["cleanup"] = k.clean_mesh(body)
    receipt["specks"] = r.keep_largest(body, recipe.get("minComponentFraction", 0.002))
    receipt["holes"] = r.fill_small_holes(body, recipe.get("fillHoleSides", 24))
    high = body.copy()
    high.data = body.data.copy()
    high.name = f"{recipe['id']}-source"
    bpy.context.scene.collection.objects.link(high)
    receipt["decimation"] = r.decimate(body, recipe["triangleBudget"])
    # The decimation lifts the lowest vertices a few millimetres; put the footprint back on socket-cargo's plane and
    # move the bake source with it so the two stay aligned.
    lowest = float(k.coords(body)[:, 2].min())
    for obj in (body, high):
        k.set_coords(obj, k.coords(obj) - np.array([0.0, 0.0, lowest]))
    receipt["decimation"]["regroundMeters"] = round(lowest, 5)
    k.select_only(body)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(recipe.get("smoothAngle", 35)))
    receipt["topology"] = k.topology_report(body)
    k.require(receipt["topology"]["triangles"] <= recipe["triangleBudget"], "Cargo exceeds its triangle budget")
    receipt["stage"] = "materials"
    receipt["uv"] = u.reunwrap(body, recipe["body"])
    receipt["materials"] = r.bake_body(recipe, high, body, out)
    # k2rig's generic provenance text describes the troops' rear-view projection and tone calibration; the recipe
    # states what this asset's bake actually did.
    k.require("provenance" in recipe["body"], "recipe body.provenance must describe this bake")
    receipt["materials"]["provenance"] = recipe["body"]["provenance"]
    base = bpy.data.images["body-base"]
    pixels = m.pixels(base)
    pixels[..., 3] = 1.0
    m.set_pixels(base, pixels)
    base.pack()
    receipt["materials"]["dye"] = "none: base alpha set opaque"
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "export"
    path = out / f"{recipe['id']}.glb"
    k.export_glb(path, [body], animations=False, tangents=True)
    k.replace_images(path, {"body-orm": m.encode_webp(m.pixels(bpy.data.images["body-orm"]), out / "body-orm.webp",
                                                      recipe["ormQuality"], "Non-Color")})
    doc, _ = k.read_glb(path)
    k.require(len(doc["meshes"]) == 1 and len(doc["meshes"][0]["primitives"]) == 1, "Cargo must export one mesh primitive")
    k.require("TANGENT" in doc["meshes"][0]["primitives"][0]["attributes"], "Tangents are required for the baked normal map")
    receipt["output"] = {"file": path.name, "bytes": path.stat().st_size, "sha256": k.sha(path),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-verification"
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
