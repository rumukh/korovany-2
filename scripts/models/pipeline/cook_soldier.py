"""Cook the korovany-2 line soldier in Blender 5.2.2 LTS (v2: approved high-detail source, decimated and baked).

blender -b --factory-startup --python cook_soldier.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
The source is the approved TRELLIS mesh with its approved rear-view projection (project_rear.py). The output
directory must not exist. Writes char-line-soldier.glb, cook.json and map previews.
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
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as m  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--rig-only", action="store_true", help="development: skip material bakes to iterate on rig and clips")
parser.add_argument("--debug-maps", action="store_true", help="development: save intermediate colour arrays")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-character-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {name: k.sha(here / name) for name in ("cook_soldier.py", "k2cook.py", "k2materials.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()


def mirror(point, sign):
    return Vector((point[0] * sign, point[1], point[2]))


def landmarks():
    """Joint landmarks in cooked metres (Blender axes). Character left is +X; the front faces -Y."""
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
        if recipe["weights"].get("helpers"):
            # Half-rotation helper joints spread linear-blend-skinning strain across the shoulder and knee.
            shoulder, elbow = Vector(mirror(L["shoulder"], sign)), Vector(mirror(L["elbow"], sign))
            add(f"shoulderhelper_{side}", shoulder, shoulder + (elbow - shoulder).normalized() * 0.08, f"clavicle_{side}")
            knee, ankle = Vector(mirror(L["knee"], sign)), Vector(mirror(L["ankle"], sign))
            add(f"kneehelper_{side}", knee, knee + (ankle - knee).normalized() * 0.08, f"thigh_{side}")
    if "tabardFront" in L:
        add("tabard_front", L["tabardFront"], L["tabardFrontTip"], "pelvis")
        add("tabard_back", L["tabardBack"], L["tabardBackTip"], "pelvis")
    wrist, knuckle = Vector(defs["hand_r"][0]), Vector(defs["hand_r"][1])
    grip = wrist.lerp(knuckle, 0.6) + Vector(L.get("gripOffset", (0, 0, 0)))
    add("socket_hand_r", grip, grip + Vector((0, -0.1, 0)), "hand_r", False)
    elbow, wrist_l = Vector(defs["forearm_l"][0]), Vector(defs["forearm_l"][1])
    strap = elbow.lerp(wrist_l, 0.55) + Vector(L.get("shieldOffset", (0.06, 0, 0)))
    add("socket_forearm_l", strap, strap + (wrist_l - elbow).normalized() * 0.1, "forearm_l", False)
    return defs


def regions(body, defs):
    """Which joints may influence each vertex: limbs never borrow torso or opposite-side joints."""
    R = recipe["regions"]
    points = k.coords(body)
    edges = k.adjacency(body)
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    allowed = np.zeros((len(points), len(names)), dtype=bool)
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    arm = {}
    for side, sign in (("l", 1), ("r", -1)):
        lateral = np.flatnonzero((sign * x > R["torsoHalfWidth"]) & (z < R["armpitHeight"]) & (z > R["handMinHeight"]))
        pieces = k.components(lateral, edges)
        k.require(pieces, f"No {side} arm below the armpit")
        tip = max(pieces, key=lambda group: (sign * points[group, 0]).max())
        mask = np.zeros(len(points), dtype=bool)
        mask[tip] = True
        mask |= (sign * x > R["shoulderInner"]) & (z >= R["armpitHeight"]) & (z < R["shoulderTop"])
        arm[side] = mask
    skirt = np.zeros(len(points), dtype=bool)
    if "tabard_front" in defs:
        skirt = (z < R["tabardTop"]) & (z > R["tabardHemHeight"]) & (np.abs(x) < R["tabardHalfWidth"]) & ~arm["l"] & ~arm["r"]
    leg = {}
    for side, sign in (("l", 1), ("r", -1)):
        leg[side] = (sign * x > -0.02) & (z < R["crotchHeight"]) & ~skirt
    torso = ~(arm["l"] | arm["r"] | leg["l"] | leg["r"] | skirt)
    for column, name in enumerate(names):
        side = name[-1] if name[-2:] in ("_l", "_r") else None
        if name.startswith(("upperarm", "forearm", "hand", "fingers")):
            allowed[:, column] = arm[side]
        elif name.startswith("clavicle"):
            allowed[:, column] = arm[side] | (torso & (z > R["armpitHeight"] - 0.08) & ((x > 0) if side == "l" else (x < 0)))
        elif name.startswith(("shin", "foot", "toe")):
            allowed[:, column] = leg[side]
        elif name.startswith("thigh"):
            allowed[:, column] = leg[side] | (skirt & ((x > -0.05) if side == "l" else (x < 0.05))) \
                | (torso & (z < R["crotchHeight"] + 0.12) & ((x > 0) if side == "l" else (x < 0)))
        elif name.startswith("tabard"):
            allowed[:, column] = skirt & ((y < 0.02) if name == "tabard_front" else (y > -0.02))
        elif name == "pelvis":
            allowed[:, column] = torso | skirt | ((leg["l"] | leg["r"]) & (z > R["crotchHeight"] - 0.1))
        elif name in ("spine", "chest"):
            allowed[:, column] = torso | ((arm["l"] | arm["r"]) & (z > R["armpitHeight"]))
        elif name in ("neck", "head"):
            allowed[:, column] = torso & (z > R["neckHeight"] - 0.12)
    locked = {}
    for index in np.flatnonzero(z < R["soleHeight"]):
        locked[int(index)] = "foot_l" if x[index] > 0 else "foot_r"
    facts = {"armVertices": {s: int(v.sum()) for s, v in arm.items()}, "legVertices": {s: int(v.sum()) for s, v in leg.items()},
             "skirtVertices": int(skirt.sum()), "torsoVertices": int(torso.sum()), "lockedSoleVertices": len(locked)}
    return allowed, locked, facts


def pose_tools(defs):
    H = {name: Vector(head) for name, (head, _, _, _) in defs.items()}
    T = {name: Vector(tail) for name, (_, tail, _, _) in defs.items()}
    length = {name: (T[name] - H[name]).length for name in defs}

    def body(offset=(0, 0, 0), pelvis=(0, 0, 0), spine=(0, 0, 0), chest=(0, 0, 0), head=(0, 0, 0)):
        motion = {"root": Matrix.Identity(4)}
        motion["pelvis"] = Matrix.Translation(Vector(offset)) @ k.rotate_about(H["pelvis"], k.rot(*pelvis))
        motion["spine"] = motion["pelvis"] @ k.rotate_about(H["spine"], k.rot(*spine))
        motion["chest"] = motion["spine"] @ k.rotate_about(H["chest"], k.rot(*chest))
        motion["neck"] = motion["chest"]
        motion["head"] = motion["chest"] @ k.rotate_about(H["head"], k.rot(*head))
        return motion

    def arm(motion, side, spec):
        """Two-bone arm IK. spec: wrist target and elbow pole direction in rest chest space (both follow the chest),
        forearm twist about its own axis, hand rotation (world axes at rest) and finger curl, in degrees."""
        chest = motion["chest"]
        motion[f"clavicle_{side}"] = chest
        shoulder = chest @ H[f"upperarm_{side}"]
        target = chest @ Vector(spec["wrist"])
        pole = (chest.to_3x3() @ Vector(spec["pole"])).normalized()
        upper_length, fore_length = length[f"upperarm_{side}"], length[f"forearm_{side}"]
        elbow = k.solve_two_bone(shoulder, target, upper_length, fore_length, pole)
        wrist = elbow + (target - elbow).normalized() * fore_length
        motion[f"upperarm_{side}"] = k.aim(H[f"upperarm_{side}"], T[f"upperarm_{side}"], shoulder, elbow)
        if f"shoulderhelper_{side}" in defs:
            half = chest.to_quaternion().slerp(motion[f"upperarm_{side}"].to_quaternion(), 0.5)
            motion[f"shoulderhelper_{side}"] = (Matrix.Translation(shoulder) @ half.to_matrix().to_4x4()
                                                @ Matrix.Translation(-H[f"upperarm_{side}"]))
        fore = k.aim(H[f"forearm_{side}"], T[f"forearm_{side}"], elbow, wrist)
        twist = spec.get("twist", 0.0)
        if twist:
            fore = k.rotate_about(elbow, Matrix.Rotation(math.radians(twist), 3, (wrist - elbow).normalized())) @ fore
        motion[f"forearm_{side}"] = fore
        hand = fore @ k.rotate_about(H[f"hand_{side}"], k.rot(*spec.get("hand", (0, 0, 0))))
        motion[f"hand_{side}"] = hand
        direction = (T[f"hand_{side}"] - H[f"hand_{side}"]).normalized()
        axis = direction.cross(Vector((0, -1, 0)))
        axis = axis.normalized() if axis.length > 1e-6 else Vector((1, 0, 0))
        motion[f"fingers_{side}"] = hand @ k.rotate_about(H[f"fingers_{side}"], Matrix.Rotation(math.radians(spec.get("curl", 60)), 3, axis))

    def leg(motion, side, ankle, pitch=0.0):
        hip = motion["pelvis"] @ H[f"thigh_{side}"]
        knee = k.solve_two_bone(hip, ankle, length[f"thigh_{side}"], length[f"shin_{side}"], Vector((0, -1, 0.1)))
        motion[f"thigh_{side}"] = k.aim(H[f"thigh_{side}"], T[f"thigh_{side}"], hip, knee)
        motion[f"shin_{side}"] = k.aim(H[f"shin_{side}"], T[f"shin_{side}"], knee, ankle)
        if f"kneehelper_{side}" in defs:
            half = motion[f"thigh_{side}"].to_quaternion().slerp(motion[f"shin_{side}"].to_quaternion(), 0.5)
            motion[f"kneehelper_{side}"] = Matrix.Translation(knee) @ half.to_matrix().to_4x4() @ Matrix.Translation(-H[f"shin_{side}"])
        motion[f"foot_{side}"] = Matrix.Translation(ankle - H[f"foot_{side}"]) @ k.rotate_about(H[f"foot_{side}"], k.rot(pitch, 0, 0))
        motion[f"toe_{side}"] = motion[f"foot_{side}"]

    def skirt(motion, swing):
        if "tabard_front" in defs:
            motion["tabard_front"] = motion["pelvis"] @ k.rotate_about(H["tabard_front"], k.rot(swing, 0, 0))
            motion["tabard_back"] = motion["pelvis"] @ k.rotate_about(H["tabard_back"], k.rot(swing, 0, 0))

    return H, T, length, body, arm, leg, skirt


def mix(a, b, t):
    if isinstance(a, dict):
        return {key: mix(a.get(key, b.get(key)), b.get(key, a.get(key)), t) for key in set(a) | set(b)}
    if isinstance(a, (int, float)):
        return a + (b - a) * t
    return tuple(p + (q - p) * t for p, q in zip(a, b))


def keyed(keys, t):
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t <= t1:
            return mix(a, b, k.smoothstep(0, 1, (t - t0) / max(t1 - t0, 1e-6)))
    return keys[-1][1]


def hermite(p0, v0, p1, v1, u):
    u2, u3 = u * u, u * u * u
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * v1


def offset_spec(spec, wrist=(0, 0, 0)):
    moved = dict(spec)
    moved["wrist"] = tuple(a + b for a, b in zip(spec["wrist"], wrist))
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
            corners = [item.matrix_world @ Vector(corner) for corner in item.bound_box]
            lowest = min(lowest, min(c.z for c in corners))
        result.append(lowest)
    rig.animation_data.action = None
    scene.frame_set(0)
    return result


def author_clips(rig, defs, body=None, items=()):
    H, T, length, pose_body, arm, leg, skirt = pose_tools(defs)
    C = recipe["clips"]
    ankle = {side: H[f"foot_{side}"].copy() for side in ("l", "r")}
    stance = {side: Vector((math.copysign(C["stanceHalfWidth"], ankle[side].x),
                            ankle[side].y + (C["stagger"] if side == "l" else -C["stagger"]), ankle[side].z)) for side in ("l", "r")}
    guard, ease = C["guard"], C["ease"]

    def planted(motion):
        for side in ("l", "r"):
            leg(motion, side, stance[side])

    def arms(motion, pose):
        arm(motion, "l", pose["shield"])
        arm(motion, "r", pose["sword"])

    def idle(t, seconds, relaxed):
        phase = 2 * math.pi * t / seconds
        breath = math.sin(phase)
        sway = math.sin(phase + 0.6)
        if relaxed:
            motion = pose_body((0.012 * sway, 0, -C["sink"] - 0.005 * (1 - math.cos(phase))), (0, 1.5 * sway, 2.0 * sway),
                               (0.6 * breath, 0, 0), (1.0 * breath, 0, 0), (2 * math.sin(2 * phase), 0, 7 * math.sin(phase)))
            pose = {"shield": offset_spec(ease["shield"], (0, 0, 0.006 * breath)), "sword": offset_spec(ease["sword"], (0, 0, 0.006 * breath))}
        else:
            motion = pose_body((0.006 * sway, 0, -C["sink"] - 0.008 * (1 - math.cos(phase))), (0, 0, 1.5 * sway),
                               (0.8 * breath, 0, 0), (1.4 * breath, 0, 0), (0, 0, 2.5 * math.sin(phase)))
            pose = {"shield": offset_spec(guard["shield"], (0, 0, 0.012 * breath)), "sword": offset_spec(guard["sword"], (0, 0.01 * breath, 0.015 * breath))}
        planted(motion)
        arms(motion, pose)
        skirt(motion, 0.5 * breath)
        return motion

    def run(t):
        R = C["run"]
        cycle = R["seconds"]
        stride = R["speed"] * cycle
        phase = (t / cycle) % 1.0
        bob = R["bob"] * (0.5 - 0.5 * math.cos(4 * math.pi * phase))
        twist = math.sin(2 * math.pi * phase)
        motion = pose_body((0, 0, -R["sink"] + bob), (R["lean"] * 0.5, 0, 5 * twist), (R["lean"] * 0.3, 0, 3 * twist),
                           (R["lean"] * 0.2, 0, -9 * twist), (-R["lean"] * 0.7, 0, 3 * twist))
        half = stride * R["duty"] / 2
        swing_seconds = cycle * (1 - R["duty"])
        velocity = -R["speed"] * swing_seconds       # body-frame foot velocity in stance, per unit swing phase
        forward = {}
        for side, offset in (("l", 0.0), ("r", 0.5)):
            local = (phase + offset) % 1.0
            base = Vector((math.copysign(R["trackHalfWidth"], ankle[side].x), ankle[side].y, ankle[side].z))
            if local < R["duty"]:
                u = local / R["duty"]
                ahead, lift, pitch = half - 2 * half * u, 0.0, 0.0
            else:
                u = (local - R["duty"]) / (1 - R["duty"])
                # Hermite swing: leaves and lands moving backward at ground speed, so contact never slides.
                ahead = hermite(-half, velocity, half, velocity, u)
                lift = R["lift"] * math.sin(math.pi * u) ** 0.8
                pitch = R["toePitch"] * math.sin(math.pi * u)
            leg(motion, side, base + Vector((0, -ahead, lift)), pitch)
            forward[side] = ahead / max(half, 1e-6)
        shield = offset_spec(R["shield"], (0, -0.05 * forward["r"], 0.02 * abs(forward["r"])))
        sword = offset_spec(R["sword"], (0, -0.16 * forward["l"], 0.05 * max(0.0, forward["l"])))
        arms(motion, {"shield": shield, "sword": sword})
        skirt(motion, R["skirtSwing"] * math.sin(4 * math.pi * phase))
        return motion

    def attack(sword_keys, chest_keys, sink_keys):
        def pose_at(t):
            motion = pose_body((0, 0, -C["sink"] - keyed(sink_keys, t)[0]), (0, 0, 0.4 * keyed(chest_keys, t)[2]), (0, 0, 0),
                               keyed(chest_keys, t), (0, 0, -0.3 * keyed(chest_keys, t)[2]))
            planted(motion)
            arms(motion, {"shield": guard["shield"], "sword": keyed(sword_keys, t)})
            skirt(motion, 0)
            return motion
        return pose_at

    W, S = C["windup"], C["strike"]
    rest_chest, wind_chest, strike_chest = (0, 0, 0), tuple(W["chest"]), tuple(S["chest"])
    facts = [
        k.bake_clip(rig, defs, "Idle", round(C["idleSeconds"] * 60), lambda t: idle(t, C["idleSeconds"], False)),
        k.bake_clip(rig, defs, "AtEase", round(C["easeSeconds"] * 60), lambda t: idle(t, C["easeSeconds"], True)),
        k.bake_clip(rig, defs, "Run", round(C["run"]["seconds"] * 60), run),
        k.bake_clip(rig, defs, "Windup", round(W["seconds"] * 60),
                    attack([(0, guard["sword"]), (W["seconds"] * 0.35, W["anticipation"]), (W["seconds"], W["sword"])],
                           [(0, rest_chest), (W["seconds"], wind_chest)], [(0, (0,)), (W["seconds"], (W["sink"],))])),
        k.bake_clip(rig, defs, "Strike", round(S["seconds"] * 60),
                    attack([(0, W["sword"]), (S["seconds"] * 0.5, S["through"]), (S["seconds"], S["sword"])],
                           [(0, wind_chest), (S["seconds"], strike_chest)], [(0, (W["sink"],)), (S["seconds"], (S["sink"],))])),
        k.bake_clip(rig, defs, "Recovery", round(C["recoverySeconds"] * 60),
                    attack([(0, S["sword"]), (C["recoverySeconds"] * 0.25, S["sword"]), (C["recoverySeconds"], guard["sword"])],
                           [(0, strike_chest), (C["recoverySeconds"] * 0.25, strike_chest), (C["recoverySeconds"], rest_chest)],
                           [(0, (S["sink"],)), (C["recoverySeconds"], (0,))])),
    ]

    def hit(t):
        seconds = C["hitSeconds"]
        u = min(1.0, t / seconds)
        amount = math.sin(math.pi * u) * (1 - 0.3 * u)
        motion = pose_body((0, 0.03 * amount, -C["sink"] - 0.02 * amount), (-3 * amount, 0, 0), (-5 * amount, 0, 0),
                           (-8 * amount, 0, 4 * amount), (-10 * amount, 0, -4 * amount))
        planted(motion)
        arms(motion, {"shield": offset_spec(guard["shield"], (0, 0.05 * amount, 0.03 * amount)),
                      "sword": offset_spec(guard["sword"], (0, 0.06 * amount, -0.02 * amount))})
        skirt(motion, -2 * amount)
        return motion

    facts.append(k.bake_clip(rig, defs, "Hit", round(C["hitSeconds"] * 60), hit))
    D = C["death"]
    lift = {}
    rest_item = {obj.parent_bone: obj.matrix_world.copy() for obj in items}
    dropped = {}

    def body_death(t):
        u = t / D["seconds"]
        buckle = k.smoothstep(0.0, 0.35, u)
        fall = k.smoothstep(0.2, 0.85, u) ** 1.4
        settle = math.sin(math.pi * k.smoothstep(0.85, 1.0, u)) * (1 - k.smoothstep(0.85, 1.0, u))
        rest_pelvis = H["pelvis"]
        target = Vector(D["pelvisEnd"])
        buckled = rest_pelvis + Vector((0, D["buckleBack"], -D["buckleDrop"]))
        position = rest_pelvis.lerp(buckled, buckle)
        if fall > 0:
            position = position.lerp(target, fall)
        position = position + Vector((0, 0, 0.02 * settle + lift.get(round(t * 60), 0.0)))
        motion = pose_body(tuple(position - rest_pelvis), (-D["tilt"] * fall - 6 * buckle * (1 - fall), 0, D["twist"] * fall),
                           (-6 * buckle, 0, 0), (-10 * buckle - 6 * fall, 0, 4 * fall), (D["headPitch"] * fall - 12 * buckle * (1 - fall), 0, D["headYaw"] * fall))
        for side in ("l", "r"):
            end = Vector(D["footEnd_" + side])
            ankle_target = stance[side].lerp(end, fall) + Vector((0, 0, lift.get(round(t * 60), 0.0)))
            leg(motion, side, ankle_target, D["footPitch"] * fall)
        pose = keyed([(0, guard), (0.3, D["fling"]), (1.0, D["rest"])], u)
        arms(motion, pose)
        skirt(motion, -8 * fall)
        return motion

    def drop_frame(socket, spec, end_motion):
        """Rigid socket motion that lays the item flat on the ground beside where its hand ends up."""
        anchor = end_motion["hand_r" if socket == "socket_hand_r" else "forearm_l"] @ Vector(defs[socket][0])
        along = Vector(spec["along"]).normalized()
        up = Vector((0, 0, 1)) if spec.get("faceUp", True) else Vector((0, 0, -1))
        up = (up - along * up.dot(along)).normalized()
        frame = Matrix((along.cross(up), along, up)).transposed().to_4x4()
        frame.translation = Vector((anchor.x + spec["offset"][0], anchor.y + spec["offset"][1], spec["height"]))
        return frame @ rest_item[socket].inverted()

    def death(t):
        motion = body_death(t)
        u = t / D["seconds"]
        if not dropped:
            end_motion = body_death(D["seconds"])
            for socket, spec in (("socket_hand_r", D["dropSword"]), ("socket_forearm_l", D["dropShield"])):
                dropped[socket] = drop_frame(socket, spec, end_motion)
        for socket, parent, spec in (("socket_hand_r", "hand_r", D["dropSword"]), ("socket_forearm_l", "forearm_l", D["dropShield"])):
            w = k.smoothstep(spec["start"], spec["end"], u)
            if w <= 0:
                continue
            # Interpolate the item's own frame (not the motion about the armature origin) so it falls, not orbits.
            held = motion[parent] @ rest_item[socket]
            ground = dropped[socket] @ rest_item[socket]
            location = held.to_translation().lerp(ground.to_translation(), w)
            rotation = held.to_quaternion().slerp(ground.to_quaternion(), w)
            frame = Matrix.Translation(location) @ rotation.to_matrix().to_4x4()
            motion[socket] = frame @ rest_item[socket].inverted()
        return motion

    frames = round(D["seconds"] * 60)
    first = k.bake_clip(rig, defs, "Death", frames, death)
    death_action = bpy.data.actions["Death"]
    lows = lowest_points(rig, body, items, death_action, frames) if body is not None else []
    clamp = {"lowestBefore": min(lows) if lows else None}
    if lows and min(lows) < D["groundClearance"]:
        for frame, low in enumerate(lows):
            if low < D["groundClearance"]:
                lift[frame] = D["groundClearance"] - low
        track = next(track for track in rig.animation_data.nla_tracks if track.name == "Death")
        rig.animation_data.nla_tracks.remove(track)
        bpy.data.actions.remove(death_action)
        first = k.bake_clip(rig, defs, "Death", frames, death)
        lows = lowest_points(rig, body, items, bpy.data.actions["Death"], frames)
        clamp["maxLift"] = max(lift.values())
    clamp["lowestAfter"] = min(lows) if lows else None
    first["groundClamp"] = clamp
    facts.append(first)
    return facts


def paint(obj, rgb, metal, rough, dye=0.0):
    mesh = obj.data
    colour = mesh.color_attributes.new("paint", "FLOAT_COLOR", "CORNER")
    values = {name: mesh.attributes.new(name, "FLOAT", "CORNER") for name in ("metal", "rough", "dye")}
    for loop in mesh.loops:
        colour.data[loop.index].color = (*rgb, 1)
        values["metal"].data[loop.index].value = metal
        values["rough"].data[loop.index].value = rough
        values["dye"].data[loop.index].value = dye


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


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
    paint(blade, (0.63, 0.65, 0.67), 1.0, 0.3)
    parts.append(blade)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, S["gripLength"] / 2 + 0.015, 0))
    guard = bpy.context.object
    guard.scale = (S["guardWidth"], 0.03, 0.035)
    paint(guard, (0.2, 0.2, 0.21), 1.0, 0.45)
    parts.append(guard)
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=S["gripRadius"], depth=S["gripLength"], rotation=(math.radians(90), 0, 0))
    grip = bpy.context.object
    paint(grip, (0.2, 0.12, 0.07), 0.0, 0.8)
    parts.append(grip)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=S["pommel"], location=(0, -S["gripLength"] / 2 - S["pommel"] * 0.7, 0))
    pommel = bpy.context.object
    paint(pommel, (0.56, 0.43, 0.2), 1.0, 0.4)
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
    paint(face, tuple(D.get("faceColor", (0.84, 0.81, 0.74))), 0.0, 0.72, dye=1.0)
    mesh = face.data
    for polygon in mesh.polygons:
        back, rim = polygon.normal.z < -0.5, abs(polygon.normal.z) <= 0.5
        for loop in polygon.loop_indices:
            if back:
                mesh.color_attributes["paint"].data[loop].color = (0.33, 0.23, 0.13, 1)
                mesh.attributes["dye"].data[loop].value = 0.0
                mesh.attributes["rough"].data[loop].value = 0.85
            elif rim:
                mesh.color_attributes["paint"].data[loop].color = (0.22, 0.22, 0.23, 1)
                mesh.attributes["dye"].data[loop].value = 0.0
                mesh.attributes["metal"].data[loop].value = 1.0
                mesh.attributes["rough"].data[loop].value = 0.5
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=D["boss"], location=(0, D["height"] * 0.06, D["curve"] + D["thickness"] * 0.3))
    boss = bpy.context.object
    boss.scale = (1, 1, 0.45)
    paint(boss, (0.5, 0.39, 0.19), 1.0, 0.42)
    return join([face, boss], "item-shield")


def socket_frame(rig, socket, blade_axis_world, face_axis_world):
    bone = rig.data.bones[socket]
    head = rig.matrix_world @ bone.head_local
    y = Vector(blade_axis_world).normalized()
    z = Vector(face_axis_world)
    z = (z - y * z.dot(y)).normalized()
    x = y.cross(z)
    frame = Matrix((x, y, z)).transposed().to_4x4()
    frame.translation = head
    return frame


def bake_items(rig):
    """Blender-authored items share one small atlas; blades and bows reconstruct badly from one image."""
    I = recipe["items"]
    sword, shield = make_sword(I["sword"]), make_shield(I["shield"])
    for index, obj in enumerate((sword, shield)):
        part = obj.data.attributes.new("part", "INT", "POINT")
        for vertex in obj.data.vertices:
            part.data[vertex.index].value = index
    combined = join([sword, shield], "items-bake")
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
    groups = {0: [], 1: []}
    for piece in pieces:
        groups[piece.data.attributes["part"].data[0].value].append(piece)
    placements = {0: ("item-sword", "socket_hand_r"), 1: ("item-shield", "socket_forearm_l")}
    items = []
    for index, (name, socket) in placements.items():
        obj = join(groups[index], name)
        obj.data.materials.clear()
        obj.data.materials.append(final)
        mesh = obj.data
        if mesh.color_attributes.get("paint"):
            mesh.color_attributes.remove(mesh.color_attributes["paint"])
        for attribute in ("metal", "rough", "dye", "part"):
            if mesh.attributes.get(attribute):
                mesh.attributes.remove(mesh.attributes[attribute])
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        mesh.update()
        spec = I["sword" if index == 0 else "shield"]
        frame = socket_frame(rig, socket, spec["alongWorld"], spec["faceWorld"])
        obj.parent = rig
        obj.parent_type = "BONE"
        obj.parent_bone = socket
        bpy.context.view_layer.update()
        obj.matrix_world = frame
        items.append(obj)
    bpy.data.materials.remove(material)
    return items, {"textureSize": size, "authoring": "Blender-authored low-poly meshes with a baked paint/metal/roughness/dye atlas"}


def source_albedo(material):
    return next(n for n in material.node_tree.nodes if n.type == "TEX_IMAGE").outputs["Color"]


def keep_largest(body):
    """Delete detached specks (TRELLIS leaves small loose shells); returns the removed vertex counts."""
    points = k.coords(body)
    pieces = k.components(np.arange(len(points)), k.adjacency(body))
    pieces.sort(key=len, reverse=True)
    removed = [len(p) for p in pieces[1:]]
    if removed:
        drop = set(int(i) for p in pieces[1:] for i in p)
        bm = bmesh.new()
        bm.from_mesh(body.data)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[i] for i in sorted(drop)], context="VERTS")
        bm.to_mesh(body.data)
        bm.free()
        body.data.update()
    return {"componentsRemoved": len(removed), "verticesRemoved": removed}


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


def bake_body(high, body):
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
    for region in B["regions"]:
        inside = boxes(position, region) & coverage
        rule = region.get("colour", {})
        match = inside.copy()
        if "minValue" in rule:
            match &= value >= rule["minValue"]
        if "maxValue" in rule:
            match &= value <= rule["maxValue"]
        if "maxSaturation" in rule:
            match &= saturation <= rule["maxSaturation"]
        if "minSaturation" in rule:
            match &= saturation >= rule["minSaturation"]
        matches[region["name"]] = match
        if "roughness" in region:
            rough[match] = region["roughness"]
        if "metal" in region:
            metal[match] = region["metal"]
        if region.get("dye"):
            dye[match] = 1.0
        fractions[region["name"]] = float(match.sum() / max(1, coverage.sum()))
    fills = {}
    for region in B["regions"]:
        # Close small holes in a dye mask: warm highlights and stains just past the colour rule would otherwise stay
        # undyed cream and read as pale scratches on every faction's coat.
        F = region.get("dyeFill")
        if not (region.get("dye") and F):
            continue
        name = region["name"]
        candidate = boxes(position, region) & coverage & (value >= F["minValue"]) & (saturation <= F["maxSaturation"])
        for other in F.get("exclude", []):
            candidate &= ~matches[other]
        closed = m.erode(m.dilate(matches[name], F["radius"]), F["radius"])
        filled = closed & candidate & ~matches[name]
        matches[name] = matches[name] | filled
        dye[filled] = 1.0
        if "roughness" in region:
            rough[filled] = region["roughness"]
        fills[name] = {"texels": int(filled.sum()), **F}
        fractions[name] = float(matches[name].sum() / max(1, coverage.sum()))
    tone_facts = []
    if B.get("toneMatch"):
        normal_map, _ = m.bake_geometry(body, size, "Normal")
        facing = normal_map[..., 1] / np.maximum(np.linalg.norm(normal_map, axis=-1), 1e-6)   # +Y is the back
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
            # Match the rear-concept colours to the front's statistics, fading in from the sides to the back. A weight
            # from 3D position is continuous across chart borders; a weight from the normal is not where the atlas
            # packs a chart of the cloth's inner face against its outer face.
            if spec.get("weightFrom") == "position":
                t = np.clip((position[..., 1] - spec["backStart"]) / (spec["backFull"] - spec["backStart"]), 0, 1)
            else:
                t = np.clip((facing + 0.3) / 0.6, 0, 1)
            weight = (t * t * (3 - 2 * t) * mask)[..., None] * spec.get("strength", 1.0)
            matched = np.clip((rgb - mean_b) * contrast + mean_f, 0, 1)
            if args.debug_maps:
                np.save(out / f"debug-tone-{'-'.join(spec['regions'])}-before.npy", rgb)
            rgb = rgb * (1 - weight) + matched * weight
            tone_facts.append({"regions": spec["regions"], "frontMean": mean_f.round(3).tolist(), "backMeanBefore": mean_b.round(3).tolist(),
                               "backMeanAfter": rgb[back].mean(axis=0).round(3).tolist(), "frontStd": std_f.round(4).tolist(),
                               "backStdBefore": std_b.round(4).tolist(), "contrastApplied": np.asarray(contrast).round(3).tolist(),
                               "backStdAfter": rgb[back].std(axis=0).round(4).tolist(), "texels": int(mask.sum())})
        # Tone matching changes covered texels only; refill the gutters from the adjusted charts so mipmaps and
        # filtering at gameplay distance do not pull the unmatched colour back in as pale lines along chart borders.
        rgb = m.fill_gutters(rgb, coverage)
        value = rgb.max(axis=2)
        if args.debug_maps:
            np.save(out / "debug-facing.npy", facing)
            np.save(out / "debug-coverage.npy", coverage)
            np.save(out / "debug-position.npy", position)
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
    lifted = np.clip(rgb * B["albedoGain"], 0, 1)
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
            "provenance": "Base colour re-baked (Cycles CPU, emission, selected-to-active) from the approved source mesh, whose back "
                          "carries the approved rear-view concept projection; tangent normals baked from the source geometry and "
                          "whiteout-blended with colour relief; AO baked from the decimated geometry; roughness, metalness and dye mask "
                          "derived from colour inside declared regions. Artistic derivation, not measured PBR."}


def side_masks(body, defs):
    """Bone-heat weights with anatomical limits: limbs never influence the opposite half, arm joints only reach
    surface near their own segment (bone heat otherwise leaks through the fused armpit into the torso side),
    tabard bones stay on the skirt, and head/neck stay above the shoulders."""
    R = recipe["regions"]
    reach = recipe["weights"].get("reach", {})
    points = k.coords(body)
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    allowed = np.ones((len(points), len(names)), dtype=bool)
    for column, name in enumerate(names):
        head, tail, _, _ = defs[name]
        side = name[-1] if name[-2:] in ("_l", "_r") else None
        if side == "l":
            allowed[:, column] = x > -0.02
        elif side == "r":
            allowed[:, column] = x < 0.02
        prefix = name.rsplit("_", 1)[0] if side else name
        if prefix in reach:
            distance, _ = k.segment_distance(points, head, tail)
            allowed[:, column] &= distance < reach[prefix]
        if name.startswith(("thigh", "shin", "foot", "toe")):
            allowed[:, column] &= z < R["crotchHeight"] + 0.2
        if name.startswith("tabard"):
            allowed[:, column] = ((z < R["tabardTop"]) & (z > R["tabardHemHeight"] - 0.05) & (np.abs(x) < R["tabardHalfWidth"] + 0.03)
                                  & ((y < 0.03) if name == "tabard_front" else (y > -0.03)))
        if name in ("neck", "head"):
            allowed[:, column] = z > R["neckHeight"] - 0.12
    locked = {int(i): ("foot_l" if x[i] > 0 else "foot_r") for i in np.flatnonzero(z < R["soleHeight"])}
    return allowed, locked, {"lockedSoleVertices": len(locked), "reach": reach}


PART_OF = {"pelvis": "torso", "spine": "torso", "chest": "torso", "clavicle_l": "torso", "clavicle_r": "torso",
           "neck": "head", "head": "head", "tabard_front": "skirt", "tabard_back": "skirt"}
for _side in ("l", "r"):
    PART_OF.update({f"upperarm_{_side}": f"arm_{_side}", f"forearm_{_side}": f"arm_{_side}", f"hand_{_side}": f"arm_{_side}",
                    f"fingers_{_side}": f"arm_{_side}", f"thigh_{_side}": f"leg_{_side}", f"shin_{_side}": f"leg_{_side}",
                    f"foot_{_side}": f"leg_{_side}", f"toe_{_side}": f"leg_{_side}", f"shoulderhelper_{_side}": f"arm_{_side}",
                    f"kneehelper_{_side}": f"leg_{_side}"})


def partition_masks(body, defs):
    """Every vertex belongs to the body part of its nearest joint segment; each part may only use its own joints
    plus the neighbours it blends with inside a declared band around the shoulder, hip and neck joints. Bone heat
    then distributes weights inside those limits, so a hand can never be bound to the pelvis and the torso side
    never follows a raised arm."""
    R = recipe["regions"]
    B = recipe["weights"].get("bands", {"shoulder": 0.12, "hip": 0.12, "neck": 0.06})
    radius = recipe["weights"].get("partRadius", {})
    points = k.coords(body)
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    distance = np.empty((len(points), len(names)))
    for column, name in enumerate(names):
        head, tail, _, _ = defs[name]
        distance[:, column], _ = k.segment_distance(points, head, tail)
        # Normalize by each joint's typical flesh radius: a wide torso must not lose its flanks to a nearby limb.
        prefix = name.rsplit("_", 1)[0] if name[-2:] in ("_l", "_r") else name
        distance[:, column] /= radius.get(prefix, 0.1)
    part = np.array([PART_OF[names[i]] for i in np.argmin(distance, axis=1)])
    # Second-best body part: vertices nearly equidistant between torso and an arm (or the head) may use both,
    # so the boundary is decided by bone heat and relaxation instead of a hard cut.
    part_names = sorted(set(PART_OF.values()))
    part_distance = np.stack([distance[:, [i for i, n in enumerate(names) if PART_OF[n] == p]].min(axis=1) for p in part_names], axis=1)
    order = np.argsort(part_distance, axis=1)
    best_d = np.take_along_axis(part_distance, order[:, :1], axis=1)[:, 0]
    second_d = np.take_along_axis(part_distance, order[:, 1:2], axis=1)[:, 0]
    second = np.array(part_names)[order[:, 1]]
    ambiguous = second_d < best_d * recipe["weights"].get("ambiguity", 1.25)
    lateral = (np.abs(x) > R["torsoHalfWidth"] + 0.04) & (z > R["handMinHeight"]) & (z < R["armpitHeight"] + 0.08)
    part[lateral & (x > 0)] = "arm_l"
    part[lateral & (x < 0)] = "arm_r"
    skirt_zone = (z > R["tabardHemHeight"] - 0.02) & (z < R["tabardTop"]) & (np.abs(x) < R["tabardHalfWidth"])
    part[skirt_zone & ~np.char.startswith(part, "arm")] = "skirt"
    head_zone = ((z > R["headMinHeight"]) & (np.abs(x) < R["headHalfWidth"])) | (z > R["helmetMinHeight"])
    part[head_zone] = "head"
    column = {name: index for index, name in enumerate(names)}
    allowed = np.zeros((len(points), len(names)), dtype=bool)

    def allow(mask, *bones):
        for bone in bones:
            if bone in column:
                allowed[mask, column[bone]] = True

    near = {}
    for side in ("l", "r"):
        near[f"shoulder_{side}"] = np.linalg.norm(points - np.array(defs[f"upperarm_{side}"][0]), axis=1) < B["shoulder"]
        armpit = np.array(defs[f"upperarm_{side}"][0]) + np.array(B["armpitOffset"]) * np.array([1 if side == "l" else -1, 1, 1])
        near[f"shoulder_{side}"] |= np.linalg.norm(points - armpit, axis=1) < B["armpit"]
        near[f"hip_{side}"] = np.linalg.norm(points - np.array(defs[f"thigh_{side}"][0]), axis=1) < B["hip"]
    torso, head, skirt = part == "torso", part == "head", part == "skirt"
    allow(torso, "pelvis", "spine", "chest", "clavicle_l", "clavicle_r")
    allow(torso & (z < R["tabardTop"]), "tabard_front", "tabard_back")
    allow(head, "neck", "head")
    allow(head & (z < R["neckHeight"] + B["neck"]), "chest")
    allow(torso & (z > R["neckHeight"] - B["neck"]), "neck")
    allow(torso & ambiguous & (second == "head"), "neck", "head")
    allow(head & ambiguous & (second == "torso"), "chest", "neck")
    allow(skirt, "pelvis", "spine", "chest", "tabard_front", "tabard_back")
    allow(skirt & (z < R["crotchHeight"]), "thigh_l", "thigh_r")
    for side in ("l", "r"):
        arm, leg = part == f"arm_{side}", part == f"leg_{side}"
        knee_z = defs[f"shin_{side}"][0][2]
        allow(arm, f"upperarm_{side}", f"forearm_{side}", f"hand_{side}", f"fingers_{side}")
        shoulder_p, elbow_p = np.array(defs[f"upperarm_{side}"][0]), np.array(defs[f"upperarm_{side}"][1])
        upper_len = np.linalg.norm(elbow_p - shoulder_p)
        along_arm = (points - shoulder_p) @ ((elbow_p - shoulder_p) / upper_len)
        band = recipe["weights"]["elbowBlend"]["band"]
        # Forearm and hand never reach the shoulder; the upper arm never reaches the hand.
        for bone in (f"forearm_{side}", f"hand_{side}", f"fingers_{side}"):
            allowed[:, column[bone]] &= along_arm > upper_len - band
        allowed[:, column[f"upperarm_{side}"]] &= along_arm < upper_len + band
        allow(arm & near[f"shoulder_{side}"], "chest", f"clavicle_{side}")
        allow(arm & ambiguous & (second == "torso"), "chest", "spine", f"clavicle_{side}")
        allow(torso & near[f"shoulder_{side}"], f"upperarm_{side}")
        allow(torso & ambiguous & (second == f"arm_{side}"), f"upperarm_{side}")
        allow((arm | torso) & near[f"shoulder_{side}"], f"shoulderhelper_{side}")
        knee_point = np.array(defs[f"shin_{side}"][0])
        allow(leg & (np.linalg.norm(points - knee_point, axis=1) < recipe["weights"]["kneeBlend"]["band"]), f"kneehelper_{side}")
        allow(leg, f"thigh_{side}")
        allow(leg & (z < knee_z + recipe["weights"]["kneeBlend"]["ramp"] - recipe["weights"]["kneeBlend"].get("shift", 0.0)),
              f"shin_{side}", f"foot_{side}", f"toe_{side}")
        allow(leg & near[f"hip_{side}"], "pelvis")
        allow((torso | skirt) & near[f"hip_{side}"], f"thigh_{side}")
    locked = {int(i): ("foot_l" if x[i] > 0 else "foot_r") for i in np.flatnonzero(z < R["soleHeight"])}
    counts = {name: int((part == name).sum()) for name in sorted(set(part))}
    return allowed, locked, {"lockedSoleVertices": len(locked), "partVertices": counts, "bands": B}, part


def main():
    k.setup_scene()
    receipt["stage"] = "import"
    body = k.import_single_mesh(args.raw, "body")
    receipt["rawTopology"] = k.topology_report(body)
    receipt["normalization"] = k.normalize(body, recipe["heightMeters"], recipe.get("yawDegrees", 0.0))
    receipt["cleanup"] = k.clean_mesh(body)
    receipt["specks"] = keep_largest(body)
    high = body.copy()
    high.data = body.data.copy()
    high.name = "body-source"
    bpy.context.scene.collection.objects.link(high)
    receipt["uvBefore"] = m.uv_report(body)
    receipt["decimation"] = decimate(body, recipe["triangleBudget"])
    receipt["uvAfter"] = m.uv_report(body)
    for polygon in body.data.polygons:
        polygon.use_smooth = True
    receipt["topology"] = k.topology_report(body)
    k.require(receipt["topology"]["triangles"] <= recipe["triangleBudget"], "Body exceeds its triangle budget")
    receipt["stage"] = "materials"
    if args.rig_only:
        receipt["materials"] = {"skipped": "rig-only development cook; source material kept"}
    else:
        receipt["materials"] = bake_body(high, body)
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "rig"
    defs = landmarks()
    rig = k.build_armature("char-line-soldier", defs)
    W = recipe["weights"]
    if W.get("method") == "heat":
        allowed, locked, facts, part = partition_masks(body, defs)
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
            knee, ankle_point = Vector(defs[f"shin_{side}"][0]), Vector(defs[f"shin_{side}"][1])
            blends.append({"joint": list(knee), "axis": list(ankle_point - knee), "band": W["kneeBlend"]["band"],
                           "ramp": W["kneeBlend"]["ramp"], "shift": W["kneeBlend"].get("shift", 0.0),
                           "distal": [f"shin_{side}"], "proximal": [f"thigh_{side}"], "middle": [f"kneehelper_{side}"]})
        S = W["skirtBlend"]
        blends.append({"kind": "skirt", "mask": part == "skirt", "zTop": S["zTop"], "zHem": S["zHem"], "sideRamp": S["sideRamp"],
                       "maxShare": S["maxShare"], "distal": ["thigh_l", "thigh_r"],
                       "proximal": ["pelvis", "tabard_front", "tabard_back", "spine", "chest"]})
        receipt["weights"] = k.bind_heat(body, rig, defs, allowed, locked, relax=W.get("relax", 4), blends=blends,
                                         final_relax=W.get("finalRelax", 2))
    else:
        allowed, locked, facts = regions(body, defs)
        receipt["weights"] = k.bind(body, rig, defs, allowed, locked, relax=W["relax"], falloff=W["falloff"], power=W["power"])
    receipt["weights"]["regions"] = facts
    receipt["rig"] = {"joints": len(defs), "names": list(defs)}
    receipt["stage"] = "items"
    items, receipt["items"] = bake_items(rig)
    receipt["stage"] = "clips"
    receipt["clips"] = author_clips(rig, defs, body, items)
    receipt["stage"] = "export"
    path = out / "char-line-soldier.glb"
    k.export_glb(path, [rig, body, *items], tangents=not args.rig_only)
    # Base-colour alpha is the faction-dye mask, not coverage. Blender's WebP writer uses libwebp's default lossy
    # mode, which discards RGB wherever alpha is 0 (every undyed texel), so the exact arrays are saved for
    # webp_exact.py to encode with libwebp's `exact` option after Blender exits.
    names = ("items-base",) if args.rig_only else ("body-base", "items-base")
    for name in names:
        np.save(out / f"{name}.npy", m.pixels(bpy.data.images[name]))
    receipt["baseEncoding"] = {"pending": list(names), "encoder": "webp_exact.py"}
    if not args.rig_only:
        k.replace_images(path, {"body-orm": m.encode_webp(m.pixels(bpy.data.images["body-orm"]), out / "body-orm.webp",
                                                          recipe["ormQuality"], "Non-Color")})
    receipt["animationPruning"] = k.prune_animation(path)
    doc, _ = k.read_glb(path)
    k.require(len(doc.get("skins", [])) == 1, "Export did not retain one skin")
    k.require(sorted(a["name"] for a in doc["animations"]) == sorted(c["name"] for c in receipt["clips"]), "Exported clips differ")
    receipt["output"] = {"file": path.name, "bytes": path.stat().st_size, "sha256": k.sha(path),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-encoding"
    receipt["stage"] = "complete"


try:
    main()
except Exception as error:
    receipt["status"] = "failed"
    receipt["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    receipt["seconds"] = time.monotonic() - started
    (out / "cook.json").write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("K2_COOK=" + json.dumps({key: receipt.get(key) for key in ("status", "stage", "error", "output")}, default=str))


