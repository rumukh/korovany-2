"""Render rights-clean Qwen composition references (grey blockouts) for the korovany-2 batch F pickups.

blender -b --factory-startup --python make_pickup_references.py -- <projects root>

Small hand-sized props at the game's pickup sizes (0.35 to 0.5 m), at the Echo Well reference's camera, light and
warm-grey backdrop (make_references.py): 1328 px square, 70 mm lens, about 15 degrees front three-quarter, seen slightly
from above, the object filling about 70 percent of the frame. Writes <asset>/references/blockout.png. No third-party input.
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(sys.argv[sys.argv.index("--") + 1])
BACKDROP = (0.231, 0.212, 0.19, 1.0)
CLAY = (0.42, 0.405, 0.385, 1.0)
HALF_FOV = math.atan(18 / 70)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 1328
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = bpy.data.worlds.new("backdrop")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = BACKDROP
    scene.world = world
    mat = bpy.data.materials.new("clay")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = CLAY
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.65
    return mat


def finish(obj, mat):
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def sphere(location, radius, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=radius, location=location)
    obj = bpy.context.object
    obj.scale = scale
    return finish(obj, mat)


def box(location, size, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.modifier_add(type="BEVEL")
    obj.modifiers[-1].width = min(size) * 0.08
    obj.modifiers[-1].segments = 3
    return finish(obj, mat)


def cylinder(location, radius, depth, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=radius, depth=depth, location=location, rotation=rotation)
    return finish(bpy.context.object, mat)


def torus(location, major, minor, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=location, rotation=rotation)
    return finish(bpy.context.object, mat)


def render(asset):
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.rotation_euler = (0, 0, math.radians(15))
    bpy.context.view_layer.update()
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    height = max(c.z for c in corners)
    reach = max(math.hypot(c.x, c.y) for c in corners)
    size = max(height, 2 * reach)
    target = (0, 0, height * 0.5)
    distance = (size / 0.7 / 2) / math.tan(HALF_FOV)
    elevation = math.radians(22)
    data = bpy.data.cameras.new("camera")
    data.lens = 70.0
    data.sensor_width = 36.0
    cam = bpy.data.objects.new("camera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = (0, -distance * math.cos(elevation), height * 0.5 + distance * math.sin(elevation))
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (Vector(target) - Vector(cam.location)).to_track_quat("-Z", "Y")
    bpy.context.scene.camera = cam
    for name, direction, energy, area in (("key", (-0.55, -1.0, 0.75), 190.0, 4.0), ("fill", (0.8, -0.9, 0.35), 90.0, 5.0), ("top", (0.0, 0.2, 1.0), 60.0, 5.0)):
        light_data = bpy.data.lights.new(name, "AREA")
        light_data.energy = energy * (distance / 4.3) ** 2
        light_data.size = area * distance / 4.3
        light = bpy.data.objects.new(name, light_data)
        bpy.context.scene.collection.objects.link(light)
        light.location = Vector(target) + Vector(direction).normalized() * distance
        light.rotation_mode = "QUATERNION"
        light.rotation_quaternion = (Vector(target) - light.location).to_track_quat("-Z", "Y")
    out = ROOT / asset / "references"
    out.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(out / "blockout.png")
    bpy.ops.render.render(write_still=True)
    print(f"BLOCKOUT {asset} height {height:.3f} m, horizontal reach {reach:.3f} m")


# Coin purse: a bulging pouch gathered at the neck, a tied cord collar and three coins on the ground beside it.
mat = reset()
sphere((0, 0, 0.14), 0.16, (1.0, 0.9, 0.88), mat)
cylinder((0, 0, 0.29), 0.07, 0.06, mat)
torus((0, 0, 0.27), 0.08, 0.018, mat)
sphere((0, 0, 0.35), 0.075, (1.0, 1.0, 0.7), mat)
for i, (x, y) in enumerate(((0.2, -0.08), (0.24, 0.05), (-0.19, -0.1))):
    cylinder((x, y, 0.008 + i * 0.002), 0.045, 0.012, mat, rotation=(0, 0, i))
render("prop-pickup-coin")

# Health satchel: a small boxy satchel with a flap, a rolled bandage strapped on top and a short carrying loop.
mat = reset()
box((0, 0, 0.13), (0.34, 0.16, 0.26), mat)
box((0, -0.02, 0.22), (0.35, 0.18, 0.1), mat, rotation=(math.radians(-8), 0, 0))
cylinder((0, 0, 0.3), 0.05, 0.26, mat, rotation=(0, math.radians(90), 0))
torus((0, 0, 0.3), 0.09, 0.012, mat, rotation=(math.radians(90), 0, 0))
render("prop-pickup-health")

# Supply bundle: a small slatted crate with a rope band and a sack lashed on top.
mat = reset()
box((0, 0, 0.17), (0.46, 0.38, 0.34), mat)
box((0, 0, 0.17), (0.48, 0.06, 0.36), mat)
sphere((0.02, 0.02, 0.4), 0.15, (1.2, 0.85, 0.5), mat)
render("prop-pickup-supply")
build_hash = bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash
print("REFERENCES-RENDERED", bpy.app.version_string, build_hash)
