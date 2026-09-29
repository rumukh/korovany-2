"""Render the rights-clean hero stance reference: the soldier mannequin with articulated open hands.

Usage: blender -b --factory-startup --python make_hero_reference.py -- <out.png>
Original geometry only; CPU Cycles so no GPU model job is involved. Everything but the hands matches
make_references.py (same backdrop, clay, lights, camera, proportions and 15 degree turn): the soldier
mannequin's ellipsoid hands read as flat discs, and two-reference hero concepts copied them.
"""
import math
import sys

import bpy
from mathutils import Vector

OUT = sys.argv[sys.argv.index("--") + 1]

BACKDROP = (0.231, 0.212, 0.19, 1.0)
CLAY = (0.42, 0.405, 0.385, 1.0)


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


def add(obj, mat):
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def capsule(name, start, end, radius, mat):
    start, end = Vector(start), Vector(end)
    axis = end - start
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=axis.length, location=(start + end) / 2)
    body = bpy.context.object
    body.rotation_mode = "QUATERNION"
    body.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(axis.normalized())
    add(body, mat)
    body.name = name
    for point in (start, end):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=radius, location=point)
        add(bpy.context.object, mat)
    return body


def ellipsoid(name, location, size, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = size
    obj.name = name
    return add(obj, mat)


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


def hand(side, wrist, arm_dir, mat):
    """Palm facing the thigh, four slightly curled fingers and a forward thumb."""
    medial = Vector((-side, 0.0, 0.0))
    forward = Vector((0.0, -1.0, 0.0))
    palm = wrist + arm_dir * 0.045
    ellipsoid(f"palm{side}", palm, (0.021, 0.043, 0.052), mat, rotation=(0, -side * math.radians(35), 0))
    knuckles = wrist + arm_dir * 0.09
    for index, offset in enumerate((-0.027, -0.009, 0.009, 0.027)):
        base = knuckles + forward * offset
        length = 0.074 if index in (1, 2) else 0.064
        middle = base + arm_dir * length * 0.55 + medial * 0.004
        tip = middle + arm_dir * length * 0.4 + medial * 0.014
        capsule(f"finger{side}{index}a", base, middle, 0.0095, mat)
        capsule(f"finger{side}{index}b", middle, tip, 0.0085, mat)
    thumb = wrist + arm_dir * 0.028 + forward * 0.03
    thumb_mid = thumb + arm_dir * 0.022 + forward * 0.022 + medial * 0.004
    capsule(f"thumb{side}a", thumb, thumb_mid, 0.011, mat)
    capsule(f"thumb{side}b", thumb_mid, thumb_mid + arm_dir * 0.024 + forward * 0.01 + medial * 0.01, 0.0095, mat)


HALF_FOV = math.atan(18 / 70)

scene = reset(928, 1664)
clay = material("clay", CLAY)
height = 1.8
head = height / 7.5
ellipsoid("head", (0, 0, height - head * 0.5), (head * 0.38, head * 0.42, head * 0.5), clay)
capsule("neck", (0, 0, 1.50), (0, 0, 1.58), 0.055, clay)
ellipsoid("chest", (0, 0, 1.34), (0.185, 0.115, 0.17), clay)
ellipsoid("abdomen", (0, 0, 1.10), (0.155, 0.105, 0.17), clay)
ellipsoid("pelvis", (0, 0, 0.93), (0.175, 0.115, 0.12), clay)
for side in (-1, 1):
    shoulder = Vector((side * 0.2, 0, 1.44))
    arm_dir = Vector((side * math.sin(math.radians(35)), 0, -math.cos(math.radians(35))))
    elbow = shoulder + arm_dir * 0.3
    wrist = elbow + arm_dir * 0.26
    ellipsoid(f"deltoid{side}", shoulder, (0.07, 0.065, 0.065), clay)
    capsule(f"upper{side}", shoulder, elbow, 0.048, clay)
    capsule(f"fore{side}", elbow, wrist, 0.04, clay)
    hand(side, wrist, arm_dir, clay)
    capsule(f"thigh{side}", (side * 0.095, 0, 0.9), (side * 0.12, 0, 0.5), 0.07, clay)
    capsule(f"shin{side}", (side * 0.12, 0, 0.5), (side * 0.135, 0, 0.09), 0.052, clay)
    ellipsoid(f"foot{side}", (side * 0.14, -0.06, 0.045), (0.05, 0.12, 0.045), clay)
body = join_meshes("mannequin")
body.rotation_euler = (0, 0, math.radians(15))
target = (0, 0, height * 0.5)
distance = (height / 0.82 / 2) / math.tan(HALF_FOV)
camera((0, -distance, height * 0.5), target)
lights(target, distance)
bpy.context.scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("HERO-REFERENCE-RENDERED", bpy.app.version_string, bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash)
