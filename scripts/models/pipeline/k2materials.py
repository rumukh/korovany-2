"""Material helpers for korovany-2 cooking: bakes, dye masks and glTF-ready PBR materials (Blender 5.2)."""
import math

import bpy
import numpy as np

import k2cook as k


def cycles_cpu(samples=1):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    return scene


def image(name, size, colour_space, alpha=False):
    result = bpy.data.images.new(name, size, size, alpha=alpha, float_buffer=False)
    result.colorspace_settings.name = colour_space
    return result


def pixels(img):
    width, height = img.size
    data = np.empty(width * height * 4, dtype=np.float32)
    img.pixels.foreach_get(data)
    return data.reshape(height, width, 4)


def set_pixels(img, array):
    img.pixels.foreach_set(np.ascontiguousarray(array, dtype=np.float32).ravel())
    img.update()


def bake_emission(obj, material, socket_source, target, colour=True):
    """Bake whatever feeds `socket_source` (a node output) as emission into `target`."""
    nodes, links = material.node_tree.nodes, material.node_tree.links
    output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
    previous = output.inputs["Surface"].links[0].from_socket if output.inputs["Surface"].is_linked else None
    emission = nodes.new("ShaderNodeEmission")
    links.new(socket_source, emission.inputs["Color"])
    links.new(emission.outputs[0], output.inputs["Surface"])
    holder = nodes.new("ShaderNodeTexImage")
    holder.image = target
    nodes.active = holder
    k.select_only(obj)
    result = bpy.ops.object.bake(type="EMIT")
    k.require("FINISHED" in result, f"Emission bake failed for {target.name}")
    nodes.remove(emission)
    nodes.remove(holder)
    if previous is not None:
        links.new(previous, output.inputs["Surface"])


def bake_type(obj, material, kind, target, **settings):
    nodes = material.node_tree.nodes
    holder = nodes.new("ShaderNodeTexImage")
    holder.image = target
    nodes.active = holder
    k.select_only(obj)
    result = bpy.ops.object.bake(type=kind, **settings)
    k.require("FINISHED" in result, f"{kind} bake failed for {target.name}")
    nodes.remove(holder)


def luminance(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def encode_webp(array_rgba, path, quality, colour_space="sRGB"):
    """Lossy WebP of an sRGB-encoded (or data) array. save_render applies the scene view transform to colour
    images, so Standard/None is forced for the write: the stored bytes must equal the array."""
    height, width = array_rgba.shape[:2]
    img = bpy.data.images.new(path.stem, width, height, alpha=True)
    img.colorspace_settings.name = colour_space
    set_pixels(img, array_rgba)
    scene = bpy.context.scene
    view = scene.view_settings
    saved = (view.view_transform, view.look, view.exposure, view.gamma)
    view.view_transform, view.look, view.exposure, view.gamma = "Standard", "None", 0.0, 1.0
    settings = scene.render.image_settings
    settings.file_format = "WEBP"
    settings.color_mode = "RGBA" if array_rgba.shape[2] == 4 else "RGB"
    settings.quality = quality
    try:
        img.save_render(str(path), scene=scene)
    finally:
        view.view_transform, view.look, view.exposure, view.gamma = saved
    bpy.data.images.remove(img)
    return path.read_bytes()


def gltf_material(name, base, normal=None, orm=None, normal_strength=1.0, occlusion=True, cull_backfaces=True):
    """Principled material wired the way Blender's glTF exporter maps base/normal/metal-roughness/occlusion."""
    material = bpy.data.materials.new(name)
    material.use_backface_culling = cull_backfaces
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf = nodes["Principled BSDF"]
    base_node = nodes.new("ShaderNodeTexImage")
    base_node.image = base
    links.new(base_node.outputs["Color"], bsdf.inputs["Base Color"])
    if normal is not None:
        normal_node = nodes.new("ShaderNodeTexImage")
        normal_node.image = normal
        map_node = nodes.new("ShaderNodeNormalMap")
        map_node.inputs["Strength"].default_value = normal_strength
        links.new(normal_node.outputs["Color"], map_node.inputs["Color"])
        links.new(map_node.outputs["Normal"], bsdf.inputs["Normal"])
    if orm is not None:
        orm_node = nodes.new("ShaderNodeTexImage")
        orm_node.image = orm
        split = nodes.new("ShaderNodeSeparateColor")
        links.new(orm_node.outputs["Color"], split.inputs["Color"])
        links.new(split.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(split.outputs["Blue"], bsdf.inputs["Metallic"])
        if occlusion:
            group = bpy.data.node_groups.get("glTF Material Output")
            if group is None:
                group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
                group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
            settings = nodes.new("ShaderNodeGroup")
            settings.node_tree = group
            links.new(split.outputs["Red"], settings.inputs["Occlusion"])
    return material


def region_masks(obj, size, regions):
    """Rasterize per-face region labels (declared as 3D predicates) into a UV-space label image."""
    labels = np.zeros((size, size), dtype=np.int16)
    uv = obj.data.uv_layers.active.data
    obj.data.calc_loop_triangles()
    for tri in obj.data.loop_triangles:
        centre = tri.center
        label = 0
        for index, predicate in enumerate(regions, start=1):
            if predicate(centre):
                label = index
                break
        if not label:
            continue
        corners = np.array([uv[loop].uv[:] for loop in tri.loops]) * (size - 1)
        low = np.floor(corners.min(axis=0)).astype(int)
        high = np.ceil(corners.max(axis=0)).astype(int)
        xs, ys = np.meshgrid(np.arange(max(0, low[0]), min(size, high[0] + 1)), np.arange(max(0, low[1]), min(size, high[1] + 1)))
        if xs.size == 0:
            continue
        a, b, c = corners
        denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(denominator) < 1e-12:
            continue
        w1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / denominator
        w2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / denominator
        w3 = 1 - w1 - w2
        pad = 1.5 / size
        inside = (w1 >= -pad) & (w2 >= -pad) & (w3 >= -pad)
        labels[ys[inside], xs[inside]] = label
    return labels


def dilate(array, iterations=4):
    out = array.copy()
    for _ in range(iterations):
        grown = out.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(np.roll(out, dy, axis=0), dx, axis=1)
            grown = np.where(grown == 0, shifted, grown)
        out = grown
    return out


def blur(array, radius=1):
    out = array.astype(np.float32)
    for _ in range(radius):
        out = (out + np.roll(out, 1, 0) + np.roll(out, -1, 0) + np.roll(out, 1, 1) + np.roll(out, -1, 1)) / 5
    return out


def height_normal(height_map, strength):
    """Tangent-space normal map from a height field (artistic relief, not a measured scan)."""
    gy, gx = np.gradient(height_map)
    nx, ny = -gx * strength, -gy * strength
    nz = np.ones_like(nx)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / length * 0.5 + 0.5, ny / length * 0.5 + 0.5, nz / length * 0.5 + 0.5], axis=-1)


def srgb_to_linear(value):
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def bake_selected_to_active(high, low, kind, target, extrusion, max_distance, emission_from=None):
    """Cycles CPU bake from `high` onto `low`'s active image node. `emission_from(material)` returns the
    high material's socket to bake as emission (for colour); None bakes `kind` directly (NORMAL, AO...)."""
    scene = bpy.context.scene
    low_material = low.data.materials[0]
    rewired = []
    if emission_from is not None:
        for material in {slot.material for slot in high.material_slots if slot.material}:
            nodes, links = material.node_tree.nodes, material.node_tree.links
            output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
            previous = output.inputs["Surface"].links[0].from_socket if output.inputs["Surface"].is_linked else None
            emission = nodes.new("ShaderNodeEmission")
            links.new(emission_from(material), emission.inputs["Color"])
            links.new(emission.outputs[0], output.inputs["Surface"])
            rewired.append((material, emission, previous, output))
    holder = low_material.node_tree.nodes.new("ShaderNodeTexImage")
    holder.image = target
    low_material.node_tree.nodes.active = holder
    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bake = scene.render.bake
    bake.use_selected_to_active = True
    bake.cage_extrusion = extrusion
    bake.max_ray_distance = max_distance
    settings = {"type": "EMIT" if emission_from is not None else kind, "use_selected_to_active": True,
                "cage_extrusion": extrusion, "max_ray_distance": max_distance}
    if kind == "NORMAL":
        settings["normal_space"] = "TANGENT"
    result = bpy.ops.object.bake(**settings)
    k.require("FINISHED" in result, f"{kind} selected-to-active bake failed for {target.name}")
    bake.use_selected_to_active = False
    low_material.node_tree.nodes.remove(holder)
    for material, emission, previous, output in rewired:
        material.node_tree.nodes.remove(emission)
        if previous is not None:
            material.node_tree.links.new(previous, output.inputs["Surface"])


def blend_normals(base, detail):
    """Whiteout blend of two tangent-space normal maps stored as 0..1 colours."""
    a = base * 2 - 1
    b = detail * 2 - 1
    n = np.stack([a[..., 0] + b[..., 0], a[..., 1] + b[..., 1], a[..., 2] * b[..., 2]], axis=-1)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
    return n * 0.5 + 0.5


def downsample(array, factor):
    """Box-filter downsample by an integer factor (linear data; apply to colour in linear space)."""
    if factor == 1:
        return array
    height, width = array.shape[:2]
    return array.reshape(height // factor, factor, width // factor, factor, *array.shape[2:]).mean(axis=(1, 3))


def linear_to_srgb(value):
    value = np.clip(value, 0, 1)
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * np.power(value, 1 / 2.4) - 0.055)


def uv_report(obj):
    """Counts UV triangles with flipped or zero area, a proxy for decimation damage to the atlas."""
    obj.data.calc_loop_triangles()
    uv = obj.data.uv_layers.active.data
    signs = []
    for tri in obj.data.loop_triangles:
        a, b, c = (np.array(uv[loop].uv[:]) for loop in tri.loops)
        signs.append(float((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])))
    signs = np.array(signs)
    majority = 1.0 if (signs > 0).sum() >= (signs < 0).sum() else -1.0
    return {"triangles": len(signs), "flipped": int((signs * majority < 0).sum()), "zeroArea": int((np.abs(signs) < 1e-12).sum())}


def bake_geometry(obj, size, output="Position", margin=0):
    """Object-space position/normal of every texel (Cycles CPU emission bake of a Geometry output into a float image).
    Returns (values HxWx3, coverage HxW bool). Coverage is exact UV islands when margin is 0."""
    scene = bpy.context.scene
    saved_margin = scene.render.bake.margin
    scene.render.bake.margin = margin
    target = bpy.data.images.new(f"geometry-{output}", size, size, alpha=True, float_buffer=True)
    target.colorspace_settings.name = "Non-Color"
    target.generated_color = (0, 0, 0, 0)
    material = obj.data.materials[0]
    nodes, links = material.node_tree.nodes, material.node_tree.links
    geometry = nodes.new("ShaderNodeNewGeometry")
    mark = nodes.new("ShaderNodeValue")
    mark.outputs[0].default_value = 1.0
    bake_emission(obj, material, geometry.outputs[output], target)
    values = pixels(target)[..., :3].copy()
    # Second pass: a constant marks covered texels.
    coverage_image = bpy.data.images.new(f"coverage-{output}", size, size, alpha=True, float_buffer=True)
    coverage_image.colorspace_settings.name = "Non-Color"
    bake_emission(obj, material, mark.outputs[0], coverage_image)
    coverage = pixels(coverage_image)[..., 0] > 0.5
    nodes.remove(geometry)
    nodes.remove(mark)
    bpy.data.images.remove(target)
    bpy.data.images.remove(coverage_image)
    scene.render.bake.margin = saved_margin
    return values, coverage


def dilate(mask, radius):
    """Binary dilation by a (2r+1)-square, without wrapping around the atlas border."""
    height, width = mask.shape
    padded = np.pad(mask, radius)
    result = np.zeros_like(mask)
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            result |= padded[dy:dy + height, dx:dx + width]
    return result


def erode(mask, radius):
    return ~dilate(~mask, radius)


def fill_gutters(array, coverage, iterations=24):
    """Extend island texels outward into unused atlas space so mipmaps never average in unrelated values."""
    values = array.astype(np.float32).copy()
    known = coverage.copy()
    if values.ndim == 2:
        values = values[..., None]
    for _ in range(iterations):
        if known.all():
            break
        total = np.zeros_like(values)
        count = np.zeros(known.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            shifted_known = np.roll(np.roll(known, dy, 0), dx, 1)
            shifted = np.roll(np.roll(values, dy, 0), dx, 1)
            total += np.where(shifted_known[..., None], shifted, 0)
            count += shifted_known
        grow = (~known) & (count > 0)
        values[grow] = total[grow] / count[grow][:, None]
        known = known | grow
    if not known.all():
        values[~known] = values[known].mean(axis=0)
    return values[..., 0] if array.ndim == 2 else values


def in_boxes(points, boxes):
    inside = np.zeros(points.shape[:-1], dtype=bool)
    for box in boxes:
        low, high = np.array(box["min"]), np.array(box["max"])
        inside |= np.all((points >= low) & (points <= high), axis=-1)
    return inside


def ensure_uv(obj, margin=0.01, force=False):
    """Smart-project UVs when a mesh has none. force=True replaces existing UVs (joined primitives each bring a
    full 0-1 layout, so their islands overlap and a bake would overwrite itself)."""
    if obj.data.uv_layers and not force:
        return
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    obj.data.uv_layers.new(name="UVMap")
    k.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
