"""Cook a korovany-2 landmark or pickup (static prop) in Blender 5.2.2 LTS from an approved high-detail TRELLIS mesh.

blender -b --factory-startup --python cook_landmark.py -- --raw <raw.glb> --recipe <recipe.json> --out <new dir>

The Echo Well's cook (cook_prop.py) with recipe-declared materials. The approved raw mesh is kept as the bake source.
A decimated copy within the triangle budget receives base colour re-baked from the source (supersampled), a
tangent-space normal map baked from the source plus colour-derived relief, geometric AO, and roughness/metalness from
recipe material classes. Each class selects texels by the hue, saturation and value of the baked base colour, optionally
inside position boxes; the first matching class wins. This is an artistic derivation, not measured PBR. Optional declared
colour repairs act on the baked colour first: matchBoxes gives a part the colour statistics of its matching part, retint
repaints a part toward a colour measured from the approved concept, and facingBalance lifts directional shading TRELLIS
baked into the albedo; each records its before and after in the receipt. A declared moveParts repair moves a small
detached piece back to where the concept shows it, before the bake source is copied.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as m  # noqa: E402
import k2sheet as sheet  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
k.require(recipe.get("schema") == "korovany2-landmark-recipe/1", "Expected a korovany2-landmark-recipe/1 recipe")
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-landmark-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {name: k.sha(here / name) for name in ("cook_landmark.py", "k2cook.py", "k2materials.py", "k2sheet.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()


def normalize_prop(body):
    points = k.coords(body)
    low, high = points.min(axis=0), points.max(axis=0)
    base = points[points[:, 2] < low[2] + (high[2] - low[2]) * recipe.get("baseFraction", 0.03)]
    centre = np.array([(base[:, 0].min() + base[:, 0].max()) / 2, (base[:, 1].min() + base[:, 1].max()) / 2, low[2]])
    shifted = points - centre
    yaw = math.radians(recipe.get("yawDegrees", 0.0))
    rotation = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
    shifted = shifted @ rotation.T
    # Centre the whole silhouette's circumscribed footprint, not just the base, so the reach is as small as it can be.
    if recipe.get("centreFootprint", True):
        mid = (shifted[:, :2].min(axis=0) + shifted[:, :2].max(axis=0)) / 2
        shifted[:, :2] -= mid
    reach = float(np.hypot(shifted[:, 0], shifted[:, 1]).max())
    scale = recipe["reachMeters"] / reach
    k.set_coords(body, shifted * scale)
    final = k.coords(body)
    return {"uniformScale": scale, "sourceReach": reach, "reachMeters": recipe["reachMeters"], "yawDegrees": recipe.get("yawDegrees", 0.0),
            "heightMeters": float(final[:, 2].max()), "baseCentre": centre.tolist(),
            "footprintMeters": (final[:, :2].max(axis=0) - final[:, :2].min(axis=0)).tolist(),
            "axes": "glTF +Y up/+Z forward -> Blender import -> glTF export_yup; no extra axis rotation"}


def drop_floaters(body, minimum):
    """Delete disconnected pieces smaller than `minimum` vertices (TRELLIS floaters); 0 keeps everything."""
    if minimum <= 0:
        return {"minComponentVertices": 0, "removedComponents": 0, "removedVertices": 0}
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    seen, doomed, removed = set(), [], 0
    for vert in bm.verts:
        if vert.index in seen:
            continue
        stack, piece = [vert], [vert]
        seen.add(vert.index)
        while stack:
            current = stack.pop()
            for edge in current.link_edges:
                other = edge.other_vert(current)
                if other.index not in seen:
                    seen.add(other.index)
                    stack.append(other)
                    piece.append(other)
        if len(piece) < minimum:
            doomed.extend(piece)
            removed += 1
    count = len(doomed)
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()
    return {"minComponentVertices": minimum, "removedComponents": removed, "removedVertices": count}


def move_parts(body, specs):
    """Declared geometric repair: each spec moves the connected pieces of at most `maxVertices` vertices whose centroid lies
    in `region` (Blender metres, z up, after normalization) by `offsetMeters`, and requires exactly `count` such pieces
    (default 1). For a part TRELLIS reconstructed detached from where the concept shows it (the Ward Bell's clapper hung
    0.5 m below the bell's lip, where the concept shows its tip at the lip). The piece keeps its shape and texture."""
    facts = []
    for spec in specs:
        bm = bmesh.new()
        bm.from_mesh(body.data)
        bm.verts.ensure_lookup_table()
        low, high = np.array(spec["region"]["min"]), np.array(spec["region"]["max"])
        seen, moved = set(), []
        for vert in bm.verts:
            if vert.index in seen:
                continue
            stack, piece = [vert], [vert]
            seen.add(vert.index)
            while stack:
                current = stack.pop()
                for edge in current.link_edges:
                    other = edge.other_vert(current)
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
                        piece.append(other)
            if len(piece) > spec["maxVertices"]:
                continue
            centroid = np.array([v.co[:] for v in piece]).mean(axis=0)
            if np.all(centroid >= low) and np.all(centroid <= high):
                moved.append((piece, centroid))
        k.require(len(moved) == spec.get("count", 1), f"move {spec['name']}: {len(moved)} matching pieces, expected {spec.get('count', 1)}")
        offset = np.array(spec["offsetMeters"], dtype=np.float64)
        for piece, _ in moved:
            for vert in piece:
                vert.co = (np.array(vert.co[:]) + offset).tolist()
        bm.to_mesh(body.data)
        bm.free()
        body.data.update()
        facts.append({"name": spec["name"], "region": spec["region"], "maxVertices": spec["maxVertices"],
                      "offsetMeters": spec["offsetMeters"], "source": spec.get("source", ""),
                      "pieces": [{"vertices": len(piece), "centroidBefore": [round(float(c), 4) for c in centroid],
                                  "centroidAfter": [round(float(c), 4) for c in centroid + offset]} for piece, centroid in moved]})
    return facts


def decimate(body, budget):
    triangles = k.triangle_count(body)
    if triangles <= budget:
        return {"applied": False, "triangles": triangles}
    k.select_only(body)
    ratio = budget / triangles * 0.985
    modifier = body.modifiers.new("budget", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return {"applied": True, "before": triangles, "triangles": k.triangle_count(body), "ratio": ratio}


def source_albedo(material):
    return next(n for n in material.node_tree.nodes if n.type == "TEX_IMAGE").outputs["Color"]


def hsv(rgb):
    value = rgb.max(axis=2)
    low = rgb.min(axis=2)
    chroma = value - low
    saturation = chroma / np.maximum(value, 1e-4)
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    safe = np.maximum(chroma, 1e-6)
    hue = np.where(value == red, ((green - blue) / safe) % 6, np.where(value == green, (blue - red) / safe + 2, (red - green) / safe + 4))
    return np.where(chroma > 1e-6, hue * 60.0, 0.0), saturation, value


def in_range(channel, bounds):
    low, high = bounds
    return (channel >= low) & (channel <= high)


def hue_in(hue, bounds):
    low, high = bounds
    return (hue >= low) & (hue <= high) if low <= high else (hue >= low) | (hue <= high)


def colour_rule(linear, rule):
    """Texels whose sRGB hue, saturation and value meet a recipe rule ({hue, saturation, value: [low, high]})."""
    hue, saturation, value = hsv(m.linear_to_srgb(np.clip(linear, 0, 1)))
    mask = np.ones(value.shape, dtype=bool)
    if "hue" in rule:
        mask &= hue_in(hue, rule["hue"])
    if "saturation" in rule:
        mask &= in_range(saturation, rule["saturation"])
    if "value" in rule:
        mask &= in_range(value, rule["value"])
    return mask


def facing_balance(linear, position, normal, coverage, spec):
    """Declared lift of baked-in directional shading (TRELLIS bakes the concept's light into albedo): texels selected by
    a colour rule (and optional boxes) are grouped by the horizontal direction their surface faces; each of `sectors`
    equal sectors gets the gain that brings its mean linear luma up to the brightest sector's (never down, at most
    `maxGain`), interpolated around the circle and faded out on surfaces facing up or down. Chroma ratios are kept."""
    sectors = spec.get("sectors", 8)
    mask = coverage & colour_rule(linear, spec.get("colour", {}))
    if "regions" in spec:
        mask &= m.in_boxes(position, spec["regions"])
    length = np.maximum(np.linalg.norm(normal, axis=-1), 1e-6)
    nx, ny, nz = normal[..., 0] / length, normal[..., 1] / length, normal[..., 2] / length
    horizontal = np.clip((0.85 - np.abs(nz)) / 0.35, 0, 1)
    angle = np.arctan2(ny, nx)
    place = (angle + np.pi) / (2 * np.pi) * sectors
    index = np.floor(place).astype(int) % sectors
    luma = m.luminance(linear)
    means, weights = [], []
    for sector in range(sectors):
        w = horizontal * (mask & (index == sector))
        total = float(w.sum())
        weights.append(total)
        means.append(float((luma * w).sum() / total) if total > 0 else 0.0)
    usable = [mean for mean, total in zip(means, weights) if total >= spec.get("minTexels", 2000)]
    k.require(len(usable) >= sectors // 2, f"facing balance {spec['name']}: too few texels per sector")
    target = max(usable)
    gains = [min(max(target / mean, 1.0), spec.get("maxGain", 3.0)) if total >= spec.get("minTexels", 2000) and mean > 0 else 1.0
             for mean, total in zip(means, weights)]
    shifted = place - 0.5
    k0 = np.floor(shifted).astype(int) % sectors
    t = shifted - np.floor(shifted)
    table = np.array(gains)
    gain = table[k0] * (1 - t) + table[(k0 + 1) % sectors] * t
    weight = np.clip(m.blur(mask.astype(np.float32), 2), 0, 1) * horizontal * spec.get("strength", 1.0)
    factor = 1 + (gain - 1) * weight
    lifted = np.clip(linear * factor[..., None], 0, 1)
    after = m.luminance(lifted)
    after_means = []
    for sector in range(sectors):
        w = horizontal * (mask & (index == sector))
        after_means.append(float((after * w).sum() / max(float(w.sum()), 1e-9)))
    to_srgb = lambda value: round(float(m.linear_to_srgb(np.array(value))) * 255, 1)  # noqa: E731
    return lifted, {"name": spec["name"], "colour": spec.get("colour", {}), "regions": spec.get("regions"), "sectors": sectors,
                    "maxGain": spec.get("maxGain", 3.0), "strength": spec.get("strength", 1.0), "texels": int(mask.sum()),
                    "sectorLumaBefore": [to_srgb(v) for v in means], "sectorLumaAfter": [to_srgb(v) for v in after_means],
                    "sectorGains": [round(g, 3) for g in gains], "sectorTexels": [int(w) for w in weights],
                    "note": "Sector 0 faces -X; sectors advance counter-clockwise seen from above; luma is sRGB 0-255."}


def match_boxes(linear, position, coverage, spec):
    """Declared colour repair: texels in the target boxes (optionally matching a colour rule) take the per-channel mean and
    spread of the reference boxes (linear colour), so a part TRELLIS textured differently from its matching part (one
    antler near black, the other bone-white, as in the concept) matches it again; feathered at the target box faces."""
    rule = spec.get("colour", {})
    target = coverage & m.in_boxes(position, spec["target"]) & colour_rule(linear, rule)
    reference = coverage & m.in_boxes(position, spec["reference"]) & colour_rule(linear, rule)
    k.require(target.sum() > 200 and reference.sum() > 200, f"match {spec['name']}: too few texels")
    mean_t, std_t = linear[target].mean(axis=0), linear[target].std(axis=0) + 1e-4
    mean_r, std_r = linear[reference].mean(axis=0), linear[reference].std(axis=0) + 1e-4
    matched = np.clip((linear - mean_t) * (std_r / std_t) + mean_r, 0, 1)
    edge = spec.get("edgeMeters", 0.0)
    ramp = np.ones(target.shape, dtype=np.float32)
    if edge > 0:
        inside = np.zeros(target.shape, dtype=np.float32)
        for box in spec["target"]:
            low, high = np.array(box["min"]), np.array(box["max"])
            depth = np.minimum(position - low, high - position).min(axis=-1)
            inside = np.maximum(inside, np.clip(depth / edge, 0, 1))
        ramp = inside * inside * (3 - 2 * inside)
    weight = (np.clip(m.blur(target.astype(np.float32), 2), 0, 1) * ramp * spec.get("strength", 1.0))[..., None]
    repaired = linear * (1 - weight) + matched * weight
    srgb = lambda rgb: [round(float(c) * 255, 1) for c in m.linear_to_srgb(np.asarray(rgb))]  # noqa: E731
    return repaired, {"name": spec["name"], "target": spec["target"], "reference": spec["reference"], "colour": rule,
                      "strength": spec.get("strength", 1.0), "edgeMeters": edge, "texels": int(target.sum()),
                      "referenceTexels": int(reference.sum()), "targetMeanBefore": srgb(mean_t), "referenceMean": srgb(mean_r),
                      "targetMeanAfter": srgb(repaired[target].mean(axis=0))}


def retint(linear, position, coverage, spec):
    """Declared repaint toward a colour measured from the approved concept (sRGB 0-1 `target`): texels in the boxes
    (optionally matching a colour rule) move toward the target by `strength`, keeping each texel's luma relative to the
    masked local mean (about 14 texels around it; ratio clipped to [0.5, 1.6], scaled by `keepDetail`), so painted
    grain survives while the part's overall tone follows the concept. For a part TRELLIS painted in a different colour
    on every seed (the Stag Gate's bone-white antlers came out near-black); a repaint of existing texels, not new detail."""
    rule = spec.get("colour", {})
    mask = coverage & m.in_boxes(position, spec["regions"]) & colour_rule(linear, rule)
    k.require(mask.sum() > 200, f"retint {spec['name']}: too few texels")
    weightless = mask.astype(np.float32)
    luma = m.luminance(linear)
    factor = 8
    numerator = m.blur(m.downsample(luma * weightless, factor), 4)
    denominator = m.blur(m.downsample(weightless, factor), 4)
    local = numerator / np.maximum(denominator, 1e-4)
    local = m.blur(np.repeat(np.repeat(local, factor, 0), factor, 1), 4)
    relative = np.clip(luma / np.maximum(local, 1e-4), 0.5, 1.6)
    relative = 1 + (relative - 1) * spec.get("keepDetail", 1.0)
    target = m.srgb_to_linear(np.array(spec["target"], dtype=np.float32))
    painted = np.clip(target * relative[..., None], 0, 1)
    edge = spec.get("edgeMeters", 0.0)
    ramp = np.ones(mask.shape, dtype=np.float32)
    if edge > 0:
        inside = np.zeros(mask.shape, dtype=np.float32)
        for box in spec["regions"]:
            low, high = np.array(box["min"]), np.array(box["max"])
            depth = np.minimum(position - low, high - position).min(axis=-1)
            inside = np.maximum(inside, np.clip(depth / edge, 0, 1))
        ramp = inside * inside * (3 - 2 * inside)
    weight = (np.clip(m.blur(weightless, 2), 0, 1) * ramp * spec.get("strength", 1.0))[..., None]
    before = linear[mask].mean(axis=0)
    repainted = linear * (1 - weight) + painted * weight
    srgb = lambda rgb: [round(float(c) * 255, 1) for c in m.linear_to_srgb(np.asarray(rgb))]  # noqa: E731
    return repainted, {"name": spec["name"], "regions": spec["regions"], "colour": rule, "target": spec["target"],
                       "strength": spec.get("strength", 1.0), "keepDetail": spec.get("keepDetail", 1.0), "edgeMeters": edge,
                       "texels": int(mask.sum()), "meanBefore": srgb(before), "meanAfter": srgb(repainted[mask].mean(axis=0)),
                       "source": spec.get("source", "")}


def bake(high, body):
    B = recipe["material"]
    bake_size = B.get("bakeSize", max(recipe["albedoSizes"]))
    maps_size = B["mapsSize"]
    extrusion, distance = B["cageExtrusionMeters"], B["maxRayMeters"]
    m.cycles_cpu(1)
    body.data.materials[0] = body.data.materials[0].copy()
    colour_image = m.image("bake-colour", bake_size, "sRGB")
    m.bake_selected_to_active(high, body, "EMIT", colour_image, extrusion, distance, emission_from=source_albedo)
    colour = m.pixels(colour_image)[..., :3]
    normal_image = m.image("bake-normal", maps_size, "Non-Color")
    m.bake_selected_to_active(high, body, "NORMAL", normal_image, extrusion, distance)
    geometric_normal = m.pixels(normal_image)[..., :3]
    high.hide_render = True
    m.cycles_cpu(B["aoSamples"])
    ao_image = m.image("bake-ao", maps_size, "Non-Color")
    m.bake_type(body, body.data.materials[0], "AO", ao_image)
    high.hide_render = False
    ao = np.clip(m.pixels(ao_image)[..., 0] ** B["aoPower"], B["aoFloor"], 1)
    factor = bake_size // maps_size
    m.cycles_cpu(1)
    position, coverage = m.bake_geometry(body, maps_size, "Position")
    position_bake, coverage_bake = m.bake_geometry(body, bake_size, "Position")
    linear = m.fill_gutters(m.srgb_to_linear(colour), coverage_bake)
    # Declared colour repairs on the baked colour, before the material classes read it.
    repairs = {}
    if B.get("matchBoxes"):
        repairs["matchBoxes"] = []
        for spec in B["matchBoxes"]:
            linear, fact = match_boxes(linear, position_bake, coverage_bake, spec)
            repairs["matchBoxes"].append(fact)
    if B.get("retint"):
        repairs["retint"] = []
        for spec in B["retint"]:
            linear, fact = retint(linear, position_bake, coverage_bake, spec)
            repairs["retint"].append(fact)
    if B.get("facingBalance"):
        normal_bake, _ = m.bake_geometry(body, bake_size, "Normal")
        repairs["facingBalance"] = []
        for spec in B["facingBalance"]:
            linear, fact = facing_balance(linear, position_bake, normal_bake, coverage_bake, spec)
            repairs["facingBalance"].append(fact)
    if repairs:
        linear = m.fill_gutters(linear, coverage_bake)
    small = m.linear_to_srgb(m.downsample(linear, factor))
    hue, saturation, value = hsv(small)
    lum = m.luminance(m.srgb_to_linear(small))
    detail = lum - m.blur(lum, 6)
    rough = np.full(value.shape, B["roughness"], dtype=np.float32)
    metal = np.full(value.shape, B.get("metalness", 0.0), dtype=np.float32)
    claimed = np.zeros(value.shape, dtype=bool)
    fractions = {}
    for spec in B["classes"]:
        mask = ~claimed
        if "hue" in spec:
            mask &= hue_in(hue, spec["hue"])
        if "saturation" in spec:
            mask &= in_range(saturation, spec["saturation"])
        if "value" in spec:
            mask &= in_range(value, spec["value"])
        if "regions" in spec:
            mask &= m.in_boxes(position, spec["regions"])
        rough[mask] = spec["roughness"]
        metal[mask] = spec.get("metalness", 0.0)
        claimed |= mask
        fractions[spec["name"]] = float(mask[coverage].mean())
    metal = m.blur(metal, 1)
    rough = np.clip(m.blur(rough, 1) - detail * B["roughnessFromDetail"], B["roughnessMin"], B["roughnessMax"])
    relief = m.height_normal(m.blur(detail, 1), B["reliefStrength"])
    normal = m.fill_gutters(m.blend_normals(geometric_normal, relief), coverage) * 2 - 1
    normal = normal / np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6) * 0.5 + 0.5
    ao, rough, metal = (m.fill_gutters(channel, coverage) for channel in (ao, rough, metal))
    ones = np.ones_like(ao)
    normal_final = m.image("prop-normal", maps_size, "Non-Color")
    m.set_pixels(normal_final, np.dstack([normal, ones]))
    orm_final = m.image("prop-orm", maps_size, "Non-Color")
    m.set_pixels(orm_final, np.dstack([ao, rough, metal, ones]))
    bases = {}
    for size in recipe["albedoSizes"]:
        tone = m.linear_to_srgb(m.downsample(linear, bake_size // size) * B["albedoGain"])
        image = m.image(f"prop-base-{size}", size, "sRGB")
        m.set_pixels(image, np.dstack([tone, np.ones(tone.shape[:2])]))
        bases[size] = image
    for image in (normal_final, orm_final, *bases.values()):
        image.pack()
    np.save(out / "normal-geometric.npy", geometric_normal.astype(np.float16))
    for label, array in (("ao", ao), ("roughness", rough), ("metalness", metal)):
        m.encode_webp(np.dstack([array, array, array, ones]), out / f"debug-{label}.webp", 90, "Non-Color")
    return bases, normal_final, orm_final, {
        "bakeSize": bake_size, "mapsSize": maps_size, "albedoSizes": recipe["albedoSizes"], "albedoGain": B["albedoGain"],
        "cageExtrusionMeters": extrusion, "maxRayMeters": distance, "atlasCoverage": float(coverage.mean()),
        "metalFractionOfSurface": float((metal[coverage] > 0.5).mean()),
        "classFractions": fractions, "unclassifiedFraction": float((~claimed)[coverage].mean()),
        "roughnessMean": float(rough[coverage].mean()), "metalnessMean": float(metal[coverage].mean()), "aoMean": float(ao[coverage].mean()),
        **({"colourRepairs": repairs} if repairs else {}),
        "provenance": "Base colour re-baked (Cycles CPU, emission, selected-to-active, supersampled) from the approved TRELLIS source mesh, "
                      "then any declared colour repairs the recipe lists (matchBoxes, retint, facingBalance); "
                      "tangent normals baked from the approved source mesh and whiteout-blended with relief derived from colour; "
                      "AO baked from the decimated geometry; roughness and metalness from recipe colour classes. Artistic derivation, not measured PBR."}


def main():
    k.setup_scene()
    body = k.import_single_mesh(args.raw, recipe["id"])
    receipt["rawTopology"] = k.topology_report(body)
    # A reconstructed contact-shadow sheet is removed in raw units before normalization (k2sheet.py, as the wagons).
    receipt["groundSheet"] = sheet.remove_ground_sheet(body, recipe.get("groundSheet"))
    receipt["floaters"] = drop_floaters(body, recipe.get("minComponentVertices", 0))
    receipt["normalization"] = normalize_prop(body)
    if recipe.get("moveParts"):
        receipt["movedParts"] = move_parts(body, recipe["moveParts"])
    receipt["cleanup"] = k.clean_mesh(body)
    high = body.copy()
    high.data = body.data.copy()
    high.name = f"{recipe['id']}-source"
    bpy.context.scene.collection.objects.link(high)
    receipt["uvBefore"] = m.uv_report(body)
    receipt["decimation"] = decimate(body, recipe["triangleBudget"])
    receipt["uvAfter"] = m.uv_report(body)
    k.select_only(body)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(recipe["smoothAngle"]))
    receipt["topology"] = k.topology_report(body)
    bases, normal, orm, receipt["materials"] = bake(high, body)
    bpy.data.objects.remove(high, do_unlink=True)
    outputs = []
    for size, base in bases.items():
        material = m.gltf_material(recipe["id"], base, normal, orm, recipe["material"]["normalMapStrength"])
        body.data.materials.clear()
        body.data.materials.append(material)
        path = out / f"{recipe['id']}-albedo{size}.glb"
        k.export_glb(path, [body], animations=False, tangents=True)
        doc, _ = k.read_glb(path)
        k.require(len(doc["meshes"]) == 1 and len(doc["meshes"][0]["primitives"]) == 1, "Prop must export one mesh primitive")
        k.require("TANGENT" in doc["meshes"][0]["primitives"][0]["attributes"], "Tangents are required for the baked normal map")
        outputs.append({"file": path.name, "albedoSize": size, "bytes": path.stat().st_size, "sha256": k.sha(path),
                        "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]})
    receipt["outputs"] = outputs
    if len(outputs) == 1:
        receipt["output"] = outputs[0]
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-review"


try:
    main()
except Exception as error:
    receipt["status"] = "failed"
    receipt["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    receipt["seconds"] = time.monotonic() - started
    (out / "cook.json").write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("K2_COOK=" + json.dumps({key: receipt.get(key) for key in ("status", "error", "outputs")}, default=str))
