"""Fresh UVs for decimated TRELLIS props before their bake (korovany-2, Blender 5.2.2 LTS).

TRELLIS's atlas is many small charts. Faces that fill holes, and edges a heavy decimation collapses across chart seams,
join loops from distant charts into triangles spanning the atlas, which the bake then paints over other charts as
streaks. Props whose base colour is re-baked from the untouched source mesh (through the source's own UVs) do not depend
on the old layout, so they get a clean smart-projected one instead.
"""
import math

import bpy

import k2cook as k
import k2materials as m


def reunwrap(body, B):
    before = m.uv_report(body)
    angle, margin = B.get("uvAngleDegrees", 60.0), B.get("uvIslandMargin", 0.004)
    while body.data.uv_layers:
        body.data.uv_layers.remove(body.data.uv_layers[0])
    body.data.uv_layers.new(name="UVMap")
    k.select_only(body)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    return {"method": "smart_project", "angleLimitDegrees": angle, "islandMargin": margin, "sourceAtlasAfterDecimation": before,
            "after": m.uv_report(body)}
