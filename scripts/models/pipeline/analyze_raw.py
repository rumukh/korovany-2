"""Topology and bounds of a raw TRELLIS GLB on a welded analysis copy (the original file is never modified).

blender -b --factory-startup --python analyze_raw.py -- <asset.glb> <report.json>
"""
import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402

source, target = sys.argv[sys.argv.index("--") + 1:][:2]
report = {"file": Path(source).name, "sha256": k.sha(source), "bytes": Path(source).stat().st_size, "blender": k.blender_facts()}
for weld in (False, True):
    k.setup_scene()
    bpy.ops.import_scene.gltf(filepath=source, disable_bone_shape=True, merge_vertices=weld)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    body = meshes[0]
    body.data.transform(body.matrix_world)
    body.matrix_world.identity()
    if weld:
        k.clean_mesh(body, weld=1e-6)
    points = k.coords(body)
    low, high = points.min(axis=0), points.max(axis=0)
    material = body.data.materials[0] if body.data.materials else None
    images = [n.image for n in material.node_tree.nodes if n.type == "TEX_IMAGE"] if material else []
    entry = {"meshes": len(meshes), "materials": len(body.data.materials), **k.topology_report(body),
             "boundsBlender": {"min": low.tolist(), "max": high.tolist(), "size": (high - low).tolist()},
             "hasCustomNormals": bool(body.data.has_custom_normals), "images": [{"name": i.name, "size": list(i.size)} for i in images]}
    report["welded" if weld else "asExported"] = entry
Path(target).write_text(json.dumps(report, indent=2), encoding="utf-8")
print("RAW-ANALYSIS", json.dumps(report["welded"]))
