"""Cook a korovany-2 hero (elf ranger, palace officer, mountain sovereign) in Blender 5.2.2 LTS.

blender -b --factory-startup --python cook_hero.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
    [--rig-only] [--debug-maps]

The source is the approved TRELLIS mesh with its approved rear-view projection (project_rear.py). The output
directory must not exist. Writes <id>.glb, cook.json and map previews. Shared skeleton, weights, items and bakes
live in k2rig.py; this file authors the hero clip set:

  Idle, AtEase, Interact            planted loops (combat stance, conversation stance, kneeling work)
  Run, RunBack, RunLeft, RunRight   one period, phase-aligned, planted strides at the hero's walk speed
  Sprint                            forward, planted strides at the sprint speed
  Dodge                             airborne dash landing as the dash ends, then gathering; authored forward
  Attack, AttackB, Ability          planted one-shots; the game plays them over the lower body while moving
  Hit                               additive flinch
  Death                             fall to a held corpse pose, items dropped to the ground
No clip moves the root joint. Poses are declared in the recipe; arm specs are in rest chest space unless a spec
says "space": "root", in which case it is converted with that pose's own chest.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).parent))
import k2cook as k  # noqa: E402
import k2materials as m  # noqa: E402
import k2rig as r  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--rig-only", action="store_true", help="development: skip material bakes to iterate on rig and clips")
parser.add_argument("--debug-maps", action="store_true")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-character-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {name: k.sha(here / name) for name in ("cook_hero.py", "k2rig.py", "k2cook.py", "k2materials.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()
FPS = 60


def frames_of(seconds):
    return max(1, round(seconds * FPS))


def combine(values, weights):
    """Linear combination of like-shaped pose values (dicts, tuples, numbers); strings pick the heaviest."""
    first = values[0]
    if isinstance(first, dict):
        keys = set().union(*(v.keys() for v in values if isinstance(v, dict)))
        return {key: combine([v.get(key, first.get(key)) if isinstance(v, dict) else v for v in values], weights) for key in keys}
    if isinstance(first, str) or first is None or isinstance(first, bool):
        return values[int(np.argmax(weights))]
    if isinstance(first, (int, float)):
        return sum(w * v for v, w in zip(values, weights))
    return tuple(sum(w * v[i] for v, w in zip(values, weights)) for i in range(len(first)))


def spline(keys, t):
    """Cubic Hermite through key poses with finite-difference tangents (time-scaled): motion keeps its velocity
    through intermediate keys instead of stopping at each. End keys and keys marked "hold" have zero tangents."""
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    index = next(i for i in range(len(keys) - 1) if keys[i][0] <= t <= keys[i + 1][0])
    (t0, p0), (t1, p1) = keys[index], keys[index + 1]
    span = max(t1 - t0, 1e-6)
    u = (t - t0) / span

    def tangent(i):
        if i == 0 or i == len(keys) - 1 or (isinstance(keys[i][1], dict) and keys[i][1].get("hold")):
            return None
        (ta, pa), (tb, pb) = keys[i - 1], keys[i + 1]
        return pa, pb, tb - ta

    h00, h10, h01, h11 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
    values, weights = [p0, p1], [h00, h01]
    for i, h in ((index, h10), (index + 1, h11)):
        spec = tangent(i)
        if spec is None:
            continue
        pa, pb, dt = spec
        scale = h * span / max(dt, 1e-6) * 0.8
        values += [pb, pa]
        weights += [scale, -scale]
    return combine(values, weights)


class Hero:
    def __init__(self, rig, defs, body, items):
        self.rig, self.defs, self.body, self.items = rig, defs, body, items
        self.P = r.Poser(defs, recipe)
        self.C = recipe["clips"]
        self.rest_item = {obj.parent_bone: obj.matrix_world.copy() for obj in items}
        for spec in recipe["items"]["list"]:
            socket = next(s for s in recipe["sockets"] if s["name"] == spec["socket"])
            if socket["kind"] == "grip":
                self.P.set_grip_frame(socket.get("side", "r"), spec["alongWorld"], spec["faceWorld"])
        H = self.P.H
        self.ankle = {side: H[f"foot_{side}"].copy() for side in ("l", "r")}
        C = self.C
        self.stance = {side: Vector((math.copysign(C["stanceHalfWidth"], self.ankle[side].x),
                                     self.ankle[side].y + (C.get("stagger", 0.0) if side == "l" else -C.get("stagger", 0.0)),
                                     self.ankle[side].z)) for side in ("l", "r")}
        self.poses = {name: self.resolve(pose) for name, pose in C["poses"].items()}
        self.facts = []
        self.bends = {}
        self.skirt_gain = tuple(recipe["clips"].get("skirtFollow", (0.8, 0.8)))

    # ------------------------------------------------------------ poses

    def body_of(self, pose, extra=None):
        extra = extra or {}

        def get(key):
            return tuple(a + b for a, b in zip(pose.get(key, (0, 0, 0)), extra.get(key, (0, 0, 0))))

        offset = get("offset")
        offset = (offset[0], offset[1], offset[2] - pose.get("sink", self.C["sink"]) - extra.get("sink", 0.0))
        return self.P.body(offset, get("pelvis"), get("spine"), get("chest"), get("head"), get("neck"))

    BODY_DEFAULTS = {"offset": (0, 0, 0), "pelvis": (0, 0, 0), "spine": (0, 0, 0), "chest": (0, 0, 0), "head": (0, 0, 0),
                     "neck": (0, 0, 0), "skirt": 0.0, "cape": (0.0, 0.0)}
    ARM_DEFAULTS = {"curl": 60.0, "twist": 0.0, "hand": (0, 0, 0), "clavicle": (0, 0, 0), "twistShare": 0.5}

    def resolve(self, pose):
        """Fill every body and arm field so poses interpolate key by key, and convert arm specs declared in root
        space ("space": "root") into rest chest space using the pose's own chest."""
        pose = json.loads(json.dumps(pose))
        for key, value in self.BODY_DEFAULTS.items():
            pose.setdefault(key, value)
        pose.setdefault("sink", self.C["sink"])
        for side in ("l", "r"):
            if isinstance(pose.get(side), dict):
                for key, value in self.ARM_DEFAULTS.items():
                    pose[side].setdefault(key, value)
        chest = self.body_of(pose)["chest"]
        inverse = chest.inverted()
        rotation = inverse.to_3x3()
        for side in ("l", "r"):
            spec = pose.get(side)
            if not isinstance(spec, dict) or spec.get("space") != "root":
                continue
            for key in ("at", "wrist"):
                if key in spec:
                    spec[key] = tuple(inverse @ Vector(spec[key]))
            if "grip" in spec:
                spec["grip"] = {axis: tuple(rotation @ Vector(spec["grip"][axis])) for axis in ("along", "face")}
            if "pole" in spec:
                spec["pole"] = tuple(rotation @ Vector(spec["pole"]))
            spec.pop("space")
        return pose

    def pose(self, name_or_pose):
        if isinstance(name_or_pose, str):
            return self.poses[name_or_pose]
        if isinstance(name_or_pose, dict) and "from" in name_or_pose:
            # {"from": "ready", "hold": true, ...overrides}: a named pose with field overrides.
            merged = json.loads(json.dumps(self.C["poses"][name_or_pose["from"]]))
            for key, value in name_or_pose.items():
                if key != "from":
                    merged[key] = value
            return self.resolve(merged)
        return self.resolve(name_or_pose)

    def arms(self, motion, pose, swing=None, clip=None):
        swing = swing or {}
        for side in ("r", "l"):
            spec = pose.get(side)
            if spec == "haft":
                continue
            spec = dict(spec)
            if side in swing:
                spec = r.offset_spec(spec, swing[side])
            self.P.arm(motion, side, spec)
        if pose.get("l") == "haft":
            self.haft_hand(motion, pose)
        if clip:
            record = self.bends.setdefault(clip, {"l": 0.0, "r": 0.0, "lAt": 0.0, "rAt": 0.0})
            for side in ("l", "r"):
                bend = self.P.wrist_bend(motion, side)
                if bend > record[side]:
                    record[side], record[side + "At"] = bend, round(getattr(self, "clip_time", 0.0), 3)
                short = self.P.reach_short.get(side, 0.0)
                record[side + "Short"] = max(record.get(side + "Short", 0.0), short)

    def haft_hand(self, motion, pose):
        """Trailing hand on the two-handed haft, placed from the posed hammer. In big swings the hands close up on
        the haft (a pose may set its own `leftGrip`), which lets the leading arm extend."""
        M = next(spec for spec in recipe["items"]["list"] if spec["kind"] == "hammer")
        item = motion["hand_r"] @ self.rest_item[M["socket"]]
        along = item.to_3x3() @ Vector((0, 1, 0))
        face = item.to_3x3() @ Vector((0, 0, 1))
        at = item.translation - along * pose.get("leftGrip", M["leftGrip"])
        spec = {"at": tuple(at), "grip": {"along": tuple(along), "face": tuple(face)}, "world": True,
                "pole": tuple(pose.get("haftPole", (1.0, 0.3, -0.6))), "curl": 85, "twistShare": 0.5}
        self.P.arm(motion, "l", spec)

    def feet(self, relative):
        return {side: self.stance[side] + Vector(relative.get(side, (0, 0, 0))) for side in ("l", "r")}

    def plant(self, motion, feet=None, pitch=None, yaw=None):
        feet = feet or self.stance
        for side in ("l", "r"):
            self.P.leg(motion, side, feet[side], (pitch or {}).get(side, 0.0), (yaw or {}).get(side, 0.0))

    def bake(self, name, seconds, pose_at, **extra):
        self.P.reset()
        frames = frames_of(seconds)
        if extra.get("loop"):
            # Warm the solver's continuity over one whole cycle so neighbouring frames solve alike.
            for frame in range(frames + 1):
                pose_at(frame / FPS)
        first = {}

        def evaluate(t):
            # A loop's last frame is its first frame, exactly.
            if extra.get("loop") and "motion" in first and abs(t - frames / FPS) < 1e-6:
                return first["motion"]
            self.clip_time = t
            motion = r.clean_motion(pose_at(t))
            if t == 0:
                first["motion"] = motion
            return motion

        fact = k.bake_clip(self.rig, self.defs, name, frames, evaluate)
        fact.update(extra)
        self.facts.append(fact)
        return fact

    # ------------------------------------------------------------ loops

    def idle(self, name, pose_name, seconds, breath_amount=1.0, sway=1.0):
        base = self.pose(pose_name)
        two_handed = base.get("l") == "haft"

        def at(t):
            phase = 2 * math.pi * t / seconds
            breath, drift = math.sin(phase), math.sin(phase + 0.6)
            extra = {"offset": (0.008 * drift * sway, 0, 0), "sink": 0.008 * (1 - math.cos(phase)) * breath_amount,
                     "pelvis": (0, 0, 1.5 * drift * sway), "spine": (0.6 * breath * breath_amount, 0, 0),
                     "chest": (1.2 * breath * breath_amount, 0, 0), "head": (0, 0, 2.5 * math.sin(phase) * sway)}
            motion = self.body_of(base, extra)
            self.plant(motion)
            lift = (0, 0, 0.01 * breath * breath_amount)
            self.arms(motion, base, {"r": lift} if two_handed else {"l": lift, "r": lift}, clip=name)
            self.P.skirt_follow(motion, self.skirt_gain, 0.5 * breath)
            self.P.cape(motion, 1.0 * breath, 0.5 * breath)
            return motion

        return self.bake(name, seconds, at, loop=True)

    def locomotion(self, name, L, direction):
        """Planted-stride cycle moving the body along `direction` (unit, Blender XY, body frame). Stance feet move
        opposite to the motion at exactly the authored speed; swing uses a Hermite path that leaves and lands moving
        at ground speed, so contacts never slide. Sideways travel turns the hips toward it and the chest back."""
        # A loop must span whole frames; the speed is the game's, so the stride follows the snapped period.
        cycle, speed, duty = frames_of(L["seconds"]) / FPS, L["speed"], L["duty"]
        stride = speed * cycle
        half = stride * duty / 2
        d = Vector((direction[0], direction[1], 0)).normalized()
        forwardness = -d.y
        lateral = Vector((-d.y, d.x, 0))
        if forwardness < -1e-6:
            lateral = -lateral
        side_amount = abs(d.x)
        heading = math.degrees(math.atan2(d.x, -d.y)) if forwardness >= -1e-6 else math.degrees(math.atan2(-d.x, d.y))
        hip_yaw = heading * L.get("hipYawShare", 0.5)
        pitch = L["lean"] * max(forwardness, 0.0) + L["lean"] * L.get("strafeLeanShare", 0.6) * side_amount \
            - L["lean"] * L.get("backLeanShare", 0.25) * max(-forwardness, 0.0)
        base = self.pose(L["pose"])
        swing_seconds = cycle * (1 - duty)
        S = L.get("armSwing", {})
        two_handed = base.get("l") == "haft"

        def at(t):
            phase = (t / cycle) % 1.0
            bob = -L["bob"] * math.cos(4 * math.pi * (phase - duty / 2))
            twist = math.sin(2 * math.pi * phase)
            extra = {
                "offset": (0, 0, bob), "sink": L["sink"],
                "pelvis": (pitch * 0.5, 0, hip_yaw + L["pelvisTwist"] * twist),
                "spine": (pitch * 0.3, 0, -hip_yaw * 0.45 + L.get("spineTwist", 2) * twist),
                "chest": (pitch * 0.2, 0, -hip_yaw * 0.55 - L["chestTwist"] * twist),
                "head": (-pitch * 0.7, 0, L.get("headTwist", 2) * twist),
            }
            motion = self.body_of(base, extra)
            forward = {}
            for side, offset in (("l", 0.0), ("r", 0.5)):
                local = (phase + offset) % 1.0
                sign = 1 if side == "l" else -1
                rest = Vector((0, self.ankle[side].y, self.ankle[side].z))
                lane = lateral * (sign * L["trackHalfWidth"])
                if local < duty:
                    u = local / duty
                    ahead, lift, toe = half - 2 * half * u, 0.0, 0.0
                else:
                    u = (local - duty) / (1 - duty)
                    # Lift-off and touch-down move with the ground (1.0) or slower, which shortens the swing arc.
                    velocity = -speed * swing_seconds * L.get("swingEndVelocity", 1.0)
                    ahead = r.hermite(-half, velocity, half, velocity, u)
                    lift = L["lift"] * math.sin(math.pi * u) ** L.get("liftExponent", 0.8)
                    toe = L["toePitch"] * math.sin(math.pi * u)
                target = rest + lane + d * ahead + Vector((0, 0, lift))
                self.P.leg(motion, side, target, toe if forwardness >= -0.3 else -0.5 * toe, L.get("footYawShare", 0.6) * hip_yaw)
                forward[side] = ahead / max(half, 1e-6)
            swing = {}
            for side, other in (("l", "r"), ("r", "l")):
                if two_handed and side == "l":
                    continue
                amount = S.get(side, (0, 0, 0))
                f = forward[other]
                swing[side] = (0.0, -amount[0] * f, amount[1] * max(0.0, f) + amount[2] * abs(f))
            self.arms(motion, base, swing, clip=name)
            self.P.skirt_follow(motion, tuple(L.get("skirtFollow", self.skirt_gain)), L.get("skirtSwing", 2) * math.sin(4 * math.pi * phase))
            # The cape streams behind at speed and bounces twice per stride.
            capeF = L.get("capeFlare", 0.0)
            self.P.cape(motion, capeF + 3 * math.sin(4 * math.pi * phase - 0.8), capeF * 0.6 + 4 * math.sin(4 * math.pi * phase - 1.6),
                        2 * math.sin(2 * math.pi * phase))
            return motion

        return self.bake(name, cycle, at, loop=True, speed=speed, direction=[round(d.x, 4), round(d.y, 4)], stride=stride,
                         duty=duty, hipYaw=round(hip_yaw, 2))

    def interact(self):
        """Kneel with the weapon grounded; the working hand moves close to the ground."""
        I = self.C["interact"]
        seconds = I["seconds"]
        base = self.pose(I["pose"])
        feet = self.feet(I["feet"])
        pitches = I.get("pitch", {"l": 0, "r": 0})

        def at(t):
            phase = 2 * math.pi * t / seconds
            work = math.sin(phase)
            extra = {"chest": (2 * work, 0, 3 * math.sin(phase * 2)), "head": (4 * work, 0, 0), "sink": 0.004 * (1 - math.cos(phase))}
            motion = self.body_of(base, extra)
            self.plant(motion, feet, pitches)
            hand = I["work"]
            swing = {I["workHand"]: (hand[0] * work, hand[1] * math.sin(phase * 2), hand[2] * abs(work))}
            self.arms(motion, base, swing, clip="Interact")
            self.P.skirt_follow(motion, tuple(I.get("skirtFollow", self.skirt_gain)), base.get("skirt", 0.0))
            self.P.cape(motion, *base.get("cape", (0.0, 0.0)))
            return motion

        return self.bake("Interact", seconds, at, loop=True)

    # ------------------------------------------------------------ one-shots

    def keyed_clip(self, name, spec):
        """Key poses (Hermite through keys) over planted feet, or over relative feet keys
        [[t, {l: dxyz, r: dxyz}, {l: pitch, r: pitch}]] that must hold still while a foot bears weight."""
        seconds = spec["seconds"]
        keys = [(t, self.pose(p)) for t, p in spec["keys"]]
        feet_keys = spec.get("feet")

        def at(t):
            pose = spline(keys, t)
            motion = self.body_of(pose)
            if feet_keys:
                where = r.keyed([(ft, {s: tuple(v) for s, v in f.items()}) for ft, f, *_ in feet_keys], t)
                pitch = r.keyed([(ft, (rest[0] if rest else {"l": 0.0, "r": 0.0})) for ft, f, *rest in feet_keys], t)
                self.plant(motion, self.feet(where), pitch)
            else:
                self.plant(motion)
            self.arms(motion, pose, clip=name)
            self.P.skirt_follow(motion, self.skirt_gain, pose.get("skirt", 0.0))
            self.P.cape(motion, *pose.get("cape", (0.0, 0.0)))
            return motion

        return self.bake(name, seconds, at)

    def hit(self):
        seconds = self.C["hitSeconds"]
        base = self.pose("ready")
        two_handed = base.get("l") == "haft"

        def at(t):
            u = min(1.0, t / seconds)
            amount = math.sin(math.pi * u) * (1 - 0.3 * u)
            extra = {"offset": (0, 0.03 * amount, 0), "sink": 0.02 * amount, "pelvis": (-3 * amount, 0, 0),
                     "spine": (-5 * amount, 0, 0), "chest": (-8 * amount, 0, 4 * amount), "head": (-10 * amount, 0, -4 * amount)}
            motion = self.body_of(base, extra)
            self.plant(motion)
            push = (0, 0.05 * amount, 0.03 * amount)
            self.arms(motion, base, {"r": push} if two_handed else {"l": push, "r": push}, clip="Hit")
            self.P.skirt_follow(motion, self.skirt_gain, -2 * amount)
            self.P.cape(motion, 6 * amount, 4 * amount)
            return motion

        return self.bake("Hit", seconds, at)

    def death(self):
        D = self.C["death"]
        P = self.P
        H = P.H
        lift = {}
        dropped = {}
        start, fling, rest = self.pose(D.get("start", "ready")), self.pose(D["fling"]), self.pose(D["rest"])

        def body_death(t):
            u = t / D["seconds"]
            buckle = k.smoothstep(0.0, 0.35, u)
            fall = k.smoothstep(0.2, 0.85, u) ** 1.4
            settle = math.sin(math.pi * k.smoothstep(0.85, 1.0, u)) * (1 - k.smoothstep(0.85, 1.0, u))
            rest_pelvis = H["pelvis"] - Vector((0, 0, self.C["sink"]))
            target = Vector(D["pelvisEnd"])
            buckled = rest_pelvis + Vector((0, D["buckleBack"], -D["buckleDrop"]))
            position = rest_pelvis.lerp(buckled, buckle)
            if fall > 0:
                position = position.lerp(target, fall)
            position = position + Vector((0, 0, 0.02 * settle + lift.get(round(t * FPS), 0.0)))
            motion = P.body(tuple(position - H["pelvis"]), (-D["tilt"] * fall - 6 * buckle * (1 - fall), 0, D["twist"] * fall),
                            (-6 * buckle, 0, 0), (-10 * buckle - 6 * fall, 0, 4 * fall),
                            (D["headPitch"] * fall - 12 * buckle * (1 - fall), 0, D["headYaw"] * fall))
            for side in ("l", "r"):
                end = Vector(D["footEnd_" + side])
                ankle_target = self.stance[side].lerp(end, fall) + Vector((0, 0, lift.get(round(t * FPS), 0.0)))
                P.leg(motion, side, ankle_target, D["footPitch"] * fall)
            pose = r.keyed([(0, start), (0.3, fling), (1.0, rest)], u)
            self.arms(motion, pose, clip="Death")
            P.skirt_follow(motion, self.skirt_gain, -8 * fall)
            P.cape(motion, -10 * fall, -6 * fall)
            return motion

        def drop_frame(drop, end_motion):
            """Resting frame of a dropped item. `upAxis` names the item axis that faces up on the ground: "z" for
            flat items modelled face-up (sword, shield, quiver), "x" for a bow lying on its side."""
            socket = drop["socket"]
            parent = self.defs[socket][2]
            anchor = end_motion[parent] @ Vector(self.defs[socket][0])
            along = Vector(drop["along"]).normalized()
            up = Vector((0, 0, 1)) if drop.get("faceUp", True) else Vector((0, 0, -1))
            up = (up - along * up.dot(along)).normalized()
            if drop.get("upAxis", "z") == "x":
                frame = Matrix((up, along, up.cross(along))).transposed().to_4x4()
            else:
                frame = Matrix((along.cross(up), along, up)).transposed().to_4x4()
            frame.translation = Vector((anchor.x + drop["offset"][0], anchor.y + drop["offset"][1], drop["height"]))
            return frame @ self.rest_item[socket].inverted()

        local = {obj.parent_bone: np.array([v.co[:] for v in obj.data.vertices]) for obj in self.items}

        def floor_item(socket, frame):
            """A falling item never enters the ground: lift its own frame (not the body) above the clearance."""
            world = np.array(frame)
            lowest = float((local[socket] @ world[:3, :3].T + world[:3, 3])[:, 2].min())
            if lowest < D["groundClearance"]:
                frame = Matrix.Translation((0, 0, D["groundClearance"] - lowest)) @ frame
            return frame

        def death(t):
            motion = body_death(t)
            u = t / D["seconds"]
            if not dropped:
                end_motion = body_death(D["seconds"])
                for drop in D["drops"]:
                    dropped[drop["socket"]] = drop_frame(drop, end_motion)
            for drop in D["drops"]:
                socket = drop["socket"]
                parent = self.defs[socket][2]
                w = k.smoothstep(drop["start"], drop["end"], u)
                if w <= 0:
                    continue
                held = motion[parent] @ self.rest_item[socket]
                ground = dropped[socket] @ self.rest_item[socket]
                location = held.to_translation().lerp(ground.to_translation(), w)
                rotation = held.to_quaternion().slerp(ground.to_quaternion(), w)
                frame = floor_item(socket, Matrix.Translation(location) @ rotation.to_matrix().to_4x4())
                motion[socket] = frame @ self.rest_item[socket].inverted()
            return motion

        frames = frames_of(D["seconds"])
        fact = k.bake_clip(self.rig, self.defs, "Death", frames, lambda t: r.clean_motion(death(t)))
        action = bpy.data.actions["Death"]
        lows = r.lowest_points(self.rig, self.body, self.items, action, frames)
        clamp = {"lowestBefore": min(lows), "iterations": 0}
        # Body parts (and still-held items) below the ground lift the whole body on that frame; iterate because a
        # lift also moves the arms and legs that the IK re-solves.
        while min(lows) < D["groundClearance"] - 1e-4 and clamp["iterations"] < 4:
            clamp["iterations"] += 1
            for frame, low in enumerate(lows):
                if low < D["groundClearance"]:
                    lift[frame] = lift.get(frame, 0.0) + D["groundClearance"] - low
            track = next(track for track in self.rig.animation_data.nla_tracks if track.name == "Death")
            self.rig.animation_data.nla_tracks.remove(track)
            bpy.data.actions.remove(bpy.data.actions["Death"])
            dropped.clear()
            fact = k.bake_clip(self.rig, self.defs, "Death", frames, lambda t: r.clean_motion(death(t)))
            lows = r.lowest_points(self.rig, self.body, self.items, bpy.data.actions["Death"], frames)
        if lift:
            clamp["maxLift"] = max(lift.values())
            clamp["finalLift"] = lift.get(frames, 0.0)
        clamp["lowestAfter"] = min(lows)
        fact["groundClamp"] = clamp
        self.facts.append(fact)
        return fact

    def author(self, only=None):
        C = self.C
        wanted = (lambda name: only is None or name in only)  # noqa: E731
        if wanted("Idle"):
            self.idle("Idle", "ready", C["idleSeconds"])
        if wanted("AtEase"):
            self.idle("AtEase", "ease", C["easeSeconds"], sway=1.3)
        run = C["run"]
        for name, direction in (("Run", (0, -1)), ("RunBack", (0, 1)), ("RunLeft", (1, 0)), ("RunRight", (-1, 0))):
            if wanted(name):
                self.locomotion(name, dict(run, **run.get("overrides", {}).get(name, {})), direction)
        if wanted("Sprint"):
            self.locomotion("Sprint", C["sprint"], (0, -1))
        for name in ("Dodge", "Attack", "AttackB", "Ability"):
            if wanted(name):
                self.keyed_clip(name, C[name[0].lower() + name[1:]])
        if wanted("Interact"):
            self.interact()
        if wanted("Hit"):
            self.hit()
        if wanted("Death"):
            self.death()
        for fact in self.facts:
            if fact["name"] in self.bends:
                record = self.bends[fact["name"]]
                fact["maxWristBendDegrees"] = {side: round(v, 1) for side, v in record.items() if not side.endswith("Short")}
                fact["maxReachShortfallMeters"] = {side: round(record.get(side + "Short", 0.0), 4) for side in ("l", "r")}
        return self.facts


def main():
    k.setup_scene()
    receipt["stage"] = "import"
    body = k.import_single_mesh(args.raw, "body")
    receipt["rawTopology"] = k.topology_report(body)
    receipt["normalization"] = k.normalize(body, recipe["heightMeters"], recipe.get("yawDegrees", 0.0))
    receipt["cleanup"] = k.clean_mesh(body)
    receipt["specks"] = r.keep_largest(body)
    receipt["holes"] = r.fill_small_holes(body, recipe.get("fillHoleSides", 12))
    high = body.copy()
    high.data = body.data.copy()
    high.name = "body-source"
    bpy.context.scene.collection.objects.link(high)
    receipt["uvBefore"] = m.uv_report(body)
    receipt["decimation"] = r.decimate(body, recipe["triangleBudget"])
    receipt["uvAfter"] = m.uv_report(body)
    for polygon in body.data.polygons:
        polygon.use_smooth = True
    receipt["topology"] = k.topology_report(body)
    k.require(receipt["topology"]["triangles"] <= recipe["triangleBudget"], "Body exceeds its triangle budget")
    receipt["stage"] = "materials"
    if args.rig_only:
        receipt["materials"] = {"skipped": "rig-only development cook; source material kept"}
    else:
        receipt["materials"] = r.bake_body(recipe, high, body, out, args.debug_maps)
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "rig"
    defs = r.skeleton(recipe)
    rig = k.build_armature(recipe["id"], defs)
    allowed, locked, facts, part = r.partition_masks(recipe, body, defs)
    W = recipe["weights"]
    receipt["weights"] = k.bind_heat(body, rig, defs, allowed, locked, relax=W.get("relax", 4), blends=r.heat_blends(recipe, defs, part),
                                     final_relax=W.get("finalRelax", 2))
    receipt["weights"]["regions"] = facts
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    if W.get("skirtRamp"):
        receipt["weights"]["skirtRamp"] = r.skirt_ramp(body, W["skirtRamp"])
    if W.get("ankleRamp"):
        receipt["weights"]["ankleRamp"] = r.ankle_ramp(body, defs, W["ankleRamp"])
    if W.get("mantleRamp"):
        receipt["weights"]["mantleRamp"] = r.mantle_ramp(body, defs, W["mantleRamp"])
    receipt["weights"]["seams"] = []
    for S in ([W["seamSoften"]] if isinstance(W.get("seamSoften"), dict) else W.get("seamSoften", [])):
        receipt["weights"]["seams"].append(r.soften_seams(body, S.get("iterations", 8), S.get("rings", 4), locked.keys(), allowed, names,
                                                          S.get("threshold", 0.6), S.get("zRange")))
    receipt["weights"]["pruning"] = r.prune_weights(body, W.get("minWeight", 0.01))
    receipt["rig"] = {"joints": len(defs), "names": list(defs)}
    receipt["stage"] = "items"
    items, receipt["items"] = r.bake_items(rig, recipe)
    receipt["stage"] = "clips"
    only = set(recipe.get("developmentClips", [])) or None if args.rig_only else None
    receipt["clips"] = Hero(rig, defs, body, items).author(only)
    receipt["stage"] = "export"
    path = out / f"{recipe['id']}.glb"
    k.export_glb(path, [rig, body, *items], tangents=not args.rig_only)
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
