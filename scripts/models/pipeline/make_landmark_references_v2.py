"""Render v2 rights-clean Qwen composition references (grey blockouts) for the korovany-2 batch E landmarks.

blender -b --factory-startup --python make_landmark_references_v2.py -- <projects root>

The v1 blockouts (make_landmark_references.py) copied the procedural primitives so literally that Qwen kept them: the first
Ward-Bell concept (seed 18101) painted a straight cone as the bell and plain blocks as piers. v2 keeps each landmark's
layout, camera, light and backdrop (1328 px square, 70 mm lens, about 15 degrees front three-quarter, slightly from above,
about 80 percent of the frame) but gives the shapes the real objects have: a lathed bell with a flared lip and coursed
masonry piers; curved, tapering, branching antlers; an open iron beacon basket with logs and an ice crust; thicker armillary
rings; a cairn mound of irregular stones. Writes <asset>/references/blockout-v2.png. No third-party input.
"""
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Vector

ROOT = Path(sys.argv[sys.argv.index("--") + 1])
BACKDROP = (0.231, 0.212, 0.19, 1.0)   # linear, about sRGB #847e76 warm mid-grey
CLAY = (0.42, 0.405, 0.385, 1.0)
DARK = (0.10, 0.10, 0.10, 1.0)
HALF_FOV = math.atan(18 / 70)


def reset(width, height):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = bpy.data.worlds.new("backdrop")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = BACKDROP
    background.inputs[1].default_value = 1.0
    scene.world = world
    return scene


def material(name, color, roughness=0.65):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def add(obj, mat, smooth=True):
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    return obj


def box(location, size, mat, rotation=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = size
    if bevel:
        bpy.ops.object.transform_apply(scale=True)
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return add(obj, mat, smooth=not bevel)


def cylinder(location, radius, depth, mat, rotation=(0, 0, 0), vertices=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    return add(bpy.context.object, mat)


def sphere(location, radius, mat, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=radius, location=location)
    obj = bpy.context.object
    obj.scale = scale
    return add(obj, mat)


def stone(location, radius, mat, rng, squash=0.75):
    """An irregular rounded fieldstone: a subdivided icosphere with random scale and rotation."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=radius, location=location)
    obj = bpy.context.object
    obj.scale = (rng.uniform(0.8, 1.25), rng.uniform(0.8, 1.25), rng.uniform(0.55, 0.85) * squash / 0.75)
    obj.rotation_euler = Euler((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.uniform(0, math.tau)))
    return add(obj, mat, smooth=False)


def torus(location, major, minor, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=64, minor_segments=12,
                                     location=location, rotation=rotation)
    return add(bpy.context.object, mat)


def tapered(start, end, radius1, radius2, mat, vertices=20):
    """A tapered round segment from start (radius1) to end (radius2)."""
    start, end = Vector(start), Vector(end)
    axis = end - start
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2, depth=axis.length, location=(start + end) / 2)
    obj = bpy.context.object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(axis.normalized())
    return add(obj, mat)


def beam(start, end, radius, mat):
    return tapered(start, end, radius, radius, mat, vertices=24)


def lathe(name, profile, mat, location, segments=64):
    """Revolve an (r, z) profile about +Z into a closed-ring surface."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        ring = [bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for a in (i * math.tau / segments for i in range(segments))]
        rings.append(ring)
    for upper, lower in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((upper[i], upper[j], lower[j], lower[i]))
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    return add(obj, mat)


def masonry_pier(x, y, width, depth, height, base, mat, rng, courses=9):
    """A pier of coursed blocks with slight offsets, so the reference reads as masonry rather than a slab."""
    course = height / courses
    for k in range(courses):
        z = base + course * (k + 0.5)
        if k % 2:
            box((x + rng.uniform(-0.03, 0.03), y, z), (width, depth, course * 0.94), mat, bevel=0.035)
        else:
            for side in (-1, 1):
                box((x + side * width / 4 + rng.uniform(-0.02, 0.02), y, z), (width / 2 * 0.97, depth, course * 0.94), mat, bevel=0.035)


def gabled_roof(width, depth, eave, ridge, mat, overhang=0.35):
    slope = math.atan2(ridge - eave, depth / 2 + overhang)
    board = math.hypot(ridge - eave, depth / 2 + overhang)
    for side in (-1, 1):
        box((0, side * board / 2 * math.cos(slope), ridge - board / 2 * math.sin(slope)),
            (width + 2 * overhang, board, 0.14), mat, rotation=(side * -slope, 0, 0))
    box((0, 0, ridge), (width + 2 * overhang + 0.1, 0.2, 0.2), mat)


def join_meshes(name):
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    return joined


def lights(target, distance):
    for name, direction, energy, size in (
        ("key", (-0.55, -1.0, 0.75), 190.0, 4.0),
        ("fill", (0.8, -0.9, 0.35), 90.0, 5.0),
        ("top", (0.0, 0.2, 1.0), 60.0, 5.0),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy * (distance / 4.3) ** 2
        data.size = size * distance / 4.3
        light = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(light)
        light.location = Vector(target) + Vector(direction).normalized() * distance
        light.rotation_mode = "QUATERNION"
        light.rotation_quaternion = (Vector(target) - light.location).to_track_quat("-Z", "Y")


def camera(location, target, lens=70.0):
    data = bpy.data.cameras.new("camera")
    data.lens = lens
    data.sensor_width = 36.0
    data.sensor_fit = "AUTO"
    cam = bpy.data.objects.new("camera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y")
    bpy.context.scene.camera = cam


def frame_and_render(asset, obj):
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
    bpy.context.scene.render.filepath = str(out / "blockout-v2.png")
    bpy.ops.render.render(write_still=True)
    print(f"BLOCKOUT-V2 {asset} height {height:.2f} m, horizontal reach {reach:.2f} m")


def ward_bell():
    reset(1328, 1328)
    rng = random.Random(1801)
    clay, dark = material("clay", CLAY), material("dark", DARK, 0.9)
    box((0, 0, 0.2), (5.4, 2.6, 0.4), clay, bevel=0.05)
    for side in (-1, 1):
        box((side * 2.2, 0, 0.62), (1.15, 1.35, 0.45), clay, bevel=0.05)
        masonry_pier(side * 2.2, 0, 0.8, 1.0, 5.75, 0.85, clay, rng)
        box((side * 2.2, 0, 6.68), (0.95, 1.1, 0.16), clay, bevel=0.03)
    box((0, 0, 6.95), (5.2, 0.6, 0.55), clay, bevel=0.04)
    for side in (-1, 1):
        box((side * 1.95, 0.31, 6.95), (0.12, 0.03, 0.62), clay)
    box((0, 0, 6.5), (1.2, 0.45, 0.35), clay, bevel=0.03)      # iron yoke under the beam
    # A real bell profile: domed crown, concave waist, thick flared sound bow and lip; a hollow mouth with a dark interior.
    outer = [(0.0, 2.2), (0.3, 2.19), (0.5, 2.1), (0.58, 1.92), (0.6, 1.6), (0.64, 1.25), (0.74, 0.85), (0.9, 0.48),
             (1.06, 0.2), (1.14, 0.05), (1.15, 0.0)]
    inner = [(1.02, 0.0), (0.98, 0.12), (0.86, 0.4), (0.7, 0.8), (0.58, 1.3), (0.5, 1.75), (0.3, 1.95), (0.0, 1.98)]
    lathe("bell", outer + inner[:1], clay, (0, 0, 4.15))
    lathe("bell-inside", inner, dark, (0, 0, 4.15))
    beam((0, 0, 5.9), (0, 0, 4.0), 0.06, clay)
    sphere((0, 0, 3.92), 0.13, clay)
    gabled_roof(4.8, 2.0, 7.3, 8.8, clay)
    # The bell rope, tied tight down the inner face of the right pier.
    beam((0.45, 0.0, 5.0), (1.72, 0.0, 4.6), 0.05, clay)
    beam((1.72, 0.0, 4.6), (1.72, 0.0, 2.0), 0.05, clay)
    frame_and_render("prop-ward-bell", join_meshes("ward-bell"))


def antler(side, mat):
    s = side
    main = [(s * 0.32, 0.0, 6.05), (s * 0.75, 0.05, 6.55), (s * 1.2, 0.12, 7.15), (s * 1.6, 0.2, 7.85), (s * 1.85, 0.24, 8.55), (s * 1.95, 0.22, 9.05)]
    radii = [0.27, 0.24, 0.21, 0.18, 0.14, 0.08]
    for (a, ra), (b, rb) in zip(zip(main, radii), zip(main[1:], radii[1:])):
        tapered(a, b, ra, rb, mat)
        sphere(b, rb, mat)
    for root, tip, r in (((s * 0.75, 0.05, 6.55), (s * 0.55, -0.25, 7.25), 0.15),   # brow tine, forward
                         ((s * 1.2, 0.12, 7.15), (s * 0.95, -0.1, 7.95), 0.13),
                         ((s * 1.6, 0.2, 7.85), (s * 1.4, 0.05, 8.75), 0.11),
                         ((s * 1.85, 0.24, 8.55), (s * 2.3, 0.3, 9.1), 0.1)):
        tapered(root, tip, r, 0.045, mat)
    torus((s * 0.34, 0.0, 6.1), 0.3, 0.07, mat, rotation=(0, math.radians(s * 35), 0))   # iron band at the base


def stag_gate():
    reset(1328, 1328)
    rng = random.Random(1802)
    clay = material("clay", CLAY)
    box((0, 0, 0.15), (5.4, 3.0, 0.3), clay, bevel=0.05)
    for side in (-1, 1):
        masonry_pier(side * 1.9, 0, 0.9, 0.9, 4.3, 0.3, clay, rng, courses=7)
    for i in range(9):
        angle = math.pi * i / 8
        box((math.cos(angle) * 1.9, 0, 4.85 + math.sin(angle) * 1.15), (0.66 + rng.uniform(-0.04, 0.04), 0.85, 0.5),
            clay, rotation=(0, -angle + math.pi / 2, 0), bevel=0.04)
    box((0, 0, 6.02), (0.75, 0.9, 0.22), clay, bevel=0.03)     # keystone cap the antlers are bound to
    box((0, -0.95, 0.75), (1.8, 1.0, 1.0), clay, bevel=0.06)
    for x in (-0.45, 0.45):
        cylinder((x, -0.95, 1.33), 0.22, 0.16, clay)              # two wooden bowls on the altar
    for side in (-1, 1):
        antler(side, clay)
    frame_and_render("prop-stag-gate", join_meshes("stag-gate"))


def frozen_beacon():
    reset(1328, 1328)
    clay = material("clay", CLAY)
    cylinder((0, 0, 5.6), 1.6, 11.2, clay)
    for level in (1.6, 5.4, 9.2):
        cylinder((0, 0, level), 1.78, 0.3, clay)
    for i in range(4):
        angle = i * math.pi / 2 + math.pi / 4
        box((math.cos(angle) * 1.9, math.sin(angle) * 1.9, 2.4), (0.6, 0.9, 4.8), clay, rotation=(0, 0, angle), bevel=0.04)
    cylinder((0, 0, 11.5), 2.1, 0.6, clay)
    for i in range(8):
        angle = i * math.pi / 4
        box((math.cos(angle) * 1.8, math.sin(angle) * 1.8, 12.2), (0.55, 0.45, 0.8), clay, rotation=(0, 0, angle), bevel=0.03)
    # An open wrought-iron basket on a short post: two hoops and eight bars, packed with logs and crusted with ice.
    cylinder((0, 0, 12.2), 0.45, 0.8, clay)
    for z, r in ((12.75, 1.2), (14.0, 1.6)):
        torus((0, 0, z), r, 0.09, clay)
    for i in range(8):
        angle = i * math.pi / 4
        beam((math.cos(angle) * 1.2, math.sin(angle) * 1.2, 12.75), (math.cos(angle) * 1.6, math.sin(angle) * 1.6, 14.05), 0.08, clay)
    for i in range(6):
        angle = i * math.pi / 3 + 0.2
        beam((math.cos(angle) * 1.05, math.sin(angle) * 1.05, 13.0), (-math.cos(angle) * 0.6, -math.sin(angle) * 0.6, 14.05), 0.18, clay)
    sphere((0, 0, 14.05), 1.35, clay, scale=(1.0, 1.0, 0.45))
    for i in range(10):
        angle = i * math.tau / 10
        tapered((math.cos(angle) * 1.56, math.sin(angle) * 1.56, 13.95), (math.cos(angle) * 1.56, math.sin(angle) * 1.56, 13.35),
                0.09, 0.015, clay, vertices=10)
    frame_and_render("prop-frozen-beacon", join_meshes("frozen-beacon"))


def tide_armillary():
    reset(1328, 1328)
    clay = material("clay", CLAY)
    cylinder((0, 0, 3.6), 1.9, 7.2, clay)
    for level in (0.6, 5.9, 7.1):
        cylinder((0, 0, level), 2.35, 0.5, clay)
    for side in (-1, 1):
        box((side * 2.05, 0, 2.6), (0.6, 1.4, 5.2), clay, bevel=0.04)
    beam((0, 0, 7.3), (0, 0, 11.6), 0.16, clay)
    for i in range(3):
        torus((0, 0, 9.4), 2.1, 0.14, clay, rotation=(i * math.pi / 3, i * math.pi / 4, 0.4))
    sphere((0, 0, 9.4), 0.5, clay)
    frame_and_render("prop-tide-armillary", join_meshes("tide-armillary"))


def ward_glass():
    reset(1328, 1328)
    rng = random.Random(1805)
    clay = material("clay", CLAY)
    sphere((0, 0, 0.35), 2.5, clay, scale=(1.0, 0.85, 0.3))
    for i in range(14):
        angle = rng.uniform(0, math.tau)
        radius = rng.uniform(1.2, 2.3)
        stone((math.cos(angle) * radius, math.sin(angle) * radius * 0.85, 0.45), rng.uniform(0.3, 0.5), clay, rng)
    for i, (height, lean) in enumerate(((5.2, 0.18), (6.0, -0.12), (4.6, 0.25), (5.6, -0.2))):
        angle = i * math.pi / 2 + 0.3
        base = (math.cos(angle) * 0.9, math.sin(angle) * 0.9, 0.6)
        top = (math.cos(angle) * (0.9 + height * abs(lean)), math.sin(angle) * (0.9 + height * abs(lean)), 0.6 + height)
        bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.6, radius2=0.08, depth=height,
                                        location=((base[0] + top[0]) / 2, (base[1] + top[1]) / 2, (base[2] + top[2]) / 2))
        rib = add(bpy.context.object, clay, smooth=False)
        rib.rotation_mode = "QUATERNION"
        rib.rotation_quaternion = Vector((0, 0, 1)).rotation_difference((Vector(top) - Vector(base)).normalized())
    frame_and_render("prop-ward-glass", join_meshes("ward-glass"))


def ash_cairn():
    reset(1328, 1328)
    rng = random.Random(1806)
    clay = material("clay", CLAY)
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=2.25, radius2=0.45, depth=3.6, location=(0, 0, 1.8))
    add(bpy.context.object, clay)
    for tier in range(5):
        ring = 2.45 - tier * 0.44
        count = max(4, int(math.tau * ring / 0.95))
        for k in range(count):
            angle = (k + rng.uniform(-0.2, 0.2) + tier * 0.5) * math.tau / count
            stone((math.cos(angle) * ring, math.sin(angle) * ring, 0.35 + tier * 0.72), rng.uniform(0.42, 0.58), clay, rng)
    stone((0, 0, 3.85), 0.6, clay, rng)
    beam((0, 0, 3.5), (0, 0, 8.0), 0.11, clay)
    box((0.06, -0.14, 7.25), (0.9, 0.06, 1.05), clay)          # short heavy banner hanging flat against the pole
    frame_and_render("prop-ash-cairn", join_meshes("ash-cairn"))


for build in (ward_bell, stag_gate, frozen_beacon, tide_armillary, ward_glass, ash_cairn):
    build()
build_hash = bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash
print("REFERENCES-V2-RENDERED", bpy.app.version_string, build_hash)
