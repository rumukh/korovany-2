"""Cook a Korovany II biped monster (the W4b barrow ghoul and bog troll), a skinned hostile beast for version 3 worlds,
in Blender 5.2.2 LTS from an approved TRELLIS mesh.

blender -b --factory-startup --python cook_monster_biped.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
    [--rig-only] [--debug-maps]

Derived from the shipped batch G troop cook (scripts/models/pipeline/cook_troop_g.py, which stays unchanged): the same
humanoid skeleton, partitioned bone-heat weights, IK poser and body bakes from k2rig.py, k2cook.py and k2materials.py
(imported from scripts/models/pipeline, unchanged). Differences from the troop cook: no items, sockets, dye or cape; no
rear-view projection (the beasts keep TRELLIS's own back); a Walk clip beside Run; and the clips follow the monster
contract of src/view/monsters.ts instead of the troops'. Coordinates are cooked metres on Blender axes: +Z up, the
front faces -Y, the beast's left is +X; the glTF exporter converts once to the game's +Y up / +Z forward.

Clips (no root motion; the game plays locomotion at its ground speed divided by the authored speed, and scrubs Windup,
Strike and Recovery by the simulation's progress through those states):
  Idle                      planted breathing loop in the hunched ready stance
  Walk, Run                 forward planted strides at the recipe's speeds (stance feet move backward at exactly the
                            authored ground speed)
  Windup, Strike, Recovery  planted one-shots keyed from recipe poses (Windup ends where Strike starts, Strike where
                            Recovery starts)
  Hit                       one-shot flinch (the game plays it additively)
  Death                     buckle and fall to a held corpse pose; any frame whose skinned mesh dips below the ground is
                            lifted clear of it (the game holds the last frame)
Poses are declared in the recipe; arm specs are wrist targets in rest chest space unless a spec says "space": "root".
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

SHARED = Path(__file__).resolve().parents[2] / "models" / "pipeline"
sys.path.insert(0, str(SHARED))
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
receipt = {"schema": "korovany2-monster-biped-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {"cook_monster_biped.py": k.sha(here / "cook_monster_biped.py"),
                       **{name: k.sha(SHARED / name) for name in ("k2rig.py", "k2cook.py", "k2materials.py")}},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()
FPS = 60
CLIPS = ("Idle", "Walk", "Run", "Windup", "Strike", "Recovery", "Hit", "Death")


def collapse_short_edges(body, min_length, passes=4):
    """Collapse interior edges shorter than `min_length` left by decimation (as the troop cook does): their two ends
    take slightly different skin weights, and a millimetre sliver between them reads as a many-fold stretch in motion.
    Boundary edges are kept. UVs are merged with the vertices."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(body.data)
    before, collapsed = len(bm.edges), 0
    for _ in range(passes):
        short = [edge for edge in bm.edges if edge.is_valid and not edge.is_boundary and edge.calc_length() < min_length]
        if not short:
            break
        bmesh.ops.collapse(bm, edges=short, uvs=True)
        collapsed += len(short)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=[face for face in bm.faces if len(face.verts) > 3])
    remaining = sum(1 for edge in bm.edges if not edge.is_boundary and edge.calc_length() < min_length)
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()
    return {"minEdgeMeters": min_length, "collapsedEdges": collapsed, "edgesBefore": before, "edgesAfter": len(body.data.edges),
            "shortInteriorEdgesRemaining": remaining}


def downsample_detail_maps(size):
    """Box-filter the baked normal and ORM maps down to `size` (texture memory). Normals are averaged as vectors and
    renormalized."""
    facts = {}
    for name in ("body-normal", "body-orm"):
        image = bpy.data.images[name]
        source = image.size[0]
        if source <= size:
            facts[name] = {"size": source, "resampled": False}
            continue
        k.require(source % size == 0, f"{name}: {source} px is not a multiple of {size}")
        step = source // size
        pixels = m.pixels(image).reshape(size, step, size, step, 4).mean(axis=(1, 3))
        if name == "body-normal":
            vector = pixels[..., :3] * 2 - 1
            vector /= np.maximum(np.linalg.norm(vector, axis=-1, keepdims=True), 1e-6)
            pixels[..., :3] = vector * 0.5 + 0.5
        image.scale(size, size)
        m.set_pixels(image, pixels)
        image.pack()
        facts[name] = {"size": size, "resampled": True, "from": source,
                       "filter": f"{step}x{step} box" + (", renormalized" if name == "body-normal" else "")}
    return facts


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


class Monster:
    def __init__(self, rig, defs, body):
        self.rig, self.defs, self.body = rig, defs, body
        self.P = r.Poser(defs, recipe)
        self.C = recipe["clips"]
        H = self.P.H
        self.ankle = {side: H[f"foot_{side}"].copy() for side in ("l", "r")}
        C = self.C
        self.stance = {side: Vector((math.copysign(C["stanceHalfWidth"], self.ankle[side].x),
                                     self.ankle[side].y + (C.get("stagger", 0.0) if side == "l" else -C.get("stagger", 0.0)),
                                     self.ankle[side].z)) for side in ("l", "r")}
        self.poses = {name: self.resolve(pose) for name, pose in C["poses"].items()}
        self.facts = []
        self.bends = {}
        self.warm_idle = None

    # ------------------------------------------------------------ poses

    BODY_DEFAULTS = {"offset": (0, 0, 0), "pelvis": (0, 0, 0), "spine": (0, 0, 0), "chest": (0, 0, 0), "head": (0, 0, 0),
                     "neck": (0, 0, 0)}
    ARM_DEFAULTS = {"curl": 30.0, "twist": 0.0, "hand": (0, 0, 0), "clavicle": (0, 0, 0)}

    def body_of(self, pose, extra=None):
        extra = extra or {}

        def get(key):
            return tuple(a + b for a, b in zip(pose.get(key, (0, 0, 0)), extra.get(key, (0, 0, 0))))

        offset = get("offset")
        offset = (offset[0], offset[1], offset[2] - pose.get("sink", self.C["sink"]) - extra.get("sink", 0.0))
        return self.P.body(offset, get("pelvis"), get("spine"), get("chest"), get("head"), get("neck"))

    def resolve(self, pose):
        """Fill every body and arm field so poses interpolate key by key, and convert arm specs declared in root
        space ("space": "root") into rest chest space using the pose's own chest."""
        pose = json.loads(json.dumps(pose))
        for key, value in self.BODY_DEFAULTS.items():
            pose.setdefault(key, value)
        pose.setdefault("sink", self.C["sink"])
        for side in ("l", "r"):
            for key, value in self.ARM_DEFAULTS.items():
                pose[side].setdefault(key, value)
        inverse = self.body_of(pose)["chest"].inverted()
        rotation = inverse.to_3x3()
        for side in ("l", "r"):
            spec = pose[side]
            if spec.get("space") != "root":
                continue
            spec["wrist"] = tuple(inverse @ Vector(spec["wrist"]))
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
            spec = dict(pose[side])
            if side in swing:
                spec = r.offset_spec(spec, swing[side])
            self.P.arm(motion, side, spec)
        if clip:
            record = self.bends.setdefault(clip, {"l": 0.0, "r": 0.0, "lAt": 0.0, "rAt": 0.0})
            for side in ("l", "r"):
                bend = self.P.wrist_bend(motion, side)
                if bend > record[side]:
                    record[side], record[side + "At"] = bend, round(getattr(self, "clip_time", 0.0), 3)
                record[side + "Short"] = max(record.get(side + "Short", 0.0), self.P.reach_short.get(side, 0.0))

    def feet(self, relative):
        return {side: self.stance[side] + Vector(relative.get(side, (0, 0, 0))) for side in ("l", "r")}

    def plant(self, motion, feet=None, pitch=None, yaw=None):
        feet = feet or self.stance
        for side in ("l", "r"):
            self.P.leg(motion, side, feet[side], (pitch or {}).get(side, 0.0), (yaw or {}).get(side, 0.0))

    def warm_from_idle(self):
        """Restart the arm solver and replay one Idle cycle, so a clip that starts from the ready stance continues
        Idle's arm solution."""
        self.P.reset()
        if self.warm_idle:
            at, frames = self.warm_idle
            for frame in range(frames + 1):
                at(frame / FPS)

    def bake(self, name, seconds, pose_at, warm=False, **extra):
        self.P.reset()
        if warm:
            self.warm_from_idle()
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

    def idle(self, name, pose_name, seconds):
        I = self.C.get("idle", {})
        base = self.pose(pose_name)
        breath_amount, sway, look = I.get("breath", 1.0), I.get("sway", 1.0), I.get("look", 2.5)

        def at(t):
            phase = 2 * math.pi * t / seconds
            breath, drift = math.sin(phase), math.sin(phase + 0.6)
            extra = {"offset": (0.008 * drift * sway, 0, 0), "sink": 0.008 * (1 - math.cos(phase)) * breath_amount,
                     "pelvis": (0, 0, 1.5 * drift * sway), "spine": (0.6 * breath * breath_amount, 0, 0),
                     "chest": (1.2 * breath * breath_amount, 0, 0), "head": (0, 0, look * math.sin(phase))}
            motion = self.body_of(base, extra)
            self.plant(motion)
            lift = (0, 0, 0.01 * breath * breath_amount)
            self.arms(motion, base, {"l": lift, "r": lift}, clip=name)
            return motion

        if name == "Idle":
            self.warm_idle = (at, frames_of(seconds))
        return self.bake(name, seconds, at, loop=True)

    def locomotion(self, name, L, direction):
        """Planted-stride cycle moving the body along `direction` (unit, Blender XY, body frame). Stance feet move
        opposite to the motion at exactly the authored speed; swing uses a Hermite path that leaves and lands moving
        at ground speed, so contacts never slide."""
        # A loop must span whole frames; the speed is the game's, so the stride follows the snapped period.
        cycle, speed, duty = frames_of(L["seconds"]) / FPS, L["speed"], L["duty"]
        stride = speed * cycle
        half = stride * duty / 2
        d = Vector((direction[0], direction[1], 0)).normalized()
        lateral = Vector((-d.y, d.x, 0))
        pitch = L["lean"]
        base = self.pose(L["pose"])
        swing_seconds = cycle * (1 - duty)
        S = L.get("armSwing", {})

        def at(t):
            phase = (t / cycle) % 1.0
            bob = -L["bob"] * math.cos(4 * math.pi * (phase - duty / 2))
            twist = math.sin(2 * math.pi * phase)
            # A heavy beast rolls over each planted foot: the pelvis sways toward the stance side.
            roll = L.get("roll", 0.0) * math.sin(2 * math.pi * phase)
            extra = {
                "offset": (L.get("sway", 0.0) * math.sin(2 * math.pi * phase), 0, bob), "sink": L["sink"],
                "pelvis": (pitch * 0.5, roll, L["pelvisTwist"] * twist),
                "spine": (pitch * 0.3, -roll * 0.5, L.get("spineTwist", 2) * twist),
                "chest": (pitch * 0.2, -roll * 0.5, -L["chestTwist"] * twist),
                "head": (-pitch * L.get("headCounter", 0.7), 0, L.get("headTwist", 2) * twist),
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
                    velocity = -speed * swing_seconds * L.get("swingEndVelocity", 1.0)
                    ahead = r.hermite(-half, velocity, half, velocity, u)
                    lift = L["lift"] * math.sin(math.pi * u) ** L.get("liftExponent", 0.8)
                    toe = L["toePitch"] * math.sin(math.pi * u)
                target = rest + lane + d * ahead + Vector((0, 0, lift))
                self.P.leg(motion, side, target, toe)
                forward[side] = ahead / max(half, 1e-6)
            swing = {}
            for side, other in (("l", "r"), ("r", "l")):
                amount = S.get(side, (0, 0, 0))
                f = forward[other]
                swing[side] = (0.0, -amount[0] * f, amount[1] * max(0.0, f) + amount[2] * abs(f))
            self.arms(motion, base, swing, clip=name)
            return motion

        return self.bake(name, cycle, at, loop=True, speed=speed, direction=[round(d.x, 4), round(d.y, 4)], stride=stride,
                         duty=duty)

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
            return motion

        return self.bake(name, seconds, at, warm=spec["keys"][0][1] == "ready")

    def hit(self):
        seconds = self.C["hitSeconds"]
        base = self.pose("ready")
        scale = self.C.get("hitScale", 1.0)

        def at(t):
            u = min(1.0, t / seconds)
            amount = math.sin(math.pi * u) * (1 - 0.3 * u) * scale
            extra = {"offset": (0, 0.03 * amount, 0), "sink": 0.02 * amount, "pelvis": (-3 * amount, 0, 0),
                     "spine": (-5 * amount, 0, 0), "chest": (-8 * amount, 0, 4 * amount), "head": (-10 * amount, 0, -4 * amount)}
            motion = self.body_of(base, extra)
            self.plant(motion)
            push = (0, 0.05 * amount, 0.03 * amount)
            self.arms(motion, base, {"l": push, "r": push}, clip="Hit")
            return motion

        return self.bake("Hit", seconds, at, warm=True)

    def death(self):
        D = self.C["death"]
        P = self.P
        H = P.H
        lift = {}
        start, fling, rest = self.pose(D.get("start", "ready")), self.pose(D["fling"]), self.pose(D["rest"])

        def at(t):
            u = t / D["seconds"]
            buckle = k.smoothstep(0.0, 0.35, u)
            fall = k.smoothstep(0.2, 0.85, u) ** 1.4
            settle = math.sin(math.pi * k.smoothstep(0.85, 1.0, u)) * (1 - k.smoothstep(0.85, 1.0, u))
            # The fall starts from the hunched start pose itself (its offset, sink and joint angles), so the clip
            # continues the stance without a pop, and blends every joint toward the corpse.
            begin = Vector(start["offset"]) - Vector((0, 0, start["sink"]))
            target = Vector(D["pelvisEnd"])
            buckled = H["pelvis"] + begin + Vector((0, D["buckleBack"], -D["buckleDrop"]))
            position = (H["pelvis"] + begin).lerp(buckled, buckle)
            if fall > 0:
                position = position.lerp(target, fall)
            position = position + Vector((0, 0, 0.02 * settle + lift.get(round(t * FPS), 0.0)))
            pose = r.keyed([(0, start), (0.3, fling), (1.0, rest)], u)
            keep = 1 - fall

            def joint(name, extra):
                return tuple(Vector(start[name]) * keep + Vector(extra))

            motion = P.body(tuple(position - H["pelvis"]),
                            joint("pelvis", (-D["tilt"] * fall - 6 * buckle * keep, 0, D["twist"] * fall)),
                            joint("spine", (-6 * buckle, 0, 0)),
                            joint("chest", (-10 * buckle - 6 * fall, 0, 4 * fall)),
                            joint("head", (D["headPitch"] * fall - 12 * buckle * keep, 0, D["headYaw"] * fall)),
                            joint("neck", (0, 0, 0)))
            for side in ("l", "r"):
                end = Vector(D["footEnd_" + side])
                ankle_target = self.stance[side].lerp(end, fall) + Vector((0, 0, lift.get(round(t * FPS), 0.0)))
                P.leg(motion, side, ankle_target, D["footPitch"] * fall)
            self.arms(motion, pose, clip="Death")
            return motion

        frames = frames_of(D["seconds"])
        self.warm_from_idle()
        fact = k.bake_clip(self.rig, self.defs, "Death", frames, lambda t: r.clean_motion(at(t)))
        lows = r.lowest_points(self.rig, self.body, [], bpy.data.actions["Death"], frames)
        clamp = {"lowestBefore": min(lows), "iterations": 0}
        # Body parts below the ground lift the whole body on that frame; iterate because a lift also moves the arms
        # and legs that the IK re-solves.
        while min(lows) < D["groundClearance"] - 1e-4 and clamp["iterations"] < 4:
            clamp["iterations"] += 1
            for frame, low in enumerate(lows):
                if low < D["groundClearance"]:
                    lift[frame] = lift.get(frame, 0.0) + D["groundClearance"] - low
            track = next(track for track in self.rig.animation_data.nla_tracks if track.name == "Death")
            self.rig.animation_data.nla_tracks.remove(track)
            bpy.data.actions.remove(bpy.data.actions["Death"])
            self.warm_from_idle()
            fact = k.bake_clip(self.rig, self.defs, "Death", frames, lambda t: r.clean_motion(at(t)))
            lows = r.lowest_points(self.rig, self.body, [], bpy.data.actions["Death"], frames)
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
        # Idle first: the other clips warm their arm solver from its cycle.
        self.idle("Idle", "ready", C["idleSeconds"])
        if only is not None and "Idle" not in only:
            self.facts.pop()
            track = next(track for track in self.rig.animation_data.nla_tracks if track.name == "Idle")
            self.rig.animation_data.nla_tracks.remove(track)
            bpy.data.actions.remove(bpy.data.actions["Idle"])
        for name in ("Walk", "Run"):
            if wanted(name):
                self.locomotion(name, C[name.lower()], (0, -1))
        # The game scrubs these by the snapshot's progress through windup, attack and recovery.
        for name in ("Windup", "Strike", "Recovery"):
            if wanted(name):
                self.keyed_clip(name, C[name.lower()])
        if wanted("Hit"):
            self.hit()
        if wanted("Death"):
            self.death()
        for fact in self.facts:
            if fact["name"] in self.bends:
                record = self.bends[fact["name"]]
                fact["maxWristBendDegrees"] = {side: round(v, 1) for side, v in record.items() if side in ("l", "r")}
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
    if recipe.get("minEdgeMeters"):
        receipt["shortEdges"] = collapse_short_edges(body, recipe["minEdgeMeters"])
    receipt["uvAfter"] = m.uv_report(body)
    for polygon in body.data.polygons:
        polygon.use_smooth = True
    receipt["topology"] = k.topology_report(body)
    k.require(receipt["topology"]["triangles"] <= recipe["triangleBudget"], "Body exceeds its triangle budget")
    receipt["stage"] = "materials"
    if args.rig_only:
        receipt["materials"] = {"skipped": "rig-only development cook; source material kept"}
    else:
        k.require(not any(spec.get("dye") for spec in recipe["body"].get("regions", [])), "monsters are never dyed")
        receipt["materials"] = r.bake_body(recipe, high, body, out, args.debug_maps)
        receipt["materials"]["provenance"] = receipt["materials"]["provenance"].replace(
            "from the approved source mesh, whose back carries the approved rear-view concept projection",
            "from the approved TRELLIS source mesh (its own back: no rear-view projection)")
        if recipe["body"].get("detailMapSize"):
            receipt["materials"]["detailMaps"] = downsample_detail_maps(recipe["body"]["detailMapSize"])
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "rig"
    k.require(not recipe.get("sockets") and not recipe.get("items"), "monsters carry no items")
    defs = r.skeleton(recipe)
    rig = k.build_armature(recipe["id"], defs)
    allowed, locked, facts, part = r.partition_masks(recipe, body, defs)
    W = recipe["weights"]
    receipt["weights"] = k.bind_heat(body, rig, defs, allowed, locked, relax=W.get("relax", 4), blends=r.heat_blends(recipe, defs, part),
                                     final_relax=W.get("finalRelax", 2))
    receipt["weights"]["regions"] = facts
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    if W.get("ankleRamp"):
        receipt["weights"]["ankleRamp"] = r.ankle_ramp(body, defs, W["ankleRamp"])
    receipt["weights"]["seams"] = []
    for S in ([W["seamSoften"]] if isinstance(W.get("seamSoften"), dict) else W.get("seamSoften", [])):
        receipt["weights"]["seams"].append(r.soften_seams(body, S.get("iterations", 8), S.get("rings", 4), locked.keys(), allowed, names,
                                                          S.get("threshold", 0.6), S.get("zRange")))
    receipt["weights"]["pruning"] = r.prune_weights(body, W.get("minWeight", 0.01))
    receipt["rig"] = {"joints": len(defs), "names": list(defs)}
    receipt["stage"] = "clips"
    only = (set(recipe.get("developmentClips", [])) or None) if args.rig_only else None
    receipt["clips"] = Monster(rig, defs, body).author(only)
    receipt["stage"] = "export"
    path = out / f"{recipe['id']}.glb"
    k.export_glb(path, [rig, body], tangents=not args.rig_only)
    if not args.rig_only:
        np.save(out / "body-base.npy", m.pixels(bpy.data.images["body-base"]))
        receipt["baseEncoding"] = {"pending": ["body-base"], "encoder": "webp_exact.py"}
        k.replace_images(path, {"body-orm": m.encode_webp(m.pixels(bpy.data.images["body-orm"]), out / "body-orm.webp",
                                                          recipe["ormQuality"], "Non-Color")})
    receipt["animationPruning"] = k.prune_animation(path)
    doc, _ = k.read_glb(path)
    k.require(len(doc.get("skins", [])) == 1, "Export did not retain one skin")
    exported = sorted(a["name"] for a in doc["animations"])
    k.require(exported == sorted(c["name"] for c in receipt["clips"]), "Exported clips differ")
    if only is None:
        k.require(exported == sorted(CLIPS), f"Clips must be the monster contract's: {exported}")
    receipt["output"] = {"file": path.name, "bytes": path.stat().st_size, "sha256": k.sha(path),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-encoding" if not args.rig_only else "rig-only"
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
