"""Render rights-clean Qwen composition references for the korovany-2 batch C wagons, draft ox and cargo load.

Usage: blender -b --factory-startup --python make_wagon_references.py -- <out dir> [convoy|shipment|ox|ox-v3|cargo ...]
(default: all; `ox` is the second-round ox blockout, `ox-v3` the third)
Original grey blockouts only (proportion, layout and camera), rendered with CPU Cycles so no GPU model job is involved.
Blender coordinates: metres, +Z up, the object's front faces -Y (the game's +Z after glTF export).
"""
import math
import sys
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

OUT = Path(sys.argv[sys.argv.index("--") + 1:][0])
OUT.mkdir(parents=True, exist_ok=True)

BACKDROP = (0.231, 0.212, 0.19, 1.0)   # linear, about sRGB #847e76 warm mid-grey
CLAY = (0.42, 0.405, 0.385, 1.0)
DARK = (0.06, 0.06, 0.065, 1.0)


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


def box(location, size, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = size
    return add(obj, mat, smooth=False)


def cylinder(location, radius, depth, mat, rotation=(0, 0, 0), vertices=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    return add(bpy.context.object, mat)


def ellipsoid(location, size, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = size
    return add(obj, mat)


def capsule(start, end, radius, mat):
    start, end = Vector(start), Vector(end)
    axis = end - start
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=axis.length, location=(start + end) / 2)
    body = bpy.context.object
    body.rotation_mode = "QUATERNION"
    body.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(axis.normalized())
    add(body, mat)
    for point in (start, end):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=radius, location=point)
        add(bpy.context.object, mat)
    return body


def torus(location, major, minor, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=48, minor_segments=16,
                                     location=location, rotation=rotation)
    return add(bpy.context.object, mat)


def wheel(centre, radius, width, spokes, mat):
    x, y, z = centre
    torus((x, y, z), radius - 0.035, 0.04, mat, rotation=(0, math.radians(90), 0))
    cylinder((x, y, z), 0.09, width * 2.2, mat, rotation=(0, math.radians(90), 0), vertices=24)
    for index in range(spokes):
        angle = 2 * math.pi * index / spokes
        direction = Vector((0, math.cos(angle), math.sin(angle)))
        capsule(Vector(centre) + direction * 0.08, Vector(centre) + direction * (radius - 0.06), 0.022, mat)


def join_all(name, rotation_z_degrees):
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    # The join keeps the active part's transform; bake it so the blockout's own frame is the world frame.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    joined.rotation_euler = (0, 0, math.radians(rotation_z_degrees))
    bpy.context.view_layer.update()
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


def frame(obj, target, elevation_degrees, fill=0.8, lens=70.0):
    """70 mm camera on -Y, raised by `elevation`, pulled back until the object's projected extent fills `fill` of the
    frame on its limiting axis, then re-centred on the projected bounds."""
    scene = bpy.context.scene
    data = bpy.data.cameras.new("camera")
    data.lens = lens
    data.sensor_width = 36.0
    data.sensor_fit = "AUTO"
    cam = bpy.data.objects.new("camera", data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_mode = "QUATERNION"
    elevation = math.radians(elevation_degrees)
    corners = [obj.matrix_world @ Vector(v.co) for v in obj.data.vertices]
    target = Vector(target)
    distance = 12.0
    for _ in range(8):
        offset = Vector((0, -math.cos(elevation), math.sin(elevation))) * distance
        cam.location = target + offset
        cam.rotation_quaternion = (target - cam.location).to_track_quat("-Z", "Y")
        bpy.context.view_layer.update()
        projected = [world_to_camera_view(scene, cam, point) for point in corners]
        xs = [p.x for p in projected]
        ys = [p.y for p in projected]
        extent = max(max(xs) - min(xs), max(ys) - min(ys))
        distance *= extent / fill
        # Re-centre: shift the target by the projected centre's offset from the frame centre.
        centre_x, centre_y = (max(xs) + min(xs)) / 2 - 0.5, (max(ys) + min(ys)) / 2 - 0.5
        right = cam.rotation_quaternion @ Vector((1, 0, 0))
        up = cam.rotation_quaternion @ Vector((0, 1, 0))
        width = 2 * distance * math.tan(math.atan(18 / lens))
        aspect = scene.render.resolution_y / scene.render.resolution_x
        target = target + right * centre_x * width + up * centre_y * width * aspect
    lights(target, distance)
    return {"distance": distance, "target": list(target), "elevation": elevation_degrees}


def render(path):
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def chassis(clay, front_radius, rear_radius, track, front_y, rear_y, bed_bottom):
    for y, radius in ((front_y, front_radius), (rear_y, rear_radius)):
        for side in (-1, 1):
            wheel((side * track, y, radius), radius, 0.09, 12, clay)
        cylinder((0, y, radius), 0.07, track * 2 + 0.16, clay, rotation=(0, math.radians(90), 0), vertices=24)
        box((0, y, (radius + bed_bottom) / 2), (1.3, 0.16, bed_bottom - radius + 0.08), clay)
    box((0, (front_y + rear_y) / 2, bed_bottom - 0.12), (0.14, rear_y - front_y + 0.4, 0.12), clay)


def convoy():
    reset(1664, 928)
    clay = material("clay", CLAY)
    bed_bottom, length, width, wall = 0.8, 2.7, 1.4, 0.45
    chassis(clay, 0.45, 0.56, 0.8, -0.95, 0.95, bed_bottom)
    box((0, 0, bed_bottom + 0.04), (width, length, 0.08), clay)
    for side in (-1, 1):
        box((side * (width / 2 - 0.03), 0, bed_bottom + wall / 2 + 0.04), (0.06, length, wall), clay)
        for y in (-1.25, -0.6, 0.0, 0.6, 1.25):
            box((side * (width / 2 + 0.02), y, bed_bottom + wall / 2 + 0.04), (0.06, 0.08, wall + 0.06), clay)
    for y in (-length / 2 + 0.03, length / 2 - 0.03):
        box((0, y, bed_bottom + wall / 2 + 0.04), (width, 0.06, wall), clay)
    top = bed_bottom + wall + 0.04
    cover_front, cover_back = -length / 2, 0.35
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=width / 2 + 0.02, depth=cover_back - cover_front,
                                        location=(0, (cover_front + cover_back) / 2, top), rotation=(math.radians(90), 0, 0))
    canopy = bpy.context.object
    add(canopy, clay)
    bisect_below(canopy, top)
    box((0, -length / 2 - 0.2, bed_bottom + 0.55), (1.0, 0.3, 0.06), clay)   # footboard
    box((0, -length / 2 + 0.1, top + 0.05), (1.1, 0.3, 0.07), clay)          # bench
    obj = join_all("convoy", 40)
    facts = frame(obj, (0, 0, 1.0), 20)
    render(OUT / "convoy-blockout-1664x928.png")
    return facts


def bisect_below(obj, z):
    """Delete the part of `obj` below world height z (keeps a half-cylinder canopy)."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bpy.context.view_layer.update()
    matrix = obj.matrix_world
    inverse = matrix.inverted()
    plane_co = inverse @ Vector((0, 0, z))
    plane_no = (inverse.to_3x3().transposed().inverted() @ Vector((0, 0, 1))).normalized()
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=plane_co, plane_no=plane_no, clear_inner=True)
    bm.to_mesh(obj.data)
    bm.free()


def shipment():
    reset(1664, 928)
    clay = material("clay", CLAY)
    dark = material("glass", DARK, 0.35)
    bed_bottom, length, width = 0.8, 2.7, 1.4
    chassis(clay, 0.45, 0.56, 0.8, -0.95, 0.95, bed_bottom)
    box((0, 0.05, bed_bottom + 0.04), (width, length - 0.1, 0.08), clay)
    wall_top, eave = 1.95, 2.02
    box((0, 0.15, (bed_bottom + 0.08 + 1.25) / 2), (width, length - 0.5, 1.25 - bed_bottom - 0.08), clay)
    box((0, 0.15, (1.25 + wall_top) / 2), (width - 0.02, length - 0.52, wall_top - 1.25), clay)
    for side in (-1, 1):
        for y in (-0.55, 0.15, 0.85):
            box((side * (width / 2 + 0.005), y, 1.6), (0.02, 0.56, 0.5), dark)
        for y in (-0.9, -0.2, 0.5, 1.2):
            box((side * (width / 2 + 0.02), y, (1.25 + wall_top) / 2), (0.05, 0.08, wall_top - 1.25 + 0.04), clay)
    for y in (-(length - 0.5) / 2 + 0.15, (length - 0.5) / 2 + 0.15):
        box((0, y + (-0.005 if y < 0 else 0.005), 1.6), (0.9, 0.02, 0.5), dark)
    slope = math.radians(18)
    half = (width + 0.2) / 2
    for side in (-1, 1):
        box((side * half / 2, 0.15, eave + half / 2 * math.tan(slope)), (half / math.cos(slope), length - 0.3, 0.06), clay,
            rotation=(0, side * slope, 0))
    box((0, -length / 2 - 0.05, bed_bottom + 0.55), (1.0, 0.3, 0.06), clay)   # footboard
    box((0, -length / 2 + 0.25, 1.3), (1.2, 0.3, 0.07), clay)                # bench under the eave
    box((0, length / 2 + 0.05, bed_bottom + 0.1), (1.3, 0.35, 0.06), clay)    # rear platform
    obj = join_all("shipment", 40)
    facts = frame(obj, (0, 0, 1.0), 20)
    render(OUT / "shipment-blockout-1664x928.png")
    return facts


def ox_leg(clay, side, front):
    """A tapered bovine leg: forearm or gaskin, knee or hock, a slender cannon, fetlock, pastern and a cloven hoof."""
    x = side * 0.2
    if front:
        joints = [(x, -0.58, 0.8), (x, -0.61, 0.46), (x, -0.62, 0.14), (x, -0.645, 0.06)]
        radii = [0.085, 0.05, 0.036, 0.034]
        ellipsoid((x, -0.57, 0.86), (0.1, 0.14, 0.2), clay)                     # forearm muscle into the chest
    else:
        joints = [(x, 0.66, 0.74), (x, 0.84, 0.47), (x, 0.82, 0.14), (x, 0.8, 0.06)]
        radii = [0.08, 0.045, 0.036, 0.034]
        ellipsoid((x, 0.74, 0.88), (0.12, 0.2, 0.24), clay)                      # thigh and stifle into the rump
    for (a, b), (ra, rb) in zip(zip(joints, joints[1:]), zip(radii, radii[1:])):
        cone(a, b, ra, rb, clay)
    ellipsoid(joints[1], (radii[1] * 1.25, radii[1] * 1.35, radii[1] * 1.3), clay)   # knee or hock
    ellipsoid(joints[2], (0.045, 0.05, 0.045), clay)                              # fetlock
    toe_y = joints[3][1] - 0.035
    for claw in (-1, 1):
        ellipsoid((x + claw * 0.021, toe_y, 0.03), (0.019, 0.05, 0.031), clay)    # the two halves of a cloven hoof


def cone(start, end, r0, r1, mat):
    start, end = Vector(start), Vector(end)
    axis = end - start
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=r0, radius2=r1, depth=axis.length, location=(start + end) / 2)
    body = bpy.context.object
    body.rotation_mode = "QUATERNION"
    body.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(axis.normalized())
    return add(body, mat)


def ox():
    reset(1664, 928)
    clay = material("clay", CLAY)
    ellipsoid((0, 0.1, 1.08), (0.37, 0.98, 0.42), clay)                 # barrel
    ellipsoid((0, -0.5, 1.28), (0.3, 0.36, 0.24), clay)                 # withers
    ellipsoid((0, 0.78, 1.14), (0.34, 0.36, 0.31), clay)                # rump
    capsule((0, -0.7, 1.22), (0, -1.02, 1.06), 0.19, clay)              # neck, carried low
    ellipsoid((0, -0.9, 0.88), (0.1, 0.24, 0.17), clay)                 # dewlap
    ellipsoid((0, -1.22, 0.95), (0.13, 0.3, 0.14), clay, rotation=(math.radians(40), 0, 0))   # head, long and lowered
    ellipsoid((0, -1.4, 0.78), (0.1, 0.09, 0.09), clay)                 # muzzle
    for side in (-1, 1):
        ox_leg(clay, side, True)
        ox_leg(clay, side, False)
    capsule((0, 1.12, 1.3), (0, 1.2, 0.55), 0.035, clay)                # tail
    ellipsoid((0, 1.2, 0.48), (0.05, 0.05, 0.1), clay)
    torus((0, -0.78, 1.16), 0.25, 0.045, clay, rotation=(math.radians(58), 0, 0))   # collar
    obj = join_all("ox", 45)
    facts = frame(obj, (0, 0, 0.9), 14)
    render(OUT / "ox-blockout-v2-1664x928.png")
    return facts


def horn(side, mat):
    """A smooth, tapered, pale lyre horn from the poll: out to the side, then up, the tip turning slightly forward."""
    control = [Vector((side * 0.09, -1.1, 1.18)), Vector((side * 0.3, -1.12, 1.19)), Vector((side * 0.46, -1.14, 1.34)),
               Vector((side * 0.44, -1.21, 1.53))]
    steps = 24

    def at(t):
        a, b, c, d = control
        return a * (1 - t) ** 3 + b * 3 * (1 - t) ** 2 * t + c * 3 * (1 - t) * t ** 2 + d * t ** 3

    curve = bpy.data.curves.new("horn", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.052
    curve.bevel_resolution = 6
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(steps)
    for index, point in enumerate(spline.points):
        t = index / steps
        point.co = (*at(t), 1.0)
        point.radius = 1.0 - 0.8 * t
    obj = bpy.data.objects.new("horn", curve)
    bpy.context.scene.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return add(bpy.context.object, mat)


def ox_v3():
    """v2 with real horns at the poll, ears, and a thick dark collar that cannot be read as a horn (v2's thin pale collar
    ring became a horn growing from the neck in its first output)."""
    reset(1664, 928)
    clay = material("clay", CLAY)
    pale = material("horn", (0.62, 0.6, 0.55, 1.0), 0.45)
    leather = material("collar", (0.075, 0.05, 0.035, 1.0), 0.6)
    ellipsoid((0, 0.1, 1.08), (0.37, 0.98, 0.42), clay)                 # barrel
    ellipsoid((0, -0.5, 1.28), (0.3, 0.36, 0.24), clay)                 # withers
    ellipsoid((0, 0.72, 1.16), (0.34, 0.34, 0.28), clay)                # rump
    capsule((0, -0.7, 1.22), (0, -1.02, 1.06), 0.19, clay)              # neck, carried low
    ellipsoid((0, -0.9, 0.88), (0.1, 0.24, 0.17), clay)                 # dewlap
    ellipsoid((0, -1.22, 0.95), (0.13, 0.3, 0.14), clay, rotation=(math.radians(40), 0, 0))   # head, long and lowered
    ellipsoid((0, -1.4, 0.78), (0.1, 0.09, 0.09), clay)                 # muzzle
    for side in (-1, 1):
        horn(side, pale)
        ellipsoid((side * 0.2, -1.07, 1.08), (0.1, 0.035, 0.05), clay, rotation=(0, side * math.radians(-20), 0))   # ear
        ox_leg(clay, side, True)
        ox_leg(clay, side, False)
    capsule((0, 1.06, 1.36), (0, 1.16, 0.55), 0.035, clay)              # tail
    ellipsoid((0, 1.16, 0.48), (0.05, 0.05, 0.1), clay)
    torus((0, -0.74, 1.17), 0.23, 0.085, leather, rotation=(math.radians(58), 0, 0))   # padded collar
    obj = join_all("ox", 45)
    facts = frame(obj, (0, 0, 0.9), 14)
    render(OUT / "ox-blockout-v3-1664x928.png")
    return facts


def cargo():
    reset(1472, 1136)
    clay = material("clay", CLAY)
    box((-0.3, -0.2, 0.2), (0.55, 0.42, 0.4), clay)
    box((0.3, -0.18, 0.2), (0.55, 0.42, 0.4), clay)
    box((0.0, 0.3, 0.19), (0.6, 0.45, 0.38), clay)
    cylinder((0.62, -0.3, 0.24), 0.2, 0.48, clay)
    for x, y, z, r in ((-0.3, -0.2, 0.52, 12), (0.25, -0.2, 0.52, -8), (0.0, 0.28, 0.5, 30), (-0.5, 0.3, 0.14, 80)):
        ellipsoid((x, y, z), (0.22, 0.33, 0.12), clay, rotation=(0, 0, math.radians(r)))
    obj = join_all("cargo", 30)
    facts = frame(obj, (0, 0, 0.35), 30)
    render(OUT / "cargo-blockout-1472x1136.png")
    return facts


if __name__ == "__main__":
    import json
    builders = {"convoy": convoy, "shipment": shipment, "ox": ox, "ox-v3": ox_v3, "cargo": cargo}
    chosen = sys.argv[sys.argv.index("--") + 2:] or list(builders)
    record = OUT / "wagon-references.json"
    facts = json.loads(record.read_text(encoding="utf-8")) if record.exists() else {}
    for name in chosen:
        facts[name] = builders[name]()
    build = bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else bpy.app.build_hash
    facts["blender"] = {"version": bpy.app.version_string, "build": build}
    record.write_text(json.dumps(facts, indent=2), encoding="utf-8")
    print("REFERENCES-RENDERED", json.dumps({name: facts[name] for name in chosen}))
