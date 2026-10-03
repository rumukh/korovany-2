"""Render v3 rights-clean Qwen composition references (grey blockouts) for two batch E landmarks: the Ward-Glass Ribs and the
Ash Cairn.

blender -b --factory-startup --python make_landmark_references_v3.py -- <projects root>

The v2 blockouts (make_landmark_references_v2.py) still gave these two landmarks shapes that Qwen copied literally: smooth
tapering six-sided cones on a smooth disc became candle-like green spikes (Ward-Glass seeds 28501 and 28502), and
equal-sized rounded icosphere stones on a smooth cone became a heap of uniform white balls (Ash Cairn seeds 28601 and
28602). v3 keeps the same backdrop, light and framing (it reuses the v2 script's helpers and copies its framing) but models
what a quarry and a cairn are made of:
- Ward-Glass Ribs: thick six-sided columns of uneven girth, sheared off at slanted, broken tips (one a short cut stump), with
  smaller crystals at their feet, rising from a rough, lumpy outcrop of angular slag blocks.
- Ash Cairn: dry-stacked, flat, angular fieldstone slabs of very different sizes (large footing slabs, smaller stones near the
  top) in loose courses, around a stout, slightly leaning pole with a cross-bar and a short heavy banner.
Writes <asset>/references/blockout-v3.png only. No third-party input.
"""
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Vector

HERE = Path(__file__).resolve().parent
ROOT = Path(sys.argv[sys.argv.index("--") + 1])
# The v2 helpers without its build loop, so v3 uses exactly the v2 backdrop, materials, lights and camera.
source = (HERE / "make_landmark_references_v2.py").read_text(encoding="utf-8").split("\nfor build in (")[0]
v2 = {"__name__": "landmark_references_v2", "__file__": str(HERE / "make_landmark_references_v2.py")}
exec(compile(source, str(HERE / "make_landmark_references_v2.py"), "exec"), v2)
reset, material, add, box, beam, join_meshes, lights, camera = (
    v2[name] for name in ("reset", "material", "add", "box", "beam", "join_meshes", "lights", "camera"))
CLAY, HALF_FOV = v2["CLAY"], v2["HALF_FOV"]


def frame_and_render(asset, obj):
    """The v2 framing (15 degree turn, 18 degree elevation, object about 80 percent of the frame), into blockout-v3.png."""
    # join_meshes keeps the first part's origin; v2's first part sat at the world origin. Put the origin back there so
    # the framing turn is about the world vertical axis and the camera looks at the object's centre.
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    obj.rotation_euler = (0, 0, math.radians(15))
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    height = max(c.z for c in corners)
    reach = max(math.hypot(c.x, c.y) for c in corners)
    size = max(height, 2 * reach)
    target = (0, 0, height * 0.5)
    distance = (size / 0.8 / 2) / math.tan(HALF_FOV)
    elevation = math.radians(18)
    camera((0, -distance * math.cos(elevation), height * 0.5 + distance * math.sin(elevation)), target)
    lights(target, distance)
    out = ROOT / asset / "references"
    out.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(out / "blockout-v3.png")
    bpy.ops.render.render(write_still=True)
    print(f"BLOCKOUT-V3 {asset} height {height:.2f} m, horizontal reach {reach:.2f} m")


def chunk(location, size, mat, rng, jitter=0.18, segments=1):
    """An angular block (a cube with randomly displaced corners and a bevel): slag, a slab or a fieldstone."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for vert in bm.verts:
        vert.co.x *= size[0] * (1 + rng.uniform(-jitter, jitter))
        vert.co.y *= size[1] * (1 + rng.uniform(-jitter, jitter))
        vert.co.z *= size[2] * (1 + rng.uniform(-jitter, jitter))
    bm.to_mesh(obj.data)
    bm.free()
    obj.rotation_euler = Euler((rng.uniform(-0.12, 0.12), rng.uniform(-0.12, 0.12), rng.uniform(0, math.tau)))
    modifier = obj.modifiers.new("bevel", "BEVEL")
    modifier.width = min(size) * (0.08 if segments == 1 else 0.18)
    modifier.segments = segments
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return add(obj, mat, smooth=False)


def column(base, direction, length, radius, tip_cut, mat, rng):
    """A six-sided crystal column of slightly uneven girth, ending in a slanted, sheared face rather than a point."""
    mesh = bpy.data.meshes.new("column")
    bm = bmesh.new()
    sides = 6
    radii = [radius * rng.uniform(0.92, 1.08) for _ in range(sides)]
    tilt = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized()
    low, mid, top = [], [], []
    for i in range(sides):
        angle = i * math.tau / sides
        r = radii[i]
        low.append(bm.verts.new((math.cos(angle) * r, math.sin(angle) * r, 0.0)))
        mid.append(bm.verts.new((math.cos(angle) * r * 0.93, math.sin(angle) * r * 0.93, length * 0.55)))
        offset = (math.cos(angle) * tilt.x + math.sin(angle) * tilt.y) * radius * tip_cut
        top.append(bm.verts.new((math.cos(angle) * r * 0.82, math.sin(angle) * r * 0.82, length + offset)))
    for lower, upper in ((low, mid), (mid, top)):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((lower[i], lower[j], upper[j], upper[i]))
    bm.faces.new(list(reversed(low)))
    bm.faces.new(top)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("column", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = base
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(direction).normalized())
    return add(obj, mat, smooth=False)


def ward_glass():
    reset(1328, 1328)
    rng = random.Random(3805)
    clay = material("clay", CLAY)
    # A rough outcrop: a broad, low mound of angular slag blocks of mixed size, wider than the column cluster.
    for _ in range(34):
        angle = rng.uniform(0, math.tau)
        radius = 2.6 * math.sqrt(rng.uniform(0.02, 1.0))
        width = rng.uniform(0.55, 1.25)
        chunk((math.cos(angle) * radius, math.sin(angle) * radius * 0.9, rng.uniform(0.1, 0.4) * (1.2 - radius / 2.6)),
              (width, width * rng.uniform(0.6, 1.0), rng.uniform(0.35, 0.75)), clay, rng, jitter=0.3)
    # Four columns standing apart and leaning outward like the v2 ribs, of uneven girth and length, with slanted broken tips;
    # the fourth is a short cut stump with a flat quarry face.
    for i, (length, radius, lean, cut) in enumerate(((5.0, 0.6, 0.24, 1.6), (6.2, 0.7, 0.12, 1.2), (4.4, 0.55, 0.32, 2.0),
                                                     (1.6, 0.68, 0.06, 0.0))):
        angle = i * math.pi / 2 + 0.35
        column((math.cos(angle) * 1.05, math.sin(angle) * 1.0, 0.3), (math.cos(angle) * lean, math.sin(angle) * lean, 1.0),
               length, radius, cut, clay, rng)
    # Smaller crystals at the feet of the columns, and a few broken pieces on the outcrop.
    for _ in range(7):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(1.3, 2.2)
        column((math.cos(angle) * radius, math.sin(angle) * radius * 0.9, 0.35), (math.cos(angle) * 0.5, math.sin(angle) * 0.5, 1.0),
               rng.uniform(0.7, 1.6), rng.uniform(0.16, 0.28), 1.5, clay, rng)
    for _ in range(5):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(1.8, 2.6)
        chunk((math.cos(angle) * radius, math.sin(angle) * radius * 0.9, 0.5), (0.3, 0.22, 0.18), clay, rng, jitter=0.35)
    frame_and_render("prop-ward-glass", join_meshes("ward-glass"))


def ash_cairn():
    reset(1328, 1328)
    rng = random.Random(3806)
    clay = material("clay", CLAY)
    # Dry-stacked flat slabs in loose courses: big footing slabs, stones shrinking towards the top, offset between courses;
    # irregular, worn corners rather than bricks.
    courses = [(2.35, 0.8, 14, (1.1, 1.6)), (1.95, 0.75, 12, (0.9, 1.4)), (1.55, 0.7, 10, (0.8, 1.2)),
               (1.15, 0.65, 8, (0.65, 1.0)), (0.75, 0.6, 6, (0.55, 0.8)), (0.38, 0.5, 4, (0.45, 0.6))]
    z = 0.0
    for tier, (ring, thickness, count, (small, large)) in enumerate(courses):
        z += thickness * 0.5
        for k in range(count):
            angle = (k + rng.uniform(-0.25, 0.25) + tier * 0.37) * math.tau / count
            length = rng.uniform(small, large)
            r = ring + rng.uniform(-0.12, 0.12)
            chunk((math.cos(angle) * r, math.sin(angle) * r, z + rng.uniform(-0.06, 0.06)),
                  (length, length * rng.uniform(0.55, 0.85), thickness * rng.uniform(0.6, 0.95)), clay, rng, jitter=0.32, segments=2)
        # The hidden core of each course, so the cairn reads as solid stone rather than a hollow ring.
        if ring > 0.6:
            chunk((0, 0, z), (ring * 1.4, ring * 1.4, thickness * 0.9), clay, rng, jitter=0.1)
        z += thickness * 0.5
    chunk((0.05, 0.0, z + 0.25), (0.75, 0.55, 0.5), clay, rng, jitter=0.3, segments=2)
    # A stout, slightly leaning pole with a cross-bar, and a short heavy banner hanging flat beneath the bar.
    top = Vector((0.18, 0.05, 8.3))
    beam((0, 0, 3.6), top, 0.16, clay)
    beam(top + Vector((-0.65, 0.0, -0.45)), top + Vector((0.65, 0.0, -0.45)), 0.08, clay)
    box((top.x, top.y - 0.17, top.z - 1.15), (1.05, 0.08, 1.35), clay)
    frame_and_render("prop-ash-cairn", join_meshes("ash-cairn"))


for build in (ward_glass, ash_cairn):
    build()
build_hash = bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash
print("REFERENCES-V3-RENDERED", bpy.app.version_string, build_hash)
