"""Korovany II nature kit: scripted Blender 5.2 trees and boulders for version 3 worlds (W0).

    blender -b --factory-startup --python build_nature.py -- --out <dir> [--only tree-spruce ...] [--samples 24]

Writes tree-spruce.glb, tree-birch.glb, tree-deadoak.glb and rock-boulder.glb with nature-report.json and review renders.
Every tree file holds one group per variant (`variant-<n>`), each with named meshes:

- `lod0-wood-<n>`: trunk and limbs on the game's surface arrays (UV0 world-scale bark tiling, UV1.x the
  bark layer + 0.5, UV1.y baked ambient occlusion as glTF reads it; Blender holds 1 - AO because the exporter flips V),
  drawn with the kit material;
- `lod0-leaves-<n>`: alpha-tested foliage cards on the species' card texture, rendered here from procedural needle sprays,
  leaf clusters or bare twigs; canopy-shaped normals and per-vertex shade (COLOR_0);
- `impostor-<n>`: two crossed vertical cards and one horizontal card with albedo renders of the variant from the side and
  from above (one atlas), for trees beyond the near band; the horizontal card keeps them visible from the steep camera.

The boulder file holds `variant-0..3`: displaced, flattened icospheres on the granite layer with baked AO.
Natural sizes (trees are not scaled up for the heroic characters); the game scales each instance to its obstacle height.
"""
import argparse
import json
import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

LAYERS = ["daub", "timber", "thatch", "shingle", "rubble", "planks", "dark",
          "meadow", "forest", "mud", "road", "field", "granite", "bark-spruce", "bark-birch"]
TILE = {"granite": 2.0, "bark-spruce": 1.0, "bark-birch": 1.0}
UP = Vector((0, 0, 1))
HERE = Path(__file__).resolve().parent
SURFACES = HERE.parents[2] / "public" / "world" / "surfaces"


# ----------------------------------------------------------------------------------------------------------------
# Mesh building
# ----------------------------------------------------------------------------------------------------------------
class Wood:
    """Tapered limbs as rings of quads with cylindrical bark UVs; UV1 = (layer + 0.5, AO)."""

    def __init__(self, layer):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.layer_uv = self.bm.loops.layers.uv.new("Layer")
        self.index = LAYERS.index(layer) + 0.5
        self.tile = TILE[layer]

    def limb(self, points, radii, sides, cap=True):
        """A tube through `points` with `radii`; each ring is perpendicular to the local direction."""
        rings = []
        v_along = 0.0
        frame_side = None
        for i, (p, r) in enumerate(zip(points, radii)):
            p = Vector(p)
            if i < len(points) - 1:
                d = (Vector(points[i + 1]) - p).normalized()
            else:
                d = (p - Vector(points[i - 1])).normalized()
            if i > 0:
                v_along += (p - Vector(points[i - 1])).length
            side = d.cross(UP) if frame_side is None else frame_side - d * frame_side.dot(d)
            if side.length < 1e-4:
                side = d.cross(Vector((1, 0, 0)))
            side.normalize()
            frame_side = side
            up = d.cross(side).normalized()
            ring = []
            for s in range(sides):
                a = 2 * math.pi * s / sides
                q = p + (side * math.cos(a) + up * math.sin(a)) * r
                ring.append((self.bm.verts.new(q), s / sides, v_along, r))
            rings.append(ring)
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            for s in range(sides):
                t = (s + 1) % sides
                face = self.bm.faces.new((a[s][0], a[t][0], b[t][0], b[s][0]))
                for loop, (vert, u, v, r) in zip(face.loops, (a[s], a[t] if t else (a[t][0], 1.0, a[t][2], a[t][3]),
                                                              b[t] if t else (b[t][0], 1.0, b[t][2], b[t][3]), b[s])):
                    circumference = 2 * math.pi * max(radii[0], 0.05)
                    loop[self.uv].uv = (u * circumference / self.tile, v / self.tile)
                    loop[self.layer_uv].uv = (self.index, 0.0)
        if cap:
            last = rings[-1]
            centre = self.bm.verts.new(Vector(points[-1]) + (Vector(points[-1]) - Vector(points[-2])).normalized() * radii[-1] * 0.5)
            for s in range(sides):
                t = (s + 1) % sides
                face = self.bm.faces.new((last[s][0], last[t][0], centre))
                for loop in face.loops:
                    loop[self.uv].uv = (loop.vert.co.x / self.tile, loop.vert.co.y / self.tile)
                    loop[self.layer_uv].uv = (self.index, 0.0)

    def finish(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        return mesh


class Cards:
    """Foliage cards: quads (optionally bent) with UVs into one card texture, canopy normals and vertex shade."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.normals, self.shade = [], [], [], [], []

    def card(self, root, along, across, length, width, bend=0.0, segments=1, u0=0.0, u1=1.0, shade=1.0, centre=None, v0=0.0, v1=1.0):
        along, across = Vector(along).normalized(), Vector(across).normalized()
        normal_up = along.cross(across).normalized()
        if normal_up.z < 0:
            normal_up = -normal_up
        base = len(self.verts)
        for k in range(segments + 1):
            t = k / segments
            p = Vector(root) + along * (length * t) - normal_up * (bend * length * t * t)
            for side in (-1, 1):
                q = p + across * (side * width / 2)
                self.verts.append(q)
                self.uvs.append((u0 + (u1 - u0) * (0.5 + side * 0.5), v0 + (v1 - v0) * t))
                c = Vector(centre) if centre is not None else Vector((0, 0, q.z))
                outward = (q - c)
                outward = outward.normalized() if outward.length > 1e-4 else UP.copy()
                self.normals.append((outward * 0.7 + UP * 0.45).normalized())
                self.shade.append(shade)
        for k in range(segments):
            a = base + k * 2
            self.faces.append((a, a + 1, a + 3, a + 2))

    def finish(self, name):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        uv = mesh.uv_layers.new(name="UVMap")
        colour = mesh.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        mesh.color_attributes.active_color = colour
        for polygon in mesh.polygons:
            for loop_index in polygon.loop_indices:
                vi = mesh.loops[loop_index].vertex_index
                uv.data[loop_index].uv = self.uvs[vi]
                s = self.shade[vi]
                colour.data[loop_index].color = (s, s, s, 1.0)
        mesh.normals_split_custom_set_from_vertices([tuple(n) for n in self.normals])
        return mesh


# ----------------------------------------------------------------------------------------------------------------
# Rendering helpers (card textures and impostors): emission-only albedo renders with transparent film
# ----------------------------------------------------------------------------------------------------------------
def emission_material(name, colour=None, image=None, use_alpha=False, vertex_shade=False):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    colour_socket = emit.inputs["Color"]
    source = None
    if image is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Linear"
        source = tex
        base = tex.outputs["Color"]
    else:
        rgb = nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (*colour, 1.0)
        base = rgb.outputs[0]
    if vertex_shade:
        attribute = nodes.new("ShaderNodeVertexColor")
        attribute.layer_name = "Col"
        multiply = nodes.new("ShaderNodeMix")
        multiply.data_type = "RGBA"
        multiply.blend_type = "MULTIPLY"
        multiply.inputs["Factor"].default_value = 1.0
        links.new(base, multiply.inputs["A"])
        links.new(attribute.outputs["Color"], multiply.inputs["B"])
        base = multiply.outputs["Result"]
    links.new(base, colour_socket)
    if use_alpha and source is not None:
        mix = nodes.new("ShaderNodeMixShader")
        transparent = nodes.new("ShaderNodeBsdfTransparent")
        links.new(source.outputs["Alpha"], mix.inputs["Fac"])
        links.new(transparent.outputs[0], mix.inputs[1])
        links.new(emit.outputs[0], mix.inputs[2])
        links.new(mix.outputs[0], out.inputs["Surface"])
    else:
        links.new(emit.outputs[0], out.inputs["Surface"])
    return material


def render_setup(width, height, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.film_transparent = True
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.cycles.max_bounces = 0
    # Overlapping leaf cards need many transparent bounces; a path that runs out renders opaque black.
    scene.cycles.transparent_max_bounces = 128
    scene.cycles.filter_width = 1.0
    return scene


def ortho_camera(location, rotation, scale):
    data = bpy.data.cameras.new("render-camera")
    data.type = "ORTHO"
    data.ortho_scale = scale
    camera = bpy.data.objects.new("render-camera", data)
    camera.location = location
    camera.rotation_euler = rotation
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    return camera


def render_to(path, objects, camera, width, height, samples):
    scene = render_setup(width, height, samples)
    for obj in scene.objects:
        obj.hide_render = obj not in objects and obj is not camera
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "sRGB"
    image.alpha_mode = "STRAIGHT"
    return image


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def mesh_object(name, mesh, material):
    obj = bpy.data.objects.new(name, mesh)
    mesh.materials.append(material)
    return link(obj)


# ----------------------------------------------------------------------------------------------------------------
# Card textures
# ----------------------------------------------------------------------------------------------------------------
def needle_spray(rng):
    """A spruce spray in a unit card (x across -0.5..0.5, y along 0..1): a twig with side twigs bristling with needles."""
    bm = bmesh.new()
    colours = []

    def needle(p, d, length, width, colour):
        side = Vector((-d.y, d.x, 0)).normalized() * width / 2
        a, b = bm.verts.new(p - side), bm.verts.new(p + side)
        c = bm.verts.new(p + d * length)
        bm.faces.new((a, b, c))
        colours.append(colour)

    def twig(start, direction, length, width, colour):
        d = direction.normalized()
        side = Vector((-d.y, d.x, 0)).normalized() * width / 2
        e = start + d * length
        bm.faces.new((bm.verts.new(start - side), bm.verts.new(start + side), bm.verts.new(e + side), bm.verts.new(e - side)))
        colours.append(colour)

    bark = (0.05, 0.036, 0.026)
    greens = [(0.045, 0.08, 0.05), (0.06, 0.095, 0.058), (0.036, 0.066, 0.044), (0.07, 0.105, 0.064)]
    stem = Vector((0, 0.02, 0))
    twig(stem, Vector((0, 1, 0)), 0.94, 0.018, bark)
    for k in range(34):
        t = 0.04 + k / 34 * 0.9
        for side in (-1, 1):
            spread = 0.42 * (1 - t) ** 0.55 + 0.07
            angle = math.radians(rng.uniform(38, 62))
            d = Vector((side * math.sin(angle), math.cos(angle), 0))
            start = Vector((0, t, 0))
            length = spread * rng.uniform(0.8, 1.1)
            twig(start, d, length, 0.008, bark)
            # A dense dark needle mass along each side twig keeps the spray solid at a distance.
            twig(start + d * 0.02, d, length * 0.92, 0.05 * (1.1 - 0.5 * t), greens[2])
            for n in range(int(length * 260)):
                s = rng.uniform(0.02, 1.0)
                p = start + d * (length * s)
                for needle_side in (-1, 1):
                    nd = (d + Vector((-d.y, d.x, 0)) * needle_side * rng.uniform(0.6, 1.4)).normalized()
                    needle(p, nd, rng.uniform(0.032, 0.05) * (1.1 - 0.4 * s), 0.007, rng.choice(greens))
    return bm, colours


def leaf_cluster(rng, palette, leaves, bare=False):
    """Twigs fanning up a unit card with ovate leaves (birch) or a few dead leaves (oak)."""
    bm = bmesh.new()
    colours = []

    def quad(a, b, c, d, colour):
        bm.faces.new([bm.verts.new(p) for p in (a, b, c, d)])
        colours.append(colour)

    def leaf(p, d, size, colour):
        side = Vector((-d.y, d.x, 0))
        tip = p + d * size
        mid = p + d * size * 0.45
        bm.faces.new([bm.verts.new(q) for q in (p, mid + side * size * 0.32, tip, mid - side * size * 0.32)])
        colours.append(colour)

    twig_colour = (0.12, 0.1, 0.09) if not bare else (0.07, 0.06, 0.055)

    def branch(start, direction, length, width, depth):
        d = direction.normalized()
        side = Vector((-d.y, d.x, 0)).normalized() * width / 2
        end = start + d * length
        quad(start - side, start + side, end + side * 0.6, end - side * 0.6, twig_colour)
        if depth == 0:
            for _ in range(leaves):
                s = rng.uniform(0.3, 1.0)
                p = start + d * (length * s)
                ld = (d.copy() + Vector((rng.uniform(-1.2, 1.2), rng.uniform(-0.3, 0.6), 0))).normalized()
                leaf(p, ld, rng.uniform(0.045, 0.075), rng.choice(palette))
            return
        for _ in range(3 if bare else 2):
            s = rng.uniform(0.35, 0.95)
            turn = rng.uniform(25, 55) * rng.choice((-1, 1))
            nd = Matrix.Rotation(math.radians(turn), 3, "Z") @ d
            branch(start + d * (length * s), nd, length * rng.uniform(0.45, 0.65), width * 0.62, depth - 1)

    branch(Vector((0, 0.02, 0)), Vector((0, 1, 0)), 0.62, 0.03 if not bare else 0.04, 3 if bare else 2)
    return bm, colours


def finish_card(image, thicken=1.0):
    """Prepare an alpha-tested card for mipmapping: thicken thin coverage (needles, twigs) so it survives the smaller mip
    levels, and bleed colour into transparent texels so filtering never pulls in black."""
    import numpy as np
    w, h = image.size
    px = np.array(image.pixels[:], dtype=np.float32).reshape(h, w, 4)
    alpha = px[..., 3]

    def blur(a):
        out = a.copy()
        for axis in (0, 1):
            out = (np.roll(out, 1, axis) + out * 2 + np.roll(out, -1, axis)) / 4
        return out

    soft = blur(blur(alpha))
    coverage = np.clip((np.maximum(alpha, soft * 1.6) - 0.12) * (1.6 * thicken), 0, 1)
    rgb = px[..., :3] * (alpha[..., None] > 0.02)
    weight = (alpha > 0.02).astype(np.float32)
    for _ in range(24):
        grown_rgb = sum(np.roll(rgb * weight[..., None], s, axis) for axis in (0, 1) for s in (-1, 1))
        grown_w = sum(np.roll(weight, s, axis) for axis in (0, 1) for s in (-1, 1))
        fill = (weight == 0) & (grown_w > 0)
        rgb[fill] = grown_rgb[fill] / grown_w[fill][..., None]
        weight[fill] = 1.0
    px[..., :3] = rgb
    px[..., 3] = coverage
    image.pixels = px.ravel()
    return image


def card_texture(out, name, builder, samples, size=512, thicken=1.0):
    """Render a procedural card (unit square, x -0.5..0.5, y 0..1) top-down to an RGBA albedo image."""
    bm, colours = builder
    mesh = bpy.data.meshes.new(f"{name}-card-source")
    bm.to_mesh(mesh)
    bm.free()
    attribute = mesh.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    for polygon, colour in zip(mesh.polygons, colours):
        for loop_index in polygon.loop_indices:
            attribute.data[loop_index].color = (*colour, 1.0)
    material = bpy.data.materials.new(f"{name}-card-source")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    out_node = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    vc = nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    links.new(vc.outputs["Color"], emit.inputs["Color"])
    links.new(emit.outputs[0], out_node.inputs["Surface"])
    obj = mesh_object(f"{name}-card-source", mesh, material)
    camera = ortho_camera((0, 0.5, 5), (0, 0, 0), 1.0)
    image = render_to(out / f"card-{name}.png", [obj], camera, size, size, samples)
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.objects.remove(camera, do_unlink=True)
    image.name = f"card-{name}"
    finish_card(image, thicken)
    image.filepath_raw = str(out / f"card-{name}-finished.png")
    image.file_format = "PNG"
    image.save()
    return image


# ----------------------------------------------------------------------------------------------------------------
# Species
# ----------------------------------------------------------------------------------------------------------------
def spruce(rng, variant, lod):
    height = [20.0, 22.5, 18.0][variant]
    crown_base = [2.6, 3.4, 2.2][variant]
    crown = [3.1, 3.5, 2.7][variant]
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * 0.012
    wood = Wood("bark-spruce")
    steps = 12 if lod == 0 else 6
    points, radii = [], []
    for i in range(steps + 1):
        t = i / steps
        z = height * t
        points.append(Vector((0, 0, z)) + lean * z * z / height)
        radii.append(0.42 * (1 - t) ** 0.85 + 0.025 + (0.12 * (1 - t / 0.06) if t < 0.06 else 0))
    wood.limb(points, radii, 8 if lod == 0 else 5)
    axis = lambda z: Vector((0, 0, z)) + lean * z * z / height  # noqa: E731
    cards = Cards()
    spacing = 0.5 if lod == 0 else 1.0
    z = crown_base
    whorl = 0
    while z < height - 0.7:
        frac = (z - crown_base) / (height - crown_base)
        reach = crown * (1 - frac) ** 0.95 * rng.uniform(0.85, 1.08) + 0.35
        count = rng.randint(5, 7) if lod == 0 else 4
        offset = rng.uniform(0, math.tau)
        for b in range(count):
            a = offset + b * math.tau / count + rng.uniform(-0.25, 0.25)
            droop = -0.32 + 0.45 * frac + rng.uniform(-0.06, 0.06)
            d = Vector((math.cos(a), math.sin(a), droop)).normalized()
            across = Vector((-math.sin(a), math.cos(a), 0))
            root = axis(z) + d * 0.08
            shade = 0.55 + 0.45 * min(1.0, 0.35 + frac * 0.8)
            if lod == 0:
                # Sprays overlap along the branch like real spruce foliage: a long main spray and a shorter one.
                cards.card(root, d, across, reach, reach * 0.62 + 0.25, bend=0.12, segments=3, shade=shade * rng.uniform(0.85, 1.0), centre=axis(z))
                tilt = (across * 0.3 + Vector((0, 0, 1))).normalized()
                cards.card(root + d * reach * 0.15, d, tilt, reach * 0.75, reach * 0.4 + 0.15, bend=0.06, segments=2,
                           shade=shade * 0.85, centre=axis(z))
            else:
                cards.card(root, d, across, reach * 1.05, reach * 0.95 + 0.3, bend=0.1, segments=1, shade=shade, centre=axis(z))
            if lod == 0 and reach > 1.4 and whorl % 2 == 0:
                limb_end = root + d * reach * 0.7
                wood.limb([root, limb_end], [0.05 + reach * 0.012, 0.015], 4, cap=False)
        z += spacing * rng.uniform(0.9, 1.1)
        whorl += 1
    for k in range(3 if lod == 0 else 2):
        a = k * math.pi / (3 if lod == 0 else 2)
        across = Vector((math.cos(a), math.sin(a), 0))
        cards.card(axis(height - 1.6), Vector((0, 0, 1)), across, 1.9, 0.9, segments=1, shade=1.0, centre=axis(height - 1.6))
    return wood, cards, height


def birch(rng, variant, lod):
    height = [15.5, 13.5][variant]
    wood = Wood("bark-birch")
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized() * rng.uniform(0.01, 0.03)
    steps = 10 if lod == 0 else 5
    points = [Vector((0, 0, height * i / steps)) + lean * (height * i / steps) ** 1.5 for i in range(steps + 1)]
    radii = [0.2 * (1 - i / steps) ** 0.9 + 0.02 + (0.06 if i == 0 else 0) for i in range(steps + 1)]
    wood.limb(points, radii, 7 if lod == 0 else 5)
    cards = Cards()
    limbs = 9 if lod == 0 else 6
    for k in range(limbs):
        t = 0.38 + 0.55 * k / limbs + rng.uniform(-0.03, 0.03)
        base = points[0].lerp(points[-1], t) + lean * 0
        a = rng.uniform(0, math.tau)
        rise = rng.uniform(0.7, 1.4)
        d = Vector((math.cos(a), math.sin(a), rise)).normalized()
        length = (height * 0.32) * (1.15 - t) * rng.uniform(0.8, 1.15)
        mid = base + d * length * 0.55 + Vector((0, 0, -0.25))
        end = base + d * length
        if lod == 0:
            wood.limb([base, mid, end], [0.075 * (1.1 - t), 0.045 * (1.1 - t), 0.012], 5, cap=False)
        clusters = 5 if lod == 0 else 2
        for c in range(clusters):
            s = 0.45 + 0.55 * (c + 1) / clusters
            p = base.lerp(end, s) + Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), rng.uniform(-0.3, 0.3)))
            size = rng.uniform(1.6, 2.3) * (1.4 if lod else 1.0)
            for r in range(2):
                ang = a + r * math.pi / 2 + rng.uniform(-0.4, 0.4)
                along = Vector((math.cos(ang) * 0.5, math.sin(ang) * 0.5, 0.85)).normalized()
                across = Vector((-math.sin(ang), math.cos(ang), 0))
                cards.card(p - along * size * 0.4, along, across, size, size * 0.85, segments=1,
                           shade=rng.uniform(0.75, 1.0), centre=Vector((0, 0, height * 0.7)))
    return wood, cards, height


def deadoak(rng, variant, lod):
    height = [11.0, 9.5][variant]
    wood = Wood("bark-spruce")
    cards = Cards()
    sides = 7 if lod == 0 else 5

    def grow(start, direction, length, radius, depth):
        points, radii = [start], [radius]
        d = direction.normalized()
        segments = 4 if lod == 0 else 2
        p = start.copy()
        for s in range(1, segments + 1):
            twist = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 0.5))) * 0.35
            d = (d + twist).normalized()
            p = p + d * (length / segments)
            points.append(p.copy())
            radii.append(radius * (1 - 0.55 * s / segments))
        wood.limb(points, radii, sides if depth > 1 else max(4, sides - 2), cap=depth == 0)
        if depth == 0 or radii[-1] < 0.03:
            for _ in range(2 if lod == 0 else 1):
                a = rng.uniform(0, math.tau)
                across = Vector((math.cos(a), math.sin(a), 0))
                size = rng.uniform(1.4, 2.2) * (1.5 if lod else 1.0)
                cards.card(points[-1] - d * size * 0.3, d, across, size, size * 0.8, segments=1, shade=rng.uniform(0.7, 1.0),
                           centre=Vector((0, 0, height * 0.6)))
            return
        for _ in range(rng.randint(2, 3) if lod == 0 else 2):
            s = rng.uniform(0.55, 1.0)
            k = min(len(points) - 1, max(1, round(s * (len(points) - 1))))
            branch_dir = (d + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.2, 0.6)))).normalized()
            grow(points[k], branch_dir, length * rng.uniform(0.5, 0.72), radii[k] * 0.62, depth - 1)

    trunk_top = Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), height * 0.42))
    wood.limb([Vector((0, 0, -0.3)), Vector((0, 0, 0.6)), trunk_top * 0.55 + Vector((0, 0, 0.6)), trunk_top],
              [0.85, 0.62, 0.5, 0.42], sides + 2)
    for k in range(4 if lod == 0 else 3):
        a = k * math.tau / (4 if lod == 0 else 3) + rng.uniform(-0.4, 0.4)
        d = Vector((math.cos(a), math.sin(a), rng.uniform(0.5, 1.1)))
        grow(trunk_top, d, height * rng.uniform(0.38, 0.5), 0.3, 3 if lod == 0 else 2)
    return wood, cards, height


SPECIES = {
    "tree-spruce": {"variants": 3, "build": spruce, "card": lambda rng: needle_spray(rng)},
    "tree-birch": {"variants": 2, "build": birch,
                   "card": lambda rng: leaf_cluster(rng, [(0.62, 0.45, 0.12), (0.55, 0.34, 0.1), (0.42, 0.3, 0.12), (0.5, 0.42, 0.16)], 7)},
    "tree-deadoak": {"variants": 2, "build": deadoak,
                     "card": lambda rng: leaf_cluster(rng, [(0.22, 0.13, 0.07), (0.28, 0.17, 0.08)], 2, bare=True)},
}


# ----------------------------------------------------------------------------------------------------------------
# AO, materials, export
# ----------------------------------------------------------------------------------------------------------------
def bake_ao(objects, target, samples):
    """Cycles AO of `target` (with `objects` and a ground plane occluding) into UV 'Layer'.y."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, -0.01))
    ground = bpy.context.active_object
    material = bpy.data.materials.new("bake")
    material.use_nodes = True
    target.data.materials.clear()
    target.data.materials.append(material)
    ground.data.materials.append(material)
    target.data.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
    target.data.color_attributes.active_color = target.data.color_attributes["AO"]
    for obj in scene.objects:
        obj.hide_render = obj not in objects and obj is not target and obj is not ground
    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    ao = target.data.color_attributes["AO"].data
    layer = target.data.uv_layers["Layer"].data
    for index, item in enumerate(ao):
        value = max(0.0, min(1.0, sum(item.color[:3]) / 3))
        # glTF stores V flipped (1 - v): Blender keeps 1 - AO so the game reads UV1.y = AO.
        layer[index].uv = (layer[index].uv[0], 1.0 - (0.3 + 0.7 * value))
    target.data.color_attributes.remove(target.data.color_attributes["AO"])
    bpy.data.objects.remove(ground, do_unlink=True)
    target.data.materials.clear()


def kit_placeholder():
    material = bpy.data.materials.get("kit") or bpy.data.materials.new("kit")
    material.use_nodes = True
    return material


def card_material(name, image):
    """Principled material on the card texture with alpha clip, exported as glTF alphaMode MASK (cutoff 0.5)."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    principled = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    attribute = nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "Col"
    multiply = nodes.new("ShaderNodeMix")
    multiply.data_type = "RGBA"
    multiply.blend_type = "MULTIPLY"
    multiply.inputs["Factor"].default_value = 1.0
    links.new(tex.outputs["Color"], multiply.inputs["A"])
    links.new(attribute.outputs["Color"], multiply.inputs["B"])
    links.new(multiply.outputs["Result"], principled.inputs["Base Color"])
    # Alpha clip for the glTF exporter: alpha >= 0.5 through a Math Round node.
    clip = nodes.new("ShaderNodeMath")
    clip.operation = "ROUND"
    links.new(tex.outputs["Alpha"], clip.inputs[0])
    links.new(clip.outputs[0], principled.inputs["Alpha"])
    principled.inputs["Roughness"].default_value = 0.9
    principled.inputs["Metallic"].default_value = 0.0
    material.use_backface_culling = False
    return material


def impostor(out, name, objects, height, samples):
    """Two crossed vertical cards (side render) and a horizontal card (top render), sharing one 512 px atlas: the side
    view fills u 0..0.5, the top view u 0.5..1, v 0.5..1 (Blender UV space)."""
    import numpy as np
    span = max(max(abs(v.co.x), abs(v.co.y)) for obj in objects for v in obj.data.vertices) * 2 + 0.5
    scale = max(height + 0.6, span * 2)
    camera = ortho_camera((0, -60, scale / 2 - 0.3), (math.radians(90), 0, 0), scale)
    side = render_to(out / f"impostor-{name}-side.png", objects, camera, 256, 512, samples)
    bpy.data.objects.remove(camera, do_unlink=True)
    camera = ortho_camera((0, 0, height + 40), (0, 0, 0), span)
    top = render_to(out / f"impostor-{name}-top.png", objects, camera, 256, 256, samples)
    bpy.data.objects.remove(camera, do_unlink=True)
    atlas = np.zeros((512, 512, 4), dtype=np.float32)
    atlas[:, :256] = np.array(side.pixels[:], dtype=np.float32).reshape(512, 256, 4)
    atlas[256:, 256:] = np.array(top.pixels[:], dtype=np.float32).reshape(256, 256, 4)
    image = bpy.data.images.new(f"impostor-{name}", 512, 512, alpha=True)
    image.colorspace_settings.name = "sRGB"
    image.pixels = atlas.ravel()
    finish_card(image, 0.8)
    image.filepath_raw = str(out / f"impostor-{name}.png")
    image.file_format = "PNG"
    image.save()
    cards = Cards()
    w = scale / 2
    for a in (0.0, math.pi / 2):
        across = Vector((math.cos(a), math.sin(a), 0))
        cards.card(Vector((0, 0, -0.3)), Vector((0, 0, 1)), across, scale, w, segments=1, shade=1.0,
                   centre=Vector((0, 0, height * 0.6)), u0=0.0, u1=0.5)
    cards.card(Vector((0, -span / 2, height * 0.55)), Vector((0, 1, 0)), Vector((1, 0, 0)), span, span, segments=1, shade=1.0,
               centre=Vector((0, 0, height * 0.3)), u0=0.5, u1=1.0, v0=0.5, v1=1.0)
    mesh = cards.finish(f"impostor-{name}")
    return mesh, image


def export(objects, path):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_texcoords=True, export_normals=True, export_tangents=False,
                              export_materials="EXPORT", export_cameras=False, export_lights=False, export_animations=False,
                              export_skins=False, export_morph=False, export_image_format="WEBP",
                              export_vertex_color="ACTIVE", export_all_vertex_colors=False)


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def build_species(name, spec, out, samples):
    rng = random.Random(f"korovany2:{name}")
    card = card_texture(out, name, spec["card"](rng), samples)
    leaf_material = card_material(f"{name}-leaves", card)
    exported, report = [], {"variants": []}
    for variant in range(spec["variants"]):
        group = bpy.data.objects.new(f"variant-{variant}", None)
        link(group)
        parts = {}
        vrng = random.Random(f"korovany2:{name}:{variant}")
        wood, cards, height = spec["build"](vrng, variant, 0)
        parts["lod0-wood"] = mesh_object(f"lod0-wood-{variant}", wood.finish(f"lod0-wood-{variant}"), kit_placeholder())
        parts["lod0-leaves"] = mesh_object(f"lod0-leaves-{variant}", cards.finish(f"lod0-leaves-{variant}"), leaf_material)
        bake_ao([parts["lod0-wood"], parts["lod0-leaves"]], parts["lod0-wood"], samples)
        parts["lod0-wood"].data.materials.append(kit_placeholder())
        # Impostor render with albedo materials: bark from the shipped surface layer, leaves from the card.
        bark_name = "bark-birch" if name == "tree-birch" else "bark-spruce"
        bark_image = bpy.data.images.load(str(SURFACES / f"{bark_name}-albedo.webp"), check_existing=True)
        render_wood = parts["lod0-wood"].copy()
        render_wood.data = parts["lod0-wood"].data.copy()
        render_wood.data.materials.clear()
        render_wood.data.materials.append(emission_material(f"{name}-bark-albedo", image=bark_image))
        link(render_wood)
        render_leaves = parts["lod0-leaves"].copy()
        render_leaves.data = parts["lod0-leaves"].data.copy()
        render_leaves.data.materials.clear()
        render_leaves.data.materials.append(emission_material(f"{name}-leaf-albedo", image=card, use_alpha=True, vertex_shade=True))
        link(render_leaves)
        imp_mesh, imp_image = impostor(out, f"{name}-{variant}", [render_wood, render_leaves], height, samples)
        bpy.data.objects.remove(render_wood, do_unlink=True)
        bpy.data.objects.remove(render_leaves, do_unlink=True)
        parts["impostor"] = mesh_object(f"impostor-{variant}", imp_mesh, card_material(f"{name}-impostor-{variant}", imp_image))
        for obj in parts.values():
            obj.parent = group
        exported.extend([group, *parts.values()])
        report["variants"].append({"variant": variant, "height": height,
                                   "triangles": {key: triangles(obj) for key, obj in parts.items()}})
    path = out / f"{name}.glb"
    export(exported, path)
    report["bytes"] = path.stat().st_size
    for obj in exported:
        bpy.data.objects.remove(obj, do_unlink=True)
    return report


def boulders(out, samples):
    exported, report = [], {"variants": []}
    for variant in range(4):
        rng = random.Random(f"korovany2:rock-boulder:{variant}")
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
        seed = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
        squash = Vector((rng.uniform(0.85, 1.15), rng.uniform(0.75, 1.1), rng.uniform(0.55, 0.85)))
        for v in bm.verts:
            p = v.co.copy()
            n = noise.fractal(p * 0.9 + seed, 0.6, 2.0, 4) * 0.28 + noise.noise(p * 2.6 + seed) * 0.07
            facet = math.floor((noise.noise(p * 1.4 + seed * 2) + 1) * 2.5) / 5 * 0.12
            v.co = Vector((p.x * squash.x, p.y * squash.y, p.z * squash.z)) * (1 + n + facet)
        lowest = min(v.co.z for v in bm.verts)
        for v in bm.verts:
            v.co.z -= lowest
            if v.co.z < 0.18:
                v.co.z *= 0.35
        uv = bm.loops.layers.uv.new("UVMap")
        layer_uv = bm.loops.layers.uv.new("Layer")
        bm.normal_update()
        index = LAYERS.index("granite") + 0.5
        for face in bm.faces:
            n = face.normal
            axis = max(range(3), key=lambda i: abs(n[i]))
            for loop in face.loops:
                c = loop.vert.co
                u, w = [(c.y, c.z), (c.x, c.z), (c.x, c.y)][axis]
                loop[uv].uv = (u / TILE["granite"], w / TILE["granite"])
                loop[layer_uv].uv = (index, 0.0)
        mesh = bpy.data.meshes.new(f"variant-{variant}")
        bm.to_mesh(mesh)
        bm.free()
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        obj = mesh_object(f"variant-{variant}", mesh, kit_placeholder())
        bake_ao([obj], obj, samples)
        obj.data.materials.append(kit_placeholder())
        obj.location.x = variant * 3.5
        exported.append(obj)
        dims = obj.dimensions
        report["variants"].append({"variant": variant, "triangles": triangles(obj), "size": [round(d, 3) for d in dims]})
    for obj in exported:
        obj.location.x = 0
    path = out / "rock-boulder.glb"
    export(exported, path)
    report["bytes"] = path.stat().st_size
    for obj in exported:
        bpy.data.objects.remove(obj, do_unlink=True)
    return report


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--samples", type=int, default=24)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    report = {"blender": bpy.app.version_string, "layers": LAYERS, "assets": {}}
    for name, spec in SPECIES.items():
        if args.only and name not in args.only:
            continue
        report["assets"][name] = build_species(name, spec, args.out, args.samples)
    if not args.only or "rock-boulder" in args.only:
        report["assets"]["rock-boulder"] = boulders(args.out, args.samples)
    (args.out / "nature-report.json").write_bytes((json.dumps(report, indent=1) + "\n").encode())
    print(json.dumps({k: {"bytes": v["bytes"], "variants": v["variants"]} for k, v in report["assets"].items()}))


if __name__ == "__main__":
    main()
