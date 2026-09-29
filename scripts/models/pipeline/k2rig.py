"""Shared Blender 5.2 skeleton, weighting, posing, item and body-bake helpers for korovany-2 humanoids.

Generalized from cook_soldier.py, which stays the exact recipe of the shipped line soldier. Coordinates are
cooked metres on Blender axes: +Z up, the front faces -Y, character left is +X. Every function takes the recipe
explicitly; nothing here reads command-line arguments.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import k2cook as k
import k2materials as m

GRIP_ALONG = Vector((0.0, -1.0, 0.15)).normalized()


def mirror(point, sign):
    return Vector((point[0] * sign, point[1], point[2]))


def skirt_key(L, name):
    """Hem sway bones: `skirtFront`/`skirtBack` (heroes) or the soldier's `tabardFront`/`tabardBack`."""
    return name if name in L else name.replace("skirt", "tabard")


def skeleton(recipe):
    """Joint definitions {bone: (head, tail, parent, deform)} from recipe landmarks and sockets."""
    L = recipe["landmarks"]
    defs = {}

    def add(name, head, tail, parent, deform=True):
        defs[name] = (tuple(head), tuple(tail), parent, deform)

    add("root", (0, 0, 0), (0, 0, 0.18), None, False)
    add("pelvis", L["pelvis"], L["spine"], "root")
    add("spine", L["spine"], L["chest"], "pelvis")
    add("chest", L["chest"], L["neck"], "spine")
    add("neck", L["neck"], L["head"], "chest")
    add("head", L["head"], L["crown"], "neck")
    helpers = recipe["weights"].get("helpers")
    for side, sign in (("l", 1), ("r", -1)):
        add(f"clavicle_{side}", mirror(L["clavicle"], sign), mirror(L["shoulder"], sign), "chest")
        add(f"upperarm_{side}", mirror(L["shoulder"], sign), mirror(L["elbow"], sign), f"clavicle_{side}")
        add(f"forearm_{side}", mirror(L["elbow"], sign), mirror(L["wrist"], sign), f"upperarm_{side}")
        add(f"hand_{side}", mirror(L["wrist"], sign), mirror(L["knuckle"], sign), f"forearm_{side}")
        add(f"fingers_{side}", mirror(L["knuckle"], sign), mirror(L["fingertip"], sign), f"hand_{side}")
        add(f"thigh_{side}", mirror(L["hip"], sign), mirror(L["knee"], sign), "pelvis")
        add(f"shin_{side}", mirror(L["knee"], sign), mirror(L["ankle"], sign), f"thigh_{side}")
        add(f"foot_{side}", mirror(L["ankle"], sign), mirror(L["ball"], sign), f"shin_{side}")
        add(f"toe_{side}", mirror(L["ball"], sign), mirror(L["toe"], sign), f"foot_{side}")
        if helpers:
            shoulder, elbow = Vector(mirror(L["shoulder"], sign)), Vector(mirror(L["elbow"], sign))
            add(f"shoulderhelper_{side}", shoulder, shoulder + (elbow - shoulder).normalized() * 0.08, f"clavicle_{side}")
            knee, ankle = Vector(mirror(L["knee"], sign)), Vector(mirror(L["ankle"], sign))
            add(f"kneehelper_{side}", knee, knee + (ankle - knee).normalized() * 0.08, f"thigh_{side}")
            if recipe["weights"].get("hipHelpers"):
                hip = Vector(mirror(L["hip"], sign))
                add(f"hiphelper_{side}", hip, hip + (knee - hip).normalized() * 0.08, "pelvis")
    front, back = skirt_key(L, "skirtFront"), skirt_key(L, "skirtBack")
    if "cape" in L:
        # A cape hangs from the upper back in two segments, so it can flare and trail.
        top, mid, tip = Vector(L["cape"]), Vector(L["capeMid"]), Vector(L["capeTip"])
        add("cape", top, mid, "chest")
        add("cape_lower", mid, tip, "cape")
    if front in L:
        panels = recipe["weights"].get("skirtPanels", 2)
        if panels == 4:
            # Per-leg hem panels: each half of a split tunic follows its own thigh.
            offset = recipe["weights"].get("skirtPanelOffset", 0.12)
            for side, sign in (("l", 1), ("r", -1)):
                for name, key in (("front", front), ("back", back)):
                    head, tail = Vector(L[key]), Vector(L[key + "Tip"])
                    head.x, tail.x = sign * offset, sign * offset
                    add(f"skirt_{name}_{side}", head, tail, "pelvis")
        else:
            add("skirt_front", L[front], L[front + "Tip"], "pelvis")
            add("skirt_back", L[back], L[back + "Tip"], "pelvis")
    for spec in recipe.get("sockets", []):
        side = spec.get("side", "r")
        sign = 1 if side == "l" else -1
        offset = Vector(spec.get("offset", (0, 0, 0)))
        offset.x *= sign
        if spec["kind"] == "grip":
            wrist, knuckle = Vector(defs[f"hand_{side}"][0]), Vector(defs[f"hand_{side}"][1])
            point = wrist.lerp(knuckle, spec.get("t", 0.6)) + offset
            add(spec["name"], point, point + Vector((0, -0.1, 0)), f"hand_{side}", False)
        elif spec["kind"] == "strap":
            elbow, wrist = Vector(defs[f"forearm_{side}"][0]), Vector(defs[f"forearm_{side}"][1])
            point = elbow.lerp(wrist, spec.get("t", 0.55)) + offset
            add(spec["name"], point, point + (wrist - elbow).normalized() * 0.1, f"forearm_{side}", False)
        else:
            point = Vector(spec["at"])
            add(spec["name"], point, point + Vector((0, 0, 0.1)), spec["parent"], False)
    return defs


def part_of(defs):
    """Body part owning each deforming joint."""
    table = {}
    for name, (_, _, _, deform) in defs.items():
        if not deform:
            continue
        if name.startswith("skirt"):
            table[name] = "skirt"
            continue
        if name.startswith("cape"):
            table[name] = "cape"
            continue
        side = name[-1] if name[-2:] in ("_l", "_r") else None
        prefix = name.rsplit("_", 1)[0] if side else name
        if prefix in ("upperarm", "forearm", "hand", "fingers", "shoulderhelper"):
            table[name] = f"arm_{side}"
        elif prefix in ("thigh", "shin", "foot", "toe", "kneehelper", "hiphelper"):
            table[name] = f"leg_{side}"
        elif name in ("neck", "head"):
            table[name] = "head"
        else:
            table[name] = "torso"
    return table


SKIRT_BONES = ("skirt_front", "skirt_back", "skirt_front_l", "skirt_front_r", "skirt_back_l", "skirt_back_r")


def skirt_bones(defs):
    return [name for name in SKIRT_BONES if name in defs]


def prune_weights(body, min_weight, max_influences=4):
    """Drop skin influences below `min_weight` and renormalize. A 0.08 % stray knee-helper weight still moves a boot
    vertex by a fraction of a millimetre against its rigid neighbours, which tears millimetre edges."""
    names = [group.name for group in body.vertex_groups]
    pruned = 0
    for vertex in body.data.vertices:
        entries = sorted(((element.group, element.weight) for element in vertex.groups), key=lambda item: -item[1])[:max_influences]
        kept = [(group, weight) for group, weight in entries if weight >= min_weight] or entries[:1]
        total = sum(weight for _, weight in kept)
        dropped = {group for group, _ in entries} - {group for group, _ in kept}
        pruned += len(dropped)
        for group in [element.group for element in vertex.groups]:
            if group not in {g for g, _ in kept}:
                body.vertex_groups[names[group]].remove([vertex.index])
        for group, weight in kept:
            body.vertex_groups[names[group]].add([vertex.index], weight / total, "REPLACE")
    return {"minWeight": min_weight, "influencesPruned": pruned}


def soften_seams(body, iterations=8, rings=4, locked=(), allowed=None, names=None, threshold=0.6, z_range=None):
    """Laplacian relaxation of skin weights near seams where neighbouring vertices disagree strongly (part
    boundaries such as the back of the armpit), so a raised arm stretches a band of surface instead of one row of
    edges. Vertices farther than `rings` edges from a seam and locked vertices keep their weights; with `allowed`
    (vertices x `names`), relaxation never introduces a joint a vertex's region may not use."""
    group_names = [group.name for group in body.vertex_groups]
    count = len(body.data.vertices)
    weights = np.zeros((count, len(group_names)))
    for vertex in body.data.vertices:
        for element in vertex.groups:
            weights[vertex.index, element.group] = element.weight
    mask = None
    if allowed is not None:
        mask = np.zeros_like(weights, dtype=bool)
        for column, name in enumerate(names):
            if name in group_names:
                mask[:, group_names.index(name)] = allowed[:, column]
        # Blends may assign joints outside the partition (the skirt ramp's thighs above the crotch line): keep them.
        mask |= weights > 1e-6
    edges = k.adjacency(body)
    difference = np.abs(weights[edges[:, 0]] - weights[edges[:, 1]]).sum(axis=1)
    seam = np.zeros(count, dtype=bool)
    strong = edges[difference > threshold]
    seam[strong[:, 0]] = True
    seam[strong[:, 1]] = True
    zone = seam.copy()
    for _ in range(rings):
        grow = zone.copy()
        grow[edges[:, 0]] |= zone[edges[:, 1]]
        grow[edges[:, 1]] |= zone[edges[:, 0]]
        zone = grow
    lock = np.zeros(count, dtype=bool)
    lock[list(locked)] = True
    zone &= ~lock
    degree = np.zeros(count)
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    for _ in range(iterations):
        spread = np.zeros_like(weights)
        np.add.at(spread, edges[:, 0], weights[edges[:, 1]])
        np.add.at(spread, edges[:, 1], weights[edges[:, 0]])
        relaxed = 0.5 * weights + 0.5 * spread / np.maximum(degree[:, None], 1)
        if mask is not None:
            relaxed = np.where(mask, relaxed, 0)
            relaxed /= np.maximum(relaxed.sum(axis=1, keepdims=True), 1e-12)
        weights[zone] = relaxed[zone]
    weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
    for vertex in np.flatnonzero(zone):
        order = np.argsort(-weights[vertex])[:4]
        kept = [(int(g), float(weights[vertex, g])) for g in order if weights[vertex, g] > 1e-4]
        total = sum(w for _, w in kept)
        for element in list(body.data.vertices[vertex].groups):
            body.vertex_groups[group_names[element.group]].remove([int(vertex)])
        for group, weight in kept:
            body.vertex_groups[group_names[group]].add([int(vertex)], weight / total, "REPLACE")
    return {"seamVertices": int(seam.sum()), "softenedVertices": int(zone.sum()), "iterations": iterations, "rings": rings,
            "respectsRegions": mask is not None}


def cap_share(body, bones, receiver, z_top, z_full, max_share=1.0):
    """Cap the combined weight of `bones` at smoothstep(z_top -> z_full) (0 at or above z_top, max_share at or below
    z_full) and give the remainder to `receiver`: a smooth vertical hand-over such as boot shaft -> foot."""
    names = [group.name for group in body.vertex_groups]
    columns = [names.index(name) for name in bones if name in names]
    if not columns or receiver not in names:
        return 0
    target = names.index(receiver)
    changed = 0
    for vertex in body.data.vertices:
        weights = {element.group: element.weight for element in vertex.groups}
        share = sum(weights.get(index, 0.0) for index in columns)
        if share <= 1e-6:
            continue
        t = min(1.0, max(0.0, (z_top - vertex.co.z) / (z_top - z_full)))
        cap = t * t * (3 - 2 * t) * max_share
        if share <= cap:
            continue
        scale = cap / share
        for index in columns:
            if index in weights:
                weights[index] *= scale
        weights[target] = weights.get(target, 0.0) + share - cap
        entries = sorted(weights.items(), key=lambda item: -item[1])[:4]
        total = sum(weight for _, weight in entries)
        for element in list(vertex.groups):
            body.vertex_groups[names[element.group]].remove([vertex.index])
        for index, weight in entries:
            if weight > 1e-4:
                body.vertex_groups[names[index]].add([vertex.index], weight / total, "REPLACE")
        changed += 1
    return changed


def skirt_ramp(body, spec):
    """Hem panels hang from the belt: cap the skirt bones' share near the belt and give the remainder to the pelvis,
    so the cloth near the belt never folds into it when the panels swing."""
    changed = cap_share(body, SKIRT_BONES, "pelvis", spec["zTop"], spec["zFull"], spec.get("maxShare", 1.0))
    return {"applied": True, "vertices": changed, **spec}


def ankle_ramp(body, defs, spec):
    """Tall boots: the foot hands the boot shaft over to the shin smoothly between ankle + full and ankle + top."""
    facts = {}
    for side in ("l", "r"):
        ankle = defs[f"foot_{side}"][0][2]
        facts[side] = cap_share(body, (f"foot_{side}", f"toe_{side}"), f"shin_{side}", ankle + spec["top"], ankle + spec["full"])
    return {"applied": True, "vertices": facts, **spec}


def mantle_ramp(body, defs, spec):
    """A cape or mantle welded over the back of the upper arms: behind the arm (y > minY, between bottom and top),
    weight follows the upper arm on the arm's own surface and hands over to the clavicle and chest with distance
    from the upper-arm segment (smoothstep near -> far), through the shoulder helper, so a raised arm stretches the
    whole mantle a little instead of tearing the weld."""
    names = [group.name for group in body.vertex_groups]
    points = k.coords(body)
    changed = {}
    for side, sign in (("l", 1), ("r", -1)):
        arm = [names.index(n) for n in (f"upperarm_{side}", f"shoulderhelper_{side}") if n in names]
        proximal = [names.index(n) for n in (f"clavicle_{side}", "chest") if n in names]
        if len(arm) < 1 or not proximal:
            continue
        head, tail = defs[f"upperarm_{side}"][0], defs[f"upperarm_{side}"][1]
        distance, _ = k.segment_distance(points, head, tail)
        zone = ((points[:, 1] > spec["minY"]) & (points[:, 2] > spec["bottom"]) & (points[:, 2] < spec["top"])
                & (sign * points[:, 0] > spec["inner"]) & (distance < spec["far"] + 0.05))
        count = 0
        for index in np.flatnonzero(zone):
            vertex = body.data.vertices[int(index)]
            weights = {element.group: element.weight for element in vertex.groups}
            if any(group not in arm + proximal + [names.index(n) for n in ("spine", "neck") if n in names] for group in weights):
                continue
            u = min(1.0, max(0.0, (spec["far"] - distance[index]) / (spec["far"] - spec["near"])))
            t = u * u * (3 - 2 * u)
            new = {arm[0]: t * t}
            if len(arm) > 1:
                new[arm[1]] = t - t * t
            new[proximal[0]] = (1 - t) * spec.get("clavicleShare", 0.5)
            if len(proximal) > 1:
                new[proximal[1]] = (1 - t) * (1 - spec.get("clavicleShare", 0.5))
            for element in list(vertex.groups):
                body.vertex_groups[names[element.group]].remove([vertex.index])
            total = sum(new.values())
            for group, weight in new.items():
                if weight > 1e-4:
                    body.vertex_groups[names[group]].add([vertex.index], weight / total, "REPLACE")
            count += 1
        changed[side] = count
    return {"applied": True, "vertices": changed, **spec}


def region(R, name, default=None):
    """Recipe region value with the soldier's tabard names accepted for the generic skirt."""
    if name in R:
        return R[name]
    legacy = name.replace("skirt", "tabard")
    if legacy in R:
        return R[legacy]
    if default is not None:
        return default
    raise KeyError(name)


def partition_masks(recipe, body, defs):
    """Every vertex belongs to the body part of its nearest joint segment; each part may only use its own joints
    plus the neighbours it blends with inside declared bands around the shoulder, hip and neck. Bone heat then
    distributes weights inside those limits."""
    R = recipe["regions"]
    W = recipe["weights"]
    B = W.get("bands", {"shoulder": 0.12, "hip": 0.12, "neck": 0.06})
    radius = W.get("partRadius", {})
    PART_OF = part_of(defs)
    points = k.coords(body)
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    distance = np.empty((len(points), len(names)))
    for column, name in enumerate(names):
        head, tail, _, _ = defs[name]
        distance[:, column], _ = k.segment_distance(points, head, tail)
        prefix = name.rsplit("_", 1)[0] if name[-2:] in ("_l", "_r") else name
        distance[:, column] /= radius.get(prefix, radius.get(name, 0.1))
    part = np.array([PART_OF[names[i]] for i in np.argmin(distance, axis=1)], dtype="<U8")
    part_names = sorted(set(PART_OF.values()))
    part_distance = np.stack([distance[:, [i for i, n in enumerate(names) if PART_OF[n] == p]].min(axis=1) for p in part_names], axis=1)
    order = np.argsort(part_distance, axis=1)
    best_d = np.take_along_axis(part_distance, order[:, :1], axis=1)[:, 0]
    second_d = np.take_along_axis(part_distance, order[:, 1:2], axis=1)[:, 0]
    second = np.array(part_names)[order[:, 1]]
    ambiguous = second_d < best_d * W.get("ambiguity", 1.25)
    lateral = (np.abs(x) > R["torsoHalfWidth"] + R.get("lateralMargin", 0.04)) & (z > R["handMinHeight"]) & (z < R["armpitHeight"] + 0.08)
    if "armMaxY" in R:
        # A cape hanging behind the arms stays with the torso.
        lateral &= y < R["armMaxY"]
    # Only arm-adjacent surface is claimed for the arms: a hip pouch beside the hand stays torso.
    near_arm_l = (np.char.startswith(part, "arm_l")) | ((second == "arm_l") & (second_d < best_d * W.get("lateralAmbiguity", 1.6)))
    near_arm_r = (np.char.startswith(part, "arm_r")) | ((second == "arm_r") & (second_d < best_d * W.get("lateralAmbiguity", 1.6)))
    part[lateral & (x > 0) & near_arm_l] = "arm_l"
    part[lateral & (x < 0) & near_arm_r] = "arm_r"
    if "mantleMinY" in R:
        # A cape draped over the back of the upper arms is torso (a stiff mantle), not arm: it must not be split
        # between an arm and the chest on a single row of edges.
        mantle = (y > R["mantleMinY"]) & (z > R.get("mantleBottom", R["handMinHeight"])) & np.char.startswith(part, "arm")
        mantle &= np.abs(x) < R.get("mantleHalfWidth", 1.0)
        part[mantle] = "torso"
    has_skirt = bool(skirt_bones(defs))
    # Separately closed shells (legs TRELLIS sealed inside a long coat) keep their distance-based part: only the
    # main surface takes the skirt, lateral-arm and head overrides.
    shells = k.components(np.arange(len(points)), k.adjacency(body))
    main = np.zeros(len(points), dtype=bool)
    main[shells[0]] = True
    if has_skirt:
        skirt_zone = (z > region(R, "skirtHemHeight") - 0.02) & (z < region(R, "skirtTop")) & (np.abs(x) < region(R, "skirtHalfWidth"))
        part[skirt_zone & main & ~np.char.startswith(part, "arm")] = "skirt"
    for shell in shells[1:]:
        # A closed leg shell belongs to the leg of its side as a whole.
        centre = points[shell].mean(axis=0)
        if centre[2] < R["crotchHeight"]:
            part[shell] = "leg_l" if centre[0] > 0 else "leg_r"
    head_zone = ((z > R["headMinHeight"]) & (np.abs(x) < R["headHalfWidth"])) | (z > R["helmetMinHeight"])
    part[head_zone] = "head"
    has_cape = "cape" in R
    if has_cape:
        # Cape: behind the back plane, on the main surface, and not the head. It hangs from the shoulders, so it may
        # only use torso joints (and cape bones, if any) and the back hem panels, never the thighs or hip helpers.
        C = R["cape"]
        cape_zone = main & (y > C["minY"]) & (z < C["top"]) & (z > C["bottom"]) & (np.abs(x) < C["halfWidth"]) & ~head_zone
        part[cape_zone] = "cape"
    column = {name: index for index, name in enumerate(names)}
    allowed = np.zeros((len(points), len(names)), dtype=bool)

    def allow(mask, *bones):
        for bone in bones:
            if bone in column:
                allowed[mask, column[bone]] = True

    near = {}
    for side in ("l", "r"):
        near[f"shoulder_{side}"] = np.linalg.norm(points - np.array(defs[f"upperarm_{side}"][0]), axis=1) < B["shoulder"]
        armpit = np.array(defs[f"upperarm_{side}"][0]) + np.array(B.get("armpitOffset", (0.06, 0, -0.16))) * np.array([1 if side == "l" else -1, 1, 1])
        near[f"shoulder_{side}"] |= np.linalg.norm(points - armpit, axis=1) < B.get("armpit", 0.0)
        near[f"hip_{side}"] = np.linalg.norm(points - np.array(defs[f"thigh_{side}"][0]), axis=1) < B["hip"]
    skirt_top = region(R, "skirtTop", 0.0) if has_skirt else 0.0
    torso, head, skirt = part == "torso", part == "head", part == "skirt"
    allow(torso, "pelvis", "spine", "chest", "clavicle_l", "clavicle_r")
    # Heat diffuses across hoods and collars: a clavicle may only reach just past the midline.
    midline = W.get("clavicleMidline", 0.04)
    allow(torso & (z < skirt_top), *SKIRT_BONES)
    allow(head, "neck", "head")
    allow(head & (z < R["neckHeight"] + B["neck"]), "chest")
    allow(torso & (z > R["neckHeight"] - B["neck"]), "neck")
    allow(torso & ambiguous & (second == "head"), "neck", "head")
    allow(head & ambiguous & (second == "torso"), "chest", "neck")
    allow(skirt, "pelvis", "spine", "chest", *SKIRT_BONES)
    allow(skirt & (z < R["crotchHeight"]), "thigh_l", "thigh_r")
    if has_cape:
        cape = part == "cape"
        allow(cape, "chest", "spine", "cape", "cape_lower")
        allow(cape & (z < R["skirtTop"]), "pelvis", "skirt_back", "skirt_back_l", "skirt_back_r")
        allow(cape & (z > R["cape"]["top"] - 0.2), "clavicle_l", "clavicle_r", "neck")
        if "cape" in column:
            allow(torso & (y > R["cape"]["minY"] - 0.05) & (z < R["cape"]["top"]), "cape")
    for side in ("l", "r"):
        arm, leg = part == f"arm_{side}", part == f"leg_{side}"
        knee_z = defs[f"shin_{side}"][0][2]
        allow(arm, f"upperarm_{side}", f"forearm_{side}", f"hand_{side}", f"fingers_{side}")
        shoulder_p, elbow_p = np.array(defs[f"upperarm_{side}"][0]), np.array(defs[f"upperarm_{side}"][1])
        upper_len = np.linalg.norm(elbow_p - shoulder_p)
        along_arm = (points - shoulder_p) @ ((elbow_p - shoulder_p) / upper_len)
        band = W["elbowBlend"]["band"]
        for bone in (f"forearm_{side}", f"hand_{side}", f"fingers_{side}"):
            allowed[:, column[bone]] &= along_arm > upper_len - band
        allowed[:, column[f"upperarm_{side}"]] &= along_arm < upper_len + band
        allow(arm & near[f"shoulder_{side}"], "chest", f"clavicle_{side}")
        allow(arm & ambiguous & (second == "torso"), "chest", "spine", f"clavicle_{side}")
        allow(torso & near[f"shoulder_{side}"], f"upperarm_{side}")
        allow(torso & ambiguous & (second == f"arm_{side}"), f"upperarm_{side}")
        allow((arm | torso) & near[f"shoulder_{side}"], f"shoulderhelper_{side}")
        knee_point = np.array(defs[f"shin_{side}"][0])
        allow(leg & (np.linalg.norm(points - knee_point, axis=1) < W["kneeBlend"]["band"]), f"kneehelper_{side}")
        allow(leg, f"thigh_{side}")
        allow(leg & (z < knee_z + W["kneeBlend"]["ramp"] - W["kneeBlend"].get("shift", 0.0)),
              f"shin_{side}", f"foot_{side}", f"toe_{side}")
        if "ankleBand" in W:
            # Tall boots: the foot may not pull boot-shaft surface far above the ankle.
            ankle_z = defs[f"foot_{side}"][0][2]
            for bone in (f"foot_{side}", f"toe_{side}"):
                allowed[:, column[bone]] &= z < ankle_z + W["ankleBand"]
        allow(leg & near[f"hip_{side}"], "pelvis")
        if f"hiphelper_{side}" in column:
            hip_point = np.array(defs[f"thigh_{side}"][0])
            H = W["hipBlend"]
            sign = 1 if side == "l" else -1
            allow((leg | torso) & (np.linalg.norm(points - hip_point, axis=1) < H["reach"]), f"hiphelper_{side}")
            allow(skirt & (sign * x > -(W["skirtBlend"]["sideRamp"] + 0.02)), f"hiphelper_{side}")
        allow((torso | skirt) & near[f"hip_{side}"], f"thigh_{side}")
    if midline is not None:
        for side, sign in (("l", 1), ("r", -1)):
            for bone in (f"clavicle_{side}", f"shoulderhelper_{side}", f"upperarm_{side}"):
                if bone in column:
                    allowed[:, column[bone]] &= sign * x > -midline
    if has_skirt and W.get("hemBand"):
        # Trouser tops fused to a tunic hem may blend with the hem panels, so the fold spreads over several edges.
        # Only leg surface within a few edge rings of the tunic qualifies: the inner thighs between the legs stay
        # pure leg even at hem height.
        hem = region(R, "skirtHemHeight")
        edges = k.adjacency(body)
        near_tunic = part == "skirt"
        for _ in range(W.get("hemRings", 3)):
            grow = near_tunic.copy()
            grow[edges[:, 0]] |= near_tunic[edges[:, 1]]
            grow[edges[:, 1]] |= near_tunic[edges[:, 0]]
            near_tunic = grow
        for side in ("l", "r"):
            allow((part == f"leg_{side}") & main & near_tunic & (z > hem - W["hemBand"]), "pelvis", *SKIRT_BONES)
    if has_skirt and W.get("panelSides"):
        # Each hem panel stays on its own face (front/back) and, for per-leg panels, its own side.
        margin = W.get("panelMargin", 0.05)
        for bone in SKIRT_BONES:
            if bone not in column:
                continue
            keep = np.ones(len(points), dtype=bool)
            keep &= (y < margin) if "front" in bone else (y > -margin)
            if bone.endswith("_l"):
                keep &= x > -margin
            elif bone.endswith("_r"):
                keep &= x < margin
            allowed[:, column[bone]] &= keep
    empty = ~allowed.any(axis=1)
    if empty.any():
        # A vertex whose part lost every joint (for example a hand vertex nearer the elbow than the band allows)
        # falls back to its part's own chain; a cape without cape bones falls back to the chest.
        for index in np.flatnonzero(empty):
            owner = part[index]
            for name in names:
                if PART_OF[name] == owner or (owner == "cape" and name == "chest"):
                    allowed[index, column[name]] = True
    locked = {int(i): ("foot_l" if x[i] > 0 else "foot_r") for i in np.flatnonzero(z < R["soleHeight"])}
    counts = {name: int((part == name).sum()) for name in sorted(set(part))}
    return allowed, locked, {"lockedSoleVertices": len(locked), "partVertices": counts, "bands": B,
                             "emptyFallbackVertices": int(empty.sum())}, part


def heat_blends(recipe, defs, part):
    """Joint ramps for k2cook.bind_heat: shoulder (with helper), elbow, knee (with helper) and the skirt."""
    W = recipe["weights"]
    blends = []
    for side in ("l", "r"):
        shoulder, elbow = Vector(defs[f"upperarm_{side}"][0]), Vector(defs[f"upperarm_{side}"][1])
        blends.append({"joint": list(shoulder), "axis": list(elbow - shoulder), "band": W["shoulderBlend"]["band"],
                       "ramp": W["shoulderBlend"]["ramp"], "distal": [f"upperarm_{side}"],
                       "proximal": [f"clavicle_{side}", "chest", "spine", "pelvis", "neck", "clavicle_l" if side == "r" else "clavicle_r"],
                       "middle": [f"shoulderhelper_{side}"]})
        wrist = Vector(defs[f"forearm_{side}"][1])
        blends.append({"joint": list(elbow), "axis": list(wrist - elbow), "band": W["elbowBlend"]["band"],
                       "ramp": W["elbowBlend"]["ramp"], "distal": [f"forearm_{side}"], "proximal": [f"upperarm_{side}"]})
        if "wristBlend" in W:
            knuckle = Vector(defs[f"hand_{side}"][1])
            blends.append({"joint": list(wrist), "axis": list(knuckle - wrist), "band": W["wristBlend"]["band"],
                           "ramp": W["wristBlend"]["ramp"], "distal": [f"hand_{side}", f"fingers_{side}"], "proximal": [f"forearm_{side}"]})
        knee, ankle_point = Vector(defs[f"shin_{side}"][0]), Vector(defs[f"shin_{side}"][1])
        blends.append({"joint": list(knee), "axis": list(ankle_point - knee), "band": W["kneeBlend"]["band"],
                       "ramp": W["kneeBlend"]["ramp"], "shift": W["kneeBlend"].get("shift", 0.0),
                       "distal": [f"shin_{side}"], "proximal": [f"thigh_{side}"], "middle": [f"kneehelper_{side}"]})
        if f"hiphelper_{side}" in defs:
            hip = Vector(defs[f"thigh_{side}"][0])
            H = W["hipBlend"]
            blends.append({"joint": list(hip), "axis": list(knee - hip), "band": H["band"], "ramp": H["ramp"], "shift": H.get("shift", 0.0),
                           "distal": [f"thigh_{side}"], "proximal": ["pelvis", *skirt_bones(defs), "spine"],
                           "middle": [f"hiphelper_{side}"], "mask": part != "skirt"})
    if skirt_bones(defs):
        S = W["skirtBlend"]
        blends.append({"kind": "skirt", "mask": part == "skirt", "zTop": S["zTop"], "zHem": S["zHem"], "sideRamp": S["sideRamp"],
                       "maxShare": S["maxShare"], "distal": ["thigh_l", "thigh_r"],
                       "proximal": ["pelvis", *skirt_bones(defs), "spine", "chest"],
                       "middle": ["hiphelper_l", "hiphelper_r"] if "hiphelper_l" in defs else []})
    for blend in blends:
        # Limb surface beyond the proximal part's reach ramps from the helper to the distal joint (hero rigs).
        blend["helperBeyondProximal"] = True
    return blends


def frame_from(along, face):
    """Orthonormal 3x3 whose columns are (x, y=along, z=face made perpendicular)."""
    y = Vector(along).normalized()
    z = Vector(face)
    z = (z - y * z.dot(y)).normalized()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed()


class Poser:
    """Armature-space motion matrices for a humanoid skeleton. Bone motions are rigid transforms applied to the
    rest pose, composed parent to child; the clip baker converts them to local keys."""

    def __init__(self, defs, recipe):
        self.defs = defs
        self.recipe = recipe
        self.H = {name: Vector(head) for name, (head, _, _, _) in defs.items()}
        self.T = {name: Vector(tail) for name, (_, tail, _, _) in defs.items()}
        self.length = {name: (self.T[name] - self.H[name]).length for name in defs}
        self.grip_rest = {}
        for side in ("l", "r"):
            sign = 1 if side == "l" else -1
            socket = next((spec["name"] for spec in recipe.get("sockets", []) if spec["kind"] == "grip" and spec.get("side", "r") == side), None)
            point = self.H[socket] if socket else self.H[f"hand_{side}"].lerp(self.T[f"hand_{side}"], 0.6)
            self.grip_rest[side] = {"point": point, "frame": frame_from(GRIP_ALONG, Vector((sign, 0, 0)))}
        self.solver = {}
        self.reach_short = {}

    def set_grip_frame(self, side, along, face):
        """Rest orientation of a hand's grip, taken from the item it holds (alongWorld/faceWorld at rest)."""
        self.grip_rest[side]["frame"] = frame_from(along, face)

    def body(self, offset=(0, 0, 0), pelvis=(0, 0, 0), spine=(0, 0, 0), chest=(0, 0, 0), head=(0, 0, 0), neck=(0, 0, 0)):
        H = self.H
        motion = {"root": Matrix.Identity(4)}
        motion["pelvis"] = Matrix.Translation(Vector(offset)) @ k.rotate_about(H["pelvis"], k.rot(*pelvis))
        motion["spine"] = motion["pelvis"] @ k.rotate_about(H["spine"], k.rot(*spine))
        motion["chest"] = motion["spine"] @ k.rotate_about(H["chest"], k.rot(*chest))
        motion["neck"] = motion["chest"] @ k.rotate_about(H["neck"], k.rot(*neck))
        motion["head"] = motion["neck"] @ k.rotate_about(H["head"], k.rot(*head))
        return motion

    def _elbow(self, side, shoulder, target, pole, hand_direction=None, preference=None):
        upper, fore = self.length[f"upperarm_{side}"], self.length[f"forearm_{side}"]
        if hand_direction is None:
            return k.solve_two_bone(shoulder, target, upper, fore, pole)
        # Best elbow on the IK circle: forearm continues into the posed hand (a neutral wrist), biased toward the
        # preferred pole so the elbow never folds into the torso.
        delta = target - shoulder
        distance = min(max(delta.length, abs(upper - fore) + 1e-4), upper + fore - 1e-4)
        direction = delta.normalized()
        along = (upper * upper - fore * fore + distance * distance) / (2 * distance)
        centre = shoulder + direction * along
        radius = math.sqrt(max(0.0, upper * upper - along * along))
        u = (preference - direction * preference.dot(direction))
        u = u.normalized() if u.length > 1e-6 else direction.orthogonal().normalized()
        v = direction.cross(u)
        best, best_score = None, -1e9
        weight = self.recipe["clips"].get("poleBias", 0.45)
        for step in range(144):
            angle = 2 * math.pi * step / 144
            bend = u * math.cos(angle) + v * math.sin(angle)
            elbow = centre + bend * radius
            fore_dir = (target - elbow).normalized()
            score = fore_dir.dot(hand_direction) + weight * math.cos(angle)
            if score > best_score:
                best, best_score = elbow, score
        return best

    def reset(self):
        """Forget per-clip solver continuity (call at the start of each clip)."""
        self.solver = {}

    def _grip_solve(self, side, shoulder, at, along, face_hint, preference, spec):
        """Hand rotation and elbow for a held item whose axis must point along `along` from the grip point `at`.
        The roll about the item axis is free (the face is only a preference): each candidate roll gives a wrist
        position and hand direction, each candidate elbow on the IK circle a forearm; the pair with the straightest
        wrist wins, biased toward the preferred elbow side, the face hint and the previous frame's roll."""
        H, T = self.H, self.T
        rest = self.grip_rest[side]
        upper, fore = self.length[f"upperarm_{side}"], self.length[f"forearm_{side}"]
        offset = rest["point"] - H[f"hand_{side}"]
        hand_rest = (T[f"hand_{side}"] - H[f"hand_{side}"]).normalized()
        axis = along.normalized()
        u0 = face_hint - axis * face_hint.dot(axis)
        u0 = u0.normalized() if u0.length > 1e-6 else axis.orthogonal().normalized()
        v0 = axis.cross(u0)
        freedom = math.radians(spec.get("rollFreedom", 180.0))
        face_weight = spec.get("faceWeight", 0.35)
        pole_weight = self.recipe["clips"].get("poleBias", 0.45)
        previous = self.solver.get(side)

        def evaluate(theta, phi_steps, phi_range=None):
            face = u0 * math.cos(theta) + v0 * math.sin(theta)
            rotation = frame_from(axis, face) @ rest["frame"].transposed()
            wrist = at - rotation @ offset
            hand_dir = rotation @ hand_rest
            delta = wrist - shoulder
            distance = min(max(delta.length, abs(upper - fore) + 1e-4), upper + fore - 1e-4)
            direction = delta.normalized()
            reach = (upper * upper - fore * fore + distance * distance) / (2 * distance)
            centre = shoulder + direction * reach
            radius = math.sqrt(max(0.0, upper * upper - reach * reach))
            u = preference - direction * preference.dot(direction)
            u = u.normalized() if u.length > 1e-6 else direction.orthogonal().normalized()
            v = direction.cross(u)
            best = (-1e9, None, None)
            angles = ([phi_range[0] + (phi_range[1] - phi_range[0]) * i / max(1, phi_steps - 1) for i in range(phi_steps)]
                      if phi_range else [2 * math.pi * i / phi_steps for i in range(phi_steps)])
            for phi in angles:
                elbow = centre + (u * math.cos(phi) + v * math.sin(phi)) * radius
                score = (wrist - elbow).normalized().dot(hand_dir) + pole_weight * math.cos(phi) + face_weight * math.cos(theta)
                if previous is not None:
                    score -= 0.6 * (theta - previous) ** 2
                if score > best[0]:
                    best = (score, elbow, phi)
            return best[0], best[1], best[2], rotation, wrist

        thetas = [-freedom + 2 * freedom * i / 24 for i in range(25)] if freedom < math.pi else [2 * math.pi * i / 24 - math.pi for i in range(24)]
        if previous is not None:
            thetas.append(previous)
        results = [(evaluate(theta, 36), theta) for theta in thetas]
        (score, elbow, phi, rotation, wrist), theta = max(results, key=lambda item: item[0][0])
        step = math.radians(8)
        for _ in range(2):
            candidates = [(evaluate(t, 9, (phi - 0.2, phi + 0.2)), t) for t in (theta - step, theta, theta + step)
                          if -freedom <= t <= freedom or freedom >= math.pi]
            (score, elbow, phi, rotation, wrist), theta = max(candidates, key=lambda item: item[0][0])
            step /= 2
        self.solver[side] = theta
        return rotation, elbow, wrist

    def hinge(self, parent_motion, bone, joint, target):
        """Motion of `bone` that carries its parent's motion plus the smallest swing that aims it at `target`: no
        twist relative to the parent, so joint blends interpolate a bend instead of wringing the skin, and a turned
        torso or pelvis turns the limb's roll with it. With `hingeJoints` off, the bone is aimed independently
        (minimal rotation from rest, as the shipped soldier cook does)."""
        H, T = self.H, self.T
        if not self.recipe["clips"].get("hingeJoints", True):
            return k.aim(H[bone], T[bone], joint, target)
        carried = parent_motion.to_3x3() @ (T[bone] - H[bone]).normalized()
        wanted = (target - joint).normalized()
        swing = carried.rotation_difference(wanted).to_matrix()
        return k.rotate_about(joint, swing) @ parent_motion

    def arm(self, motion, side, spec):
        """Two-bone arm IK. Either `wrist` (rest chest space) with a `pole`, forearm `twist`, hand euler `hand` and
        finger `curl` (degrees); or a grip: `at` (grip point) with `grip` {along, face} directions, both in rest chest
        space unless `world` is set. A grip points the held item exactly along `along`; its roll is solved for the
        most natural wrist unless `rollFreedom` is 0, in which case `face` is exact too."""
        H, T = self.H, self.T
        chest = motion["chest"]
        motion[f"clavicle_{side}"] = chest @ k.rotate_about(H[f"clavicle_{side}"], k.rot(*spec.get("clavicle", (0, 0, 0))))
        shoulder = motion[f"clavicle_{side}"] @ H[f"upperarm_{side}"]
        grip = spec.get("grip")
        hand_matrix = None
        if grip is not None:
            basis = Matrix.Identity(3) if spec.get("world") else chest.to_3x3()
            along = basis @ Vector(grip["along"])
            face = basis @ Vector(grip["face"])
            rest = self.grip_rest[side]
            at = Vector(spec["at"]) if spec.get("world") else chest @ Vector(spec["at"])
            sign = 1 if side == "l" else -1
            preference = (chest.to_3x3() @ Vector(spec.get("pole", (sign, 0.4, -0.6)))).normalized()
            if spec.get("rollFreedom", 180.0) > 0:
                rotation, elbow, target = self._grip_solve(side, shoulder, at, along, face, preference, spec)
            else:
                rotation = frame_from(along, face) @ rest["frame"].transposed()
                target = at - rotation @ (rest["point"] - H[f"hand_{side}"])
                hand_direction = (rotation @ (T[f"hand_{side}"] - H[f"hand_{side}"])).normalized()
                elbow = self._elbow(side, shoulder, target, None, hand_direction, preference)
            hand_matrix = Matrix.Translation(at) @ rotation.to_4x4() @ Matrix.Translation(-rest["point"])
        else:
            target = chest @ Vector(spec["wrist"])
            pole = (chest.to_3x3() @ Vector(spec["pole"])).normalized()
            elbow = self._elbow(side, shoulder, target, pole)
        fore_length = self.length[f"forearm_{side}"]
        reach = (target - shoulder).length - (self.length[f"upperarm_{side}"] + fore_length)
        self.reach_short[side] = max(0.0, reach)
        wrist = elbow + (target - elbow).normalized() * fore_length
        motion[f"upperarm_{side}"] = self.hinge(motion[f"clavicle_{side}"], f"upperarm_{side}", shoulder, elbow)
        if f"shoulderhelper_{side}" in self.defs:
            half = motion[f"clavicle_{side}"].to_quaternion().slerp(motion[f"upperarm_{side}"].to_quaternion(), 0.5)
            motion[f"shoulderhelper_{side}"] = (Matrix.Translation(shoulder) @ half.to_matrix().to_4x4()
                                                @ Matrix.Translation(-H[f"upperarm_{side}"]))
        fore = self.hinge(motion[f"upperarm_{side}"], f"forearm_{side}", elbow, wrist)
        if hand_matrix is not None:
            # Twist the forearm about its axis toward the hand's roll so the wrist bends instead of wringing.
            fore_axis = (wrist - elbow).normalized()
            rest_side = fore.to_3x3() @ Vector((1 if side == "l" else -1, 0, 0))
            wanted = hand_matrix.to_3x3() @ Vector((1 if side == "l" else -1, 0, 0))
            a = (rest_side - fore_axis * rest_side.dot(fore_axis))
            b = (wanted - fore_axis * wanted.dot(fore_axis))
            if a.length > 1e-6 and b.length > 1e-6:
                a.normalize()
                b.normalize()
                angle = math.atan2(a.cross(b).dot(fore_axis), a.dot(b)) * spec.get("twistShare", 0.5)
                fore = k.rotate_about(elbow, Matrix.Rotation(angle, 3, fore_axis)) @ fore
            # The held item defines the hand; the wrist absorbs any residual bend.
            hand_matrix = Matrix.Translation(wrist - hand_matrix @ H[f"hand_{side}"]) @ hand_matrix
        else:
            twist = spec.get("twist", 0.0)
            if twist:
                fore = k.rotate_about(elbow, Matrix.Rotation(math.radians(twist), 3, (wrist - elbow).normalized())) @ fore
            hand_matrix = fore @ k.rotate_about(H[f"hand_{side}"], k.rot(*spec.get("hand", (0, 0, 0))))
        motion[f"forearm_{side}"] = fore
        motion[f"hand_{side}"] = hand_matrix
        direction = (T[f"hand_{side}"] - H[f"hand_{side}"]).normalized()
        axis = direction.cross(Vector((0, -1, 0)))
        axis = axis.normalized() if axis.length > 1e-6 else Vector((1, 0, 0))
        motion[f"fingers_{side}"] = hand_matrix @ k.rotate_about(H[f"fingers_{side}"], Matrix.Rotation(math.radians(spec.get("curl", 60)), 3, axis))
        return wrist

    def wrist_bend(self, motion, side):
        """Angle in degrees between the posed forearm and the posed hand (0 = neutral wrist)."""
        fore = (motion[f"forearm_{side}"].to_3x3() @ (self.T[f"forearm_{side}"] - self.H[f"forearm_{side}"])).normalized()
        hand = (motion[f"hand_{side}"].to_3x3() @ (self.T[f"hand_{side}"] - self.H[f"hand_{side}"])).normalized()
        return math.degrees(math.acos(max(-1.0, min(1.0, fore.dot(hand)))))

    def leg(self, motion, side, ankle, pitch=0.0, yaw=0.0, pole=(0, -1, 0.1)):
        """Two-bone leg IK to an ankle target; the foot pitches about the ankle and yaws with the stride direction.
        The knee pole follows the pelvis, so turned hips turn the knees. Returns the leg extension ratio."""
        H, length = self.H, self.length
        hip = motion["pelvis"] @ H[f"thigh_{side}"]
        pole_vector = motion["pelvis"].to_3x3() @ Vector(pole)
        knee = k.solve_two_bone(hip, ankle, length[f"thigh_{side}"], length[f"shin_{side}"], pole_vector)
        motion[f"thigh_{side}"] = self.hinge(motion["pelvis"], f"thigh_{side}", hip, knee)
        motion[f"shin_{side}"] = self.hinge(motion[f"thigh_{side}"], f"shin_{side}", knee, ankle)
        if f"hiphelper_{side}" in self.defs:
            half = motion["pelvis"].to_quaternion().slerp(motion[f"thigh_{side}"].to_quaternion(), 0.5)
            motion[f"hiphelper_{side}"] = Matrix.Translation(hip) @ half.to_matrix().to_4x4() @ Matrix.Translation(-H[f"thigh_{side}"])
        if f"kneehelper_{side}" in self.defs:
            half = motion[f"thigh_{side}"].to_quaternion().slerp(motion[f"shin_{side}"].to_quaternion(), 0.5)
            motion[f"kneehelper_{side}"] = Matrix.Translation(knee) @ half.to_matrix().to_4x4() @ Matrix.Translation(-H[f"shin_{side}"])
        motion[f"foot_{side}"] = Matrix.Translation(ankle - H[f"foot_{side}"]) @ k.rotate_about(H[f"foot_{side}"], k.rot(pitch, 0, yaw))
        motion[f"toe_{side}"] = motion[f"foot_{side}"]
        return (hip - ankle).length / (length[f"thigh_{side}"] + length[f"shin_{side}"])

    def skirt(self, motion, front, back=None, side=None):
        """Pitch the hem panels (degrees about X). With per-leg panels, `side` selects one leg's pair."""
        back = front if back is None else back
        pairs = [("skirt_front", "skirt_back")] if "skirt_front" in self.defs else \
            [(f"skirt_front_{s}", f"skirt_back_{s}") for s in ((side,) if side else ("l", "r")) if f"skirt_front_{s}" in self.defs]
        for f_name, b_name in pairs:
            motion[f_name] = motion["pelvis"] @ k.rotate_about(self.H[f_name], k.rot(front, 0, 0))
            motion[b_name] = motion["pelvis"] @ k.rotate_about(self.H[b_name], k.rot(back, 0, 0))

    def thigh_pitch(self, motion, side):
        """Thigh swing in the pelvis' sagittal plane, degrees: positive = knee forward of the hip."""
        rest = (self.T[f"thigh_{side}"] - self.H[f"thigh_{side}"]).normalized()
        posed = motion[f"thigh_{side}"].to_3x3() @ rest
        local = motion["pelvis"].to_3x3().inverted() @ posed
        return math.degrees(math.atan2(-local.y, -local.z))

    def skirt_follow(self, motion, gain=(0.8, 0.8), sway=0.0):
        """Hem panels follow the legs like cloth pushed by the knees. Central panels: the front swings forward with
        whichever thigh is ahead, the back backward with whichever is behind. Per-leg panels follow their own thigh
        (and a share of the other leg's through the cloth)."""
        if not skirt_bones(self.defs):
            return
        rest = {side: math.degrees(math.atan2(-(self.T[f"thigh_{side}"] - self.H[f"thigh_{side}"]).y,
                                              -(self.T[f"thigh_{side}"] - self.H[f"thigh_{side}"]).z)) for side in ("l", "r")}
        pitch = {side: self.thigh_pitch(motion, side) - rest[side] for side in ("l", "r")}
        # A downward bone's hem moves forward (-Y) under a negative X rotation.
        if "skirt_front" in self.defs:
            ahead, behind = max(0.0, *pitch.values()), min(0.0, *pitch.values())
            self.skirt(motion, -gain[0] * ahead + sway, -gain[1] * behind + sway)
            return
        share = self.recipe["weights"].get("skirtCrossShare", 0.25)
        for side, other in (("l", "r"), ("r", "l")):
            own = pitch[side] * (1 - share) + pitch[other] * share
            self.skirt(motion, -gain[0] * max(0.0, own) + sway, -gain[1] * min(0.0, own) + sway, side)

    def cape(self, motion, flare=0.0, trail=0.0, sway=0.0):
        """Cape segments hang from the chest: `flare` lifts the whole cape away from the back (degrees, positive =
        hem backward), `trail` bends the lower segment further, `sway` rolls it sideways."""
        if "cape" not in self.defs:
            return
        # A downward bone's tip moves backward (+Y) under a positive X rotation.
        motion["cape"] = motion["chest"] @ k.rotate_about(self.H["cape"], k.rot(flare, sway, 0))
        motion["cape_lower"] = motion["cape"] @ k.rotate_about(self.H["cape_lower"], k.rot(trail, sway * 0.5, 0))


def clean_motion(motion):
    return {name: value for name, value in motion.items() if not name.startswith("_")}


def mix(a, b, t):
    if isinstance(a, dict):
        return {key: mix(a.get(key, b.get(key)), b.get(key, a.get(key)), t) for key in set(a) | set(b)}
    if isinstance(a, bool) or a is None:
        return a if t < 0.5 else b
    if isinstance(a, (int, float)):
        return a + (b - a) * t
    if isinstance(a, str):
        return a if t < 0.5 else b
    return tuple(p + (q - p) * t for p, q in zip(a, b))


def keyed(keys, t, ease=True):
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t <= t1:
            u = (t - t0) / max(t1 - t0, 1e-6)
            return mix(a, b, k.smoothstep(0, 1, u) if ease else u)
    return keys[-1][1]


def hermite(p0, v0, p1, v1, u):
    u2, u3 = u * u, u * u * u
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * v1


def offset_spec(spec, delta=(0, 0, 0), key=None):
    moved = dict(spec)
    key = key or ("at" if "at" in spec else "wrist")
    moved[key] = tuple(a + b for a, b in zip(spec[key], delta))
    return moved


def lowest_points(rig, body, items, action, frames):
    """Lowest skinned-body and item height (cooked metres) at every frame of a baked action."""
    slot = next((track.strips[0].action_slot for track in rig.animation_data.nla_tracks if track.strips and track.strips[0].action == action), None)
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    rig.animation_data.action = action
    if slot is not None:
        rig.animation_data.action_slot = slot
    scene = bpy.context.scene
    result = []
    for frame in range(frames + 1):
        scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = body.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        points = np.empty(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get("co", points)
        world = np.array(evaluated.matrix_world)
        lowest = float((points.reshape(-1, 3) @ world[:3, :3].T + world[:3, 3])[:, 2].min())
        evaluated.to_mesh_clear()
        for item in items:
            evaluated_item = item.evaluated_get(depsgraph)
            item_mesh = evaluated_item.to_mesh()
            item_points = np.empty(len(item_mesh.vertices) * 3)
            item_mesh.vertices.foreach_get("co", item_points)
            item_world = np.array(evaluated_item.matrix_world)
            lowest = min(lowest, float((item_points.reshape(-1, 3) @ item_world[:3, :3].T + item_world[:3, 3])[:, 2].min()))
            evaluated_item.to_mesh_clear()
        result.append(lowest)
    rig.animation_data.action = None
    scene.frame_set(0)
    return result


# ---------------------------------------------------------------- items

def paint(obj, rgb, metal, rough, dye=0.0):
    mesh = obj.data
    colour = mesh.color_attributes.get("paint") or mesh.color_attributes.new("paint", "FLOAT_COLOR", "CORNER")
    values = {name: (mesh.attributes.get(name) or mesh.attributes.new(name, "FLOAT", "CORNER")) for name in ("metal", "rough", "dye")}
    for loop in mesh.loops:
        colour.data[loop.index].color = (*rgb, 1)
        values["metal"].data[loop.index].value = metal
        values["rough"].data[loop.index].value = rough
        values["dye"].data[loop.index].value = dye


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for piece in parts:
        piece.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def mesh_object(name, vertices, faces):
    data = bpy.data.meshes.new(name)
    data.from_pydata([tuple(v) for v in vertices], [], [tuple(f) for f in faces])
    data.validate()
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def sweep(name, centres, frames, section, cap=True):
    """Tube through `centres` with per-ring (x axis, y axis) `frames` and a closed 2D `section` scaled per ring:
    section(i) -> [(u, v), ...] in ring coordinates."""
    vertices, faces = [], []
    rings = []
    for index, centre in enumerate(centres):
        x_axis, y_axis = frames[index]
        ring = []
        for u, v in section(index):
            ring.append(len(vertices))
            vertices.append(Vector(centre) + x_axis * u + y_axis * v)
        rings.append(ring)
    count = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for j in range(count):
            faces.append((a[j], a[(j + 1) % count], b[(j + 1) % count], b[j]))
    if cap:
        faces.append(tuple(reversed(rings[0])))
        faces.append(tuple(rings[-1]))
    obj = mesh_object(name, vertices, faces)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def ellipse(rx, ry, sides):
    return [(rx * math.cos(2 * math.pi * j / sides), ry * math.sin(2 * math.pi * j / sides)) for j in range(sides)]


def make_sword(S):
    """Grip centred at the origin, blade along +Y, cross-guard along X, flat of the blade facing Z."""
    parts = []
    bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=S["bladeWidth"] / 2, radius2=0.003, depth=S["bladeLength"],
                                    location=(0, S["gripLength"] / 2 + 0.03 + S["bladeLength"] / 2, 0),
                                    rotation=(math.radians(-90), 0, 0))
    blade = bpy.context.object
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for vertex in blade.data.vertices:
        vertex.co.z *= S["bladeThickness"] / S["bladeWidth"]
    paint(blade, tuple(S.get("bladeColor", (0.63, 0.65, 0.67))), 1.0, S.get("bladeRoughness", 0.3))
    parts.append(blade)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, S["gripLength"] / 2 + 0.015, 0))
    guard = bpy.context.object
    guard.scale = (S["guardWidth"], 0.03, 0.035)
    paint(guard, tuple(S.get("guardColor", (0.2, 0.2, 0.21))), 1.0, 0.45)
    parts.append(guard)
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=S["gripRadius"], depth=S["gripLength"], rotation=(math.radians(90), 0, 0))
    grip = bpy.context.object
    paint(grip, (0.2, 0.12, 0.07), 0.0, 0.8)
    parts.append(grip)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=S["pommel"], location=(0, -S["gripLength"] / 2 - S["pommel"] * 0.7, 0))
    pommel = bpy.context.object
    paint(pommel, tuple(S.get("pommelColor", (0.56, 0.43, 0.2))), 1.0, 0.4)
    parts.append(pommel)
    return join(parts, "item-sword")


def make_shield(D):
    """Heater shield: long axis +Y, painted face toward +Z, strap at the origin."""
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=12, y_subdivisions=16, size=1)
    face = bpy.context.object
    for vertex in face.data.vertices:
        u, v = vertex.co.x + 0.5, vertex.co.y + 0.5
        taper = 1.0 if v > 0.42 else math.sqrt(max(0.0, v / 0.42)) * 0.94 + 0.06
        vertex.co.x = (u - 0.5) * D["width"] * taper
        vertex.co.y = (v - 0.62) * D["height"]
        vertex.co.z = D["curve"] * (1 - (2 * vertex.co.x / D["width"]) ** 2)
    solid = face.modifiers.new("thickness", "SOLIDIFY")
    solid.thickness = D["thickness"]
    solid.offset = 0
    bpy.ops.object.modifier_apply(modifier=solid.name)
    paint(face, tuple(D.get("faceColor", (0.84, 0.81, 0.74))), 0.0, 0.72, dye=D.get("faceDye", 1.0))
    mesh = face.data
    rim_colour = tuple(D.get("rimColor", (0.22, 0.22, 0.23)))
    # The strap side faces the camera behind the hero most of the time; recipes match it to the body's leather.
    back_colour = tuple(D.get("backColor", (0.33, 0.23, 0.13)))
    for polygon in mesh.polygons:
        back, rim = polygon.normal.z < -0.5, abs(polygon.normal.z) <= 0.5
        for loop in polygon.loop_indices:
            if back:
                mesh.color_attributes["paint"].data[loop].color = (*back_colour, 1)
                mesh.attributes["dye"].data[loop].value = 0.0
                mesh.attributes["rough"].data[loop].value = 0.85
            elif rim:
                mesh.color_attributes["paint"].data[loop].color = (*rim_colour, 1)
                mesh.attributes["dye"].data[loop].value = 0.0
                mesh.attributes["metal"].data[loop].value = 1.0
                mesh.attributes["rough"].data[loop].value = 0.5
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=D["boss"], location=(0, D["height"] * 0.06, D["curve"] + D["thickness"] * 0.3))
    boss = bpy.context.object
    boss.scale = (1, 1, 0.45)
    paint(boss, tuple(D.get("bossColor", (0.5, 0.39, 0.19))), 1.0, 0.42)
    parts = [face, boss]
    if D.get("emblem"):
        # A flat three-point crown in brass, standing just proud of the painted face.
        E = D["emblem"]
        w, h, y0 = E["width"], E["height"], E["y"]
        outline = [(-w / 2, y0), (w / 2, y0), (w / 2, y0 + h * 0.55), (w * 0.3, y0 + h * 0.35), (w * 0.16, y0 + h),
                   (0, y0 + h * 0.45), (-w * 0.16, y0 + h), (-w * 0.3, y0 + h * 0.35), (-w / 2, y0 + h * 0.55)]
        top = D["curve"] + D["thickness"] / 2 + 0.004
        vertices = [(px, py, top - D["curve"] * (2 * px / D["width"]) ** 2) for px, py in outline]
        vertices += [(px, py, pz - 0.006) for px, py, pz in vertices]
        n = len(outline)
        faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
        faces += [(j, j + n, (j + 1) % n + n, (j + 1) % n) for j in range(n)]
        emblem = mesh_object("emblem", vertices, faces)
        bm = bmesh.new()
        bm.from_mesh(emblem.data)
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(emblem.data)
        bm.free()
        paint(emblem, tuple(E.get("color", (0.62, 0.48, 0.22))), 1.0, 0.38)
        parts.append(emblem)
    return join(parts, "item-shield")


def make_bow(B):
    """Strung longbow: grip at the origin, limbs along +Y/-Y, the back of the bow facing +Z (toward the target),
    string behind it at -Z. The limbs arc so the tips sit `sag` metres behind the grip."""
    length, sag, n = B["length"], B["sag"], B.get("segments", 14)
    parts = []
    for sign in (1, -1):
        centres, frames = [], []
        for index in range(n + 1):
            s = index / n
            y = sign * (0.06 + s * (length / 2 - 0.06))
            z = -sag * s ** 1.7
            slope = -sag * 1.7 * s ** 0.7 / (length / 2 - 0.06)
            tangent = Vector((0, sign, slope * sign)).normalized()
            x_axis = Vector((1, 0, 0))
            y_axis = tangent.cross(x_axis).normalized()
            centres.append((0, y, z))
            frames.append((x_axis, y_axis))
        width = lambda i: B["limbWidth"] * (1 - 0.55 * i / n)  # noqa: E731
        thick = lambda i: B["limbThickness"] * (1 - 0.5 * i / n)  # noqa: E731
        limb = sweep(f"limb{sign}", centres, frames, lambda i: ellipse(width(i) / 2, thick(i) / 2, 6))
        paint(limb, tuple(B.get("woodColor", (0.34, 0.22, 0.12))), 0.0, 0.55)
        parts.append(limb)
    grip = sweep("bowgrip", [(0, -0.1, 0), (0, 0.1, 0)], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                 lambda i: ellipse(B["gripWidth"] / 2, B["gripThickness"] / 2, 8))
    paint(grip, tuple(B.get("gripColor", (0.18, 0.11, 0.07))), 0.0, 0.8)
    parts.append(grip)
    top = Vector((0, length / 2, -sag))
    bottom = Vector((0, -length / 2, -sag))
    string = sweep("string", [bottom, top], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                   lambda i: ellipse(B["stringRadius"], B["stringRadius"], 3))
    paint(string, tuple(B.get("stringColor", (0.72, 0.68, 0.58))), 0.0, 0.7)
    parts.append(string)
    return join(parts, "item-bow")


def make_quiver(Q):
    """Leather quiver along +Y from its base at the origin, opening at +Y, with fletched arrows standing out."""
    tube = sweep("quiver", [(0, 0, 0), (0, Q["length"], 0)], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                 lambda i: ellipse(Q["radius"] * (0.85 if i == 0 else 1.0), Q["radius"] * 0.8 * (0.85 if i == 0 else 1.0), 10))
    paint(tube, tuple(Q.get("leatherColor", (0.3, 0.19, 0.11))), 0.0, 0.75)
    parts = [tube]
    band = sweep("band", [(0, Q["length"] - 0.05, 0), (0, Q["length"] - 0.01, 0)], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                 lambda i: ellipse(Q["radius"] * 1.06, Q["radius"] * 0.85, 10))
    paint(band, tuple(Q.get("bandColor", (0.5, 0.38, 0.18))), 1.0, 0.45)
    parts.append(band)
    rng = np.random.default_rng(7)
    for index in range(Q["arrows"]):
        angle = 2 * math.pi * index / Q["arrows"] + 0.3
        r = Q["radius"] * 0.5
        base = Vector((r * math.cos(angle), Q["length"] - 0.1, r * 0.8 * math.sin(angle)))
        tip = base + Vector((rng.uniform(-0.015, 0.015), Q["arrowOut"] + rng.uniform(-0.02, 0.02), rng.uniform(-0.015, 0.015)))
        shaft = sweep(f"shaft{index}", [base, tip], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2, lambda i: ellipse(0.006, 0.006, 3))
        paint(shaft, (0.55, 0.42, 0.26), 0.0, 0.6)
        parts.append(shaft)
        direction = (tip - base).normalized()
        for fin in range(3):
            spin = angle + fin * 2 * math.pi / 3
            out = Vector((math.cos(spin), 0, math.sin(spin)))
            lo, hi = tip - direction * 0.13, tip - direction * 0.02
            vertices = [lo, hi, hi + out * 0.022, lo + out * 0.012]
            vane = mesh_object(f"vane{index}-{fin}", vertices, [(0, 1, 2, 3)])
            solid = vane.modifiers.new("t", "SOLIDIFY")
            solid.thickness = 0.002
            bpy.context.view_layer.objects.active = vane
            k.select_only(vane)
            bpy.ops.object.modifier_apply(modifier=solid.name)
            paint(vane, tuple(Q.get("fletchColor", (0.78, 0.74, 0.66))), 0.0, 0.85)
            parts.append(vane)
    return join(parts, "item-quiver")


def make_hammer(M):
    """Two-handed war hammer: the leading (right-hand) grip at the origin, haft along +Y toward the head, striking
    faces along +/-X, spike-free iron head banded in brass, iron butt cap. The trailing hand grips at -leftGrip."""
    below, above = M["belowGrip"], M["aboveGrip"]
    haft = sweep("haft", [(0, -below, 0), (0, above, 0)], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                 lambda i: ellipse(M["haftRadius"], M["haftRadius"], 8))
    paint(haft, tuple(M.get("haftColor", (0.2, 0.13, 0.08))), 0.0, 0.7)
    parts = [haft]
    for centre, span in ((0.0, 0.16), (-M["leftGrip"], 0.16)):
        wrap = sweep("wrap", [(0, centre - span / 2, 0), (0, centre + span / 2, 0)], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                     lambda i: ellipse(M["haftRadius"] * 1.18, M["haftRadius"] * 1.18, 8))
        paint(wrap, (0.14, 0.09, 0.06), 0.0, 0.85)
        parts.append(wrap)
    head_y = above - M["headDepth"] / 2
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, head_y, 0))
    head = bpy.context.object
    head.scale = (M["headLength"], M["headDepth"], M["headHeight"])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = head.modifiers.new("bevel", "BEVEL")
    bevel.width = M.get("bevel", 0.02)
    bevel.segments = 1
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    paint(head, tuple(M.get("headColor", (0.14, 0.14, 0.15))), 1.0, 0.5)
    parts.append(head)
    for sign in (1, -1):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(sign * M["headLength"] * 0.28, head_y, 0))
        band = bpy.context.object
        band.scale = (0.03, M["headDepth"] * 1.08, M["headHeight"] * 1.08)
        paint(band, tuple(M.get("bandColor", (0.52, 0.4, 0.2))), 1.0, 0.42)
        parts.append(band)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, above + 0.03, 0))
    cap = bpy.context.object
    cap.scale = (M["headLength"] * 0.18, 0.06, M["headHeight"] * 0.6)
    paint(cap, tuple(M.get("headColor", (0.14, 0.14, 0.15))), 1.0, 0.5)
    parts.append(cap)
    butt = sweep("butt", [(0, -below - 0.05, 0), (0, -below + 0.03, 0)], [(Vector((1, 0, 0)), Vector((0, 0, 1)))] * 2,
                 lambda i: ellipse(M["haftRadius"] * (1.5 if i == 0 else 1.25), M["haftRadius"] * (1.5 if i == 0 else 1.25), 8))
    paint(butt, tuple(M.get("headColor", (0.14, 0.14, 0.15))), 1.0, 0.5)
    parts.append(butt)
    return join(parts, "item-hammer")


MAKERS = {"sword": make_sword, "shield": make_shield, "bow": make_bow, "quiver": make_quiver, "hammer": make_hammer}


def socket_frame(rig, socket, along_world, face_world):
    bone = rig.data.bones[socket]
    frame = frame_from(along_world, face_world).to_4x4()
    frame.translation = rig.matrix_world @ bone.head_local
    return frame


def bake_items(rig, recipe):
    """Blender-authored items share one small atlas (base colour + dye alpha, ORM); thin blades, bows and hafts
    reconstruct badly from one image. Returns the item objects parented to their sockets."""
    I = recipe["items"]
    specs = I["list"]
    made = []
    for index, spec in enumerate(specs):
        obj = MAKERS[spec["kind"]](spec)
        part = obj.data.attributes.new("part", "INT", "POINT")
        for vertex in obj.data.vertices:
            part.data[vertex.index].value = index
        made.append(obj)
    combined = join(made, "items-bake")
    m.ensure_uv(combined, 0.02, force=True)
    size = I["textureSize"]
    material = bpy.data.materials.new("items-bake")
    nodes = material.node_tree.nodes
    combined.data.materials.append(material)
    m.cycles_cpu(1)
    maps = {}
    for channel in ("paint", "metal", "rough", "dye"):
        target = m.image(f"items-{channel}", size, "sRGB" if channel == "paint" else "Non-Color")
        if channel == "paint":
            source = nodes.new("ShaderNodeVertexColor")
            source.layer_name = "paint"
            socket = source.outputs["Color"]
        else:
            source = nodes.new("ShaderNodeAttribute")
            source.attribute_name = channel
            socket = source.outputs["Fac"]
        m.bake_emission(combined, material, socket, target)
        maps[channel] = m.pixels(target)
        nodes.remove(source)
    base = np.dstack([maps["paint"][..., :3], maps["dye"][..., 0]])
    ones = np.ones_like(maps["metal"][..., 0])
    orm = np.dstack([ones, maps["rough"][..., 0], maps["metal"][..., 0], ones])
    base_image = m.image("items-base", size, "sRGB", alpha=True)
    m.set_pixels(base_image, base)
    orm_image = m.image("items-orm", size, "Non-Color")
    m.set_pixels(orm_image, orm)
    base_image.pack()
    orm_image.pack()
    final = m.gltf_material("items", base_image, None, orm_image, occlusion=False)
    k.select_only(combined)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.startswith("items-bake")]
    groups = {index: [] for index in range(len(specs))}
    for piece in pieces:
        groups[piece.data.attributes["part"].data[0].value].append(piece)
    items = []
    facts = []
    for index, spec in enumerate(specs):
        obj = join(groups[index], spec["name"])
        obj.data.materials.clear()
        obj.data.materials.append(final)
        mesh = obj.data
        if mesh.color_attributes.get("paint"):
            mesh.color_attributes.remove(mesh.color_attributes["paint"])
        for attribute in ("metal", "rough", "dye", "part"):
            if mesh.attributes.get(attribute):
                mesh.attributes.remove(mesh.attributes[attribute])
        for polygon in mesh.polygons:
            polygon.use_smooth = spec.get("smooth", True)
        mesh.update()
        frame = socket_frame(rig, spec["socket"], spec["alongWorld"], spec["faceWorld"])
        obj.parent = rig
        obj.parent_type = "BONE"
        obj.parent_bone = spec["socket"]
        bpy.context.view_layer.update()
        obj.matrix_world = frame
        items.append(obj)
        facts.append({"name": spec["name"], "kind": spec["kind"], "socket": spec["socket"], "triangles": k.triangle_count(obj)})
    bpy.data.materials.remove(material)
    return items, {"textureSize": size, "items": facts,
                   "authoring": "Blender-authored low-poly meshes with a baked paint/metal/roughness/dye atlas"}


# ---------------------------------------------------------------- body

def source_albedo(material):
    return next(n for n in material.node_tree.nodes if n.type == "TEX_IMAGE").outputs["Color"]


def keep_largest(body, min_fraction=0.01):
    """Delete detached specks (TRELLIS leaves small loose shells) but keep every substantial shell, such as legs
    that TRELLIS closed separately inside a long coat. Returns the kept and removed vertex counts."""
    points = k.coords(body)
    pieces = k.components(np.arange(len(points)), k.adjacency(body))
    pieces.sort(key=len, reverse=True)
    threshold = max(1, int(len(points) * min_fraction))
    kept = [len(p) for p in pieces if len(p) >= threshold]
    removed = [len(p) for p in pieces if len(p) < threshold]
    if removed:
        drop = set(int(i) for p in pieces if len(p) < threshold for i in p)
        bm = bmesh.new()
        bm.from_mesh(body.data)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[i] for i in sorted(drop)], context="VERTS")
        bm.to_mesh(body.data)
        bm.free()
        body.data.update()
    return {"componentsKept": kept, "componentsRemoved": len(removed), "verticesRemoved": removed, "minFraction": min_fraction}


def fill_small_holes(body, max_sides):
    """Close boundary loops of at most `max_sides` edges (TRELLIS leaves a few pinholes after welding)."""
    bm = bmesh.new()
    bm.from_mesh(body.data)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    before = len(boundary)
    result = bmesh.ops.holes_fill(bm, edges=boundary, sides=max_sides)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(body.data)
    after = sum(1 for edge in bm.edges if edge.is_boundary)
    bm.free()
    body.data.update()
    return {"boundaryEdgesBefore": before, "facesAdded": len(result["faces"]), "boundaryEdgesAfter": after, "maxSides": max_sides}


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
    modifier.use_symmetry = False
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return {"applied": True, "before": triangles, "triangles": k.triangle_count(body), "ratio": ratio}


def boxes(position, spec):
    """Texel mask for a region declared as bounds on x (absolute), y and z in cooked metres."""
    x, y, z = np.abs(position[..., 0]), position[..., 1], position[..., 2]
    return ((z >= spec.get("zMin", -9)) & (z <= spec.get("zMax", 9)) & (x >= spec.get("xMin", -9)) & (x <= spec.get("xMax", 9))
            & (y >= spec.get("yMin", -9)) & (y <= spec.get("yMax", 9)))


def tone_lift(rgb, gamma):
    """Lift sRGB-encoded colour so each texel's Rec.709 luma L becomes L**gamma (gamma <= 1 lifts darks most).
    Every channel of a texel is scaled by the same factor, so chroma ratios are kept, and never past 1."""
    if gamma == 1.0:
        return rgb
    k.require(0.3 <= gamma <= 1.0, "toneGamma must be in [0.3, 1]")
    luma = np.maximum(rgb @ np.array([0.2126, 0.7152, 0.0722]), 1 / 255)
    scale = np.minimum(luma ** (gamma - 1), 1 / np.maximum(rgb.max(axis=-1), 1 / 255))
    return np.clip(rgb * np.maximum(scale, 1.0)[..., None], 0, 1)


def bake_body(recipe, high, body, out, debug_maps=False):
    """Base colour re-baked from the approved source; tangent normals from the source geometry plus colour relief;
    AO from the decimated geometry; roughness, metalness and dye mask derived from colour inside declared regions."""
    B = recipe["body"]
    bake_size, size = B["bakeSize"], B["textureSize"]
    m.cycles_cpu(1)
    body.data.materials[0] = body.data.materials[0].copy()
    colour_image = m.image("bake-colour", bake_size, "sRGB")
    m.bake_selected_to_active(high, body, "EMIT", colour_image, B["cageExtrusionMeters"], B["maxRayMeters"], emission_from=source_albedo)
    normal_image = m.image("bake-normal", size, "Non-Color")
    m.bake_selected_to_active(high, body, "NORMAL", normal_image, B["cageExtrusionMeters"], B["maxRayMeters"])
    geometric_normal = m.pixels(normal_image)[..., :3]
    high.hide_render = True
    m.cycles_cpu(B["aoSamples"])
    ao_image = m.image("body-ao-bake", size, "Non-Color")
    m.bake_type(body, body.data.materials[0], "AO", ao_image)
    high.hide_render = False
    ao = np.clip(m.pixels(ao_image)[..., 0] ** B["aoPower"], B["aoFloor"], 1)
    m.cycles_cpu(1)
    position, coverage = m.bake_geometry(body, size, "Position")
    _, coverage_bake = m.bake_geometry(body, bake_size, "Position")
    linear = m.fill_gutters(m.srgb_to_linear(m.pixels(colour_image)[..., :3]), coverage_bake)
    rgb = m.linear_to_srgb(m.downsample(linear, bake_size // size))
    value = rgb.max(axis=2)
    saturation = (value - rgb.min(axis=2)) / np.maximum(value, 1e-4)
    rough = np.full(value.shape, B["defaultRoughness"], dtype=np.float32)
    metal = np.zeros(value.shape, dtype=np.float32)
    dye = np.zeros(value.shape, dtype=np.float32)
    fractions = {}
    matches = {}
    for spec in B["regions"]:
        inside = boxes(position, spec) & coverage
        rule = spec.get("colour", {})
        match = inside.copy()
        if "minValue" in rule:
            match &= value >= rule["minValue"]
        if "maxValue" in rule:
            match &= value <= rule["maxValue"]
        if "maxSaturation" in rule:
            match &= saturation <= rule["maxSaturation"]
        if "minSaturation" in rule:
            match &= saturation >= rule["minSaturation"]
        matches[spec["name"]] = match
        if "roughness" in spec:
            rough[match] = spec["roughness"]
        if "metal" in spec:
            metal[match] = spec["metal"]
        if spec.get("dye"):
            dye[match] = 1.0
        fractions[spec["name"]] = float(match.sum() / max(1, coverage.sum()))
    fills = {}
    for spec in B["regions"]:
        F = spec.get("dyeFill")
        if not (spec.get("dye") and F):
            continue
        name = spec["name"]
        candidate = boxes(position, spec) & coverage & (value >= F["minValue"]) & (saturation <= F["maxSaturation"])
        for other in F.get("exclude", []):
            candidate &= ~matches[other]
        closed = m.erode(m.dilate(matches[name], F["radius"]), F["radius"])
        filled = closed & candidate & ~matches[name]
        matches[name] = matches[name] | filled
        dye[filled] = 1.0
        if "roughness" in spec:
            rough[filled] = spec["roughness"]
        fills[name] = {"texels": int(filled.sum()), **F}
        fractions[name] = float(matches[name].sum() / max(1, coverage.sum()))
    tone_facts = []
    if B.get("toneMatch"):
        normal_map, _ = m.bake_geometry(body, size, "Normal")
        facing = normal_map[..., 1] / np.maximum(np.linalg.norm(normal_map, axis=-1), 1e-6)
        for spec in B["toneMatch"]:
            mask = np.zeros(value.shape, dtype=bool)
            for name in spec["regions"]:
                mask |= matches[name]
            front, back = mask & (facing < -0.3), mask & (facing > 0.3)
            if front.sum() < 50 or back.sum() < 50:
                continue
            mean_f, std_f = rgb[front].mean(axis=0), rgb[front].std(axis=0) + 1e-4
            mean_b, std_b = rgb[back].mean(axis=0), rgb[back].std(axis=0) + 1e-4
            contrast = std_f / std_b
            if spec.get("weightFrom") == "position":
                t = np.clip((position[..., 1] - spec["backStart"]) / (spec["backFull"] - spec["backStart"]), 0, 1)
            else:
                t = np.clip((facing + 0.3) / 0.6, 0, 1)
            weight = (t * t * (3 - 2 * t) * mask)[..., None] * spec.get("strength", 1.0)
            matched = np.clip((rgb - mean_b) * contrast + mean_f, 0, 1)
            rgb = rgb * (1 - weight) + matched * weight
            tone_facts.append({"regions": spec["regions"], "frontMean": mean_f.round(3).tolist(), "backMeanBefore": mean_b.round(3).tolist(),
                               "backMeanAfter": rgb[back].mean(axis=0).round(3).tolist(), "contrastApplied": np.asarray(contrast).round(3).tolist(),
                               "texels": int(mask.sum())})
        rgb = m.fill_gutters(rgb, coverage)
        value = rgb.max(axis=2)
    if debug_maps:
        np.savez_compressed(out / "debug-regions.npz", **matches)
    dye = np.clip(m.blur(dye, 1) * 1.1, 0, 1)
    metal = np.clip(m.blur(metal, 1), 0, 1)
    lum = m.luminance(m.srgb_to_linear(rgb))
    detail = lum - m.blur(lum, 6)
    rough = np.clip(m.blur(rough, 1) - detail * B["roughnessFromDetail"], 0.25, 0.97)
    relief = m.height_normal(m.blur(detail, 1), B["reliefStrength"])
    normal = m.fill_gutters(m.blend_normals(geometric_normal, relief), coverage) * 2 - 1
    normal = normal / np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6) * 0.5 + 0.5
    ao, rough, metal, dye = (m.fill_gutters(channel, coverage) for channel in (ao, rough, metal, dye))
    # After relief and roughness are derived, so the calibration changes the base colour only.
    tone_gamma = B.get("toneGamma", 1.0)
    lifted = np.clip(tone_lift(rgb, tone_gamma) * B["albedoGain"], 0, 1)
    ones = np.ones_like(dye)
    base_image = m.image("body-base", size, "sRGB", alpha=True)
    m.set_pixels(base_image, np.dstack([lifted, dye]))
    normal_final = m.image("body-normal", size, "Non-Color")
    m.set_pixels(normal_final, np.dstack([normal, ones]))
    orm_image = m.image("body-orm", size, "Non-Color")
    m.set_pixels(orm_image, np.dstack([ao, rough, metal, ones]))
    for img in (base_image, normal_final, orm_image):
        img.pack()
    final = m.gltf_material("body", base_image, normal_final, orm_image, B["normalMapStrength"])
    body.data.materials.clear()
    body.data.materials.append(final)
    for channel, array in (("dye", dye), ("metal", metal), ("rough", rough), ("ao", ao)):
        m.encode_webp(np.dstack([array, array, array, ones]), out / f"map-{channel}.webp", 90, "Non-Color")
    return {"bakeSize": bake_size, "textureSize": size, "atlasCoverage": float(coverage.mean()),
            "dyeFractionOfSurface": float((dye[coverage] > 0.5).mean()), "metalFractionOfSurface": float((metal[coverage] > 0.5).mean()),
            "regionFractions": fractions, "dyeFills": fills, "toneMatch": tone_facts, "roughnessMean": float(rough[coverage].mean()), "aoMean": float(ao[coverage].mean()),
            "albedoGain": B["albedoGain"], "reliefStrength": B["reliefStrength"], "aoSamples": B["aoSamples"],
            **({"toneGamma": tone_gamma, "toneCalibration": B.get("toneCalibration")} if tone_gamma != 1.0 else {}),
            "provenance": "Base colour re-baked (Cycles CPU, emission, selected-to-active) from the approved source mesh, whose back "
                          "carries the approved rear-view concept projection; tangent normals baked from the source geometry and "
                          "whiteout-blended with colour relief; AO baked from the decimated geometry; roughness, metalness and dye mask "
                          "derived from colour inside declared regions. "
                          + ("Base colour then lifted by luma power toneGamma (chroma ratios kept), calibrated in the game against the "
                             "approved concept. " if tone_gamma != 1.0 else "")
                          + "Artistic derivation, not measured PBR."}
