"""Render rights-clean Qwen composition references for korovany-2 concepts.

Usage: blender -b --factory-startup --python make_references.py -- <soldier.png> <well.png>
Original geometry only; CPU Cycles so no GPU model job is involved.
"""
import math
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
SOLDIER_OUT, WELL_OUT = args[0], args[1]

BACKDROP = (0.231, 0.212, 0.19, 1.0)   # linear, about sRGB #847e76 warm mid-grey
CLAY = (0.42, 0.405, 0.385, 1.0)
DARK = (0.10, 0.10, 0.10, 1.0)


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


def box(name, location, size, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
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


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


HALF_FOV = math.atan(18 / 70)

# Soldier stance: relaxed A-pose mannequin, ~7.5 heads, arms ~35 degrees, feet shoulder-width.
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
    ellipsoid(f"hand{side}", wrist + arm_dir * 0.08, (0.03, 0.05, 0.08), clay, rotation=(0, side * math.radians(35), 0))
    thumb = wrist + arm_dir * 0.03 + Vector((0, -0.04, 0))
    capsule(f"thumb{side}", thumb, thumb + Vector((side * -0.01, -0.03, -0.04)), 0.012, clay)
    capsule(f"thigh{side}", (side * 0.095, 0, 0.9), (side * 0.12, 0, 0.5), 0.07, clay)
    capsule(f"shin{side}", (side * 0.12, 0, 0.5), (side * 0.135, 0, 0.09), 0.052, clay)
    ellipsoid(f"foot{side}", (side * 0.14, -0.06, 0.045), (0.05, 0.12, 0.045), clay)
body = join_meshes("mannequin")
body.rotation_euler = (0, 0, math.radians(15))
target = (0, 0, height * 0.5)
distance = (height / 0.82 / 2) / math.tan(HALF_FOV)
camera((0, -distance, height * 0.5), target)
lights(target, distance)
render(SOLDIER_OUT)

# Echo Well blockout: plinth, stone curb, two posts, windlass, gabled roof, bucket.
scene = reset(1328, 1328)
clay = material("clay", CLAY)
dark = material("shaft", DARK, 0.9)
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=2.6, depth=0.16, location=(0, 0, 0.08))
add(bpy.context.object, clay)
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=1.3, depth=1.0, location=(0, 0, 0.66))
add(bpy.context.object, clay)
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.95, depth=0.02, location=(0, 0, 1.165))
add(bpy.context.object, dark)
for side in (-1, 1):
    box(f"post{side}", (side * 1.45, 0, 1.9), (0.24, 0.24, 3.5), clay)
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.12, depth=3.0, location=(0, 0, 2.3), rotation=(0, math.radians(90), 0))
add(bpy.context.object, clay)
box("crank", (1.72, -0.18, 2.3), (0.08, 0.36, 0.08), clay)
ridge_height = 4.55
slope = math.radians(38)
board = 1.9
for side in (-1, 1):
    box(f"roof{side}", (0, side * board / 2 * math.cos(slope), ridge_height - board / 2 * math.sin(slope)),
        (3.6, board, 0.12), clay, rotation=(side * -slope, 0, 0))
    box(f"collar{side}", (side * 1.45, 0, 3.72), (0.16, 2.2, 0.16), clay)
box("ridge", (0, 0, ridge_height), (3.7, 0.18, 0.18), clay)
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.2, depth=0.34, location=(0.9, -0.6, 1.33))
add(bpy.context.object, clay)
well = join_meshes("well")
well.rotation_euler = (0, 0, math.radians(15))
target = (0, 0, 2.2)
distance = (5.6 / 0.8 / 2) / math.tan(HALF_FOV)
elevation = math.radians(18)
camera((0, -distance * math.cos(elevation), 2.2 + distance * math.sin(elevation)), target)
lights(target, distance)
render(WELL_OUT)
build = bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash
print("REFERENCES-RENDERED", bpy.app.version_string, build)

