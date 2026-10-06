"""Cook a Korovany II monster quadruped (the W4a grave wolf), a skinned hostile beast for version 3 worlds, in Blender 5.2.2
LTS from an approved TRELLIS mesh.

blender -b --factory-startup --python cook_monster_quadruped.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
    [--rig-only] [--measure]

Derived from the shipped quadruped cook (cook_quadruped.py, which stays unchanged); the shared helpers k2cook.py,
k2materials.py, k2rig.py and k2sheet.py are imported from scripts/models/pipeline, unchanged. Differences from the
quadruped cook: the recipe may declare the tail's front edge in the side profile (`weights.tailFront`), and the tail
then claims its vertices before the leg columns (a wolf's bushy tail hangs just behind its hocks); the ears may be
pinned back; and the clips are the monster contract's (the game's enemy state machine) instead of the ambient animal's.
Coordinates are cooked metres on Blender axes: +Z up, the animal faces -Y, its left is +X; the glTF exporter converts
once to the game's +Y up / +Z forward.

Clips (no root motion; the game plays locomotion at its ground speed divided by the authored speed, and scrubs Windup,
Strike and Recovery by the simulation's progress through those states):
  Idle        planted breathing loop, head low, ears and tail moving
  Walk, Run   gait cycles solved by leg IK (stance paws move backward at exactly the authored ground speed)
  Windup      crouch: the trunk sinks back onto the haunches, head low and forward, ears pinned (ends where Strike starts)
  Strike      lunge: the trunk surges forward and up off the planted hind legs, the forelegs lift and reach, the neck
              stretches into the bite (ends where Recovery starts)
  Recovery    the forelegs land and the body settles back to the neutral stance
  Hit         one-shot flinch away from the blow (the game plays it additively)
  Death       the legs buckle, then the body rolls onto its side and settles; the drop is computed from the skinned mesh
              so the carcass lies on the ground (the game holds the last frame)
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

SHARED = Path(__file__).resolve().parents[2] / "models" / "pipeline"
sys.path.insert(0, str(SHARED))
import k2cook as k  # noqa: E402
import k2materials as m  # noqa: E402
import k2rig as r  # noqa: E402
import k2sheet as g  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--raw", type=Path, required=True)
parser.add_argument("--recipe", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--rig-only", action="store_true", help="development: skip material bakes to iterate on rig and clips")
parser.add_argument("--measure", action="store_true", help="report leg columns of the normalized mesh and stop")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-monster-quadruped-cook/1", "status": "running", "asset": recipe["id"], "blender": k.blender_facts(),
           "scripts": {"cook_monster_quadruped.py": k.sha(here / "cook_monster_quadruped.py"),
                       **{name: k.sha(SHARED / name) for name in ("k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py")}},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()
FPS = 60
LEGS = ("LF", "RF", "LH", "RH")
FRONT_CHAIN = ("humerus", "forearm", "cannon_f", "hoof_f")
HIND_CHAIN = ("femur", "tibia", "cannon_h", "hoof_h")
BACK = Vector((0, 1, 0))
AHEAD = Vector((0, -1, 0))


def side_of(key):
    return "l" if key[0] == "L" else "r"


def mirror(point, sign):
    return Vector((point[0] * sign, point[1], point[2]))


def leg_spec(L, key):
    """A leg's own joints (`legs`), or the left side's mirrored (`front`/`hind`, the ox's symmetric landmarks)."""
    if "legs" in L and key in L["legs"]:
        return {name: Vector(point) for name, point in L["legs"][key].items()}
    sign = 1 if key[0] == "L" else -1
    return {name: mirror(point, sign) for name, point in (L["front"] if key[1] == "F" else L["hind"]).items()}


def chain_of(key):
    side = side_of(key)
    return [f"{name}_{side}" for name in (FRONT_CHAIN if key[1] == "F" else HIND_CHAIN)]


# ---------------------------------------------------------------- skeleton

def skeleton(L):
    defs = {}

    def add(name, head, tail, parent, deform=True):
        defs[name] = (tuple(head), tuple(tail), parent, deform)

    add("root", (0, 0, 0), (0, -0.25, 0), None, False)
    add("pelvis", L["hipCentre"], L["lumbar"], "root")
    add("spine1", L["lumbar"], L["back"], "pelvis")
    add("spine2", L["back"], L["withers"], "spine1")
    add("chest", L["withers"], L["neckBase"], "spine2")
    add("neck1", L["neckBase"], L["neckMid"], "chest")
    add("neck2", L["neckMid"], L["poll"], "neck1")
    add("head", L["poll"], L["muzzle"], "neck2")
    tail = [Vector(L["tailRoot"]).lerp(Vector(L["tailTip"]), i / 4) for i in range(5)]
    for index in range(4):
        add(f"tail{index + 1}", tail[index], tail[index + 1], "pelvis" if index == 0 else f"tail{index}")
    for side, sign in (("l", 1), ("r", -1)):
        F, H = leg_spec(L, ("L" if sign > 0 else "R") + "F"), leg_spec(L, ("L" if sign > 0 else "R") + "H")
        if "ear" in L:
            add(f"ear_{side}", mirror(L["ear"], sign), mirror(L["earTip"], sign), "head")
        add(f"scapula_{side}", F["scapulaTop"], F["shoulder"], "chest")
        add(f"humerus_{side}", F["shoulder"], F["elbow"], f"scapula_{side}")
        add(f"forearm_{side}", F["elbow"], F["carpus"], f"humerus_{side}")
        add(f"cannon_f_{side}", F["carpus"], F["fetlock"], f"forearm_{side}")
        add(f"hoof_f_{side}", F["fetlock"], F["toe"], f"cannon_f_{side}")
        add(f"femur_{side}", H["hip"], H["stifle"], "pelvis")
        add(f"tibia_{side}", H["stifle"], H["hock"], f"femur_{side}")
        add(f"cannon_h_{side}", H["hock"], H["fetlock"], f"tibia_{side}")
        add(f"hoof_h_{side}", H["fetlock"], H["toe"], f"cannon_h_{side}")
    return defs


# ---------------------------------------------------------------- weights

def leg_region(points, key, L, W):
    """Vertices of one leg below the trunk: the column around its joints on its own side of the body."""
    spec = leg_spec(L, key)
    top_z = spec["elbow"][2] if key[1] == "F" else spec["stifle"][2]
    joints = ("elbow", "carpus", "fetlock") if key[1] == "F" else ("stifle", "hock", "fetlock")
    centre_y = np.mean([spec[j][1] for j in joints])
    centre_x = np.mean([spec[j][0] for j in joints])
    # Each leg is the column around its own joints (the sheep's legs are not mirror images of each other).
    return ((np.abs(points[:, 0] - centre_x) < W["legHalfWidth"]) & (np.abs(points[:, 1] - centre_y) < W["legHalfDepth"])
            & (points[:, 2] < top_z + W["legTopMargin"]))


def partition(body, defs, L, W):
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    index = {name: column for column, name in enumerate(names)}
    points = k.coords(body)
    allowed = np.zeros((len(points), len(names)), dtype=bool)
    parts = np.full(len(points), "trunk", dtype=object)

    def allow(mask, *bones):
        for bone in bones:
            if bone in index:
                allowed[mask, index[bone]] = True

    legs = {}
    tail_first = np.zeros(len(points), dtype=bool)
    if "tailFront" in W:
        # The tail claims its vertices before the leg columns: every point near the midline, below the tail root and
        # behind the tail's front edge, a line in the side profile from [y, z] `tailFront[0]` (at the root) to
        # `tailFront[1]` (at the tip), held beyond its ends.
        (y0, z0), (y1, z1) = W["tailFront"]
        front = y0 + (np.clip(points[:, 2], min(z0, z1), max(z0, z1)) - z0) * (y1 - y0) / (z1 - z0)
        tail_first = ((np.abs(points[:, 0]) < W["tailHalfWidth"]) & (points[:, 1] > front)
                      & (points[:, 2] < L["tailRoot"][2] + 0.04))
    for key in LEGS:
        legs[key] = leg_region(points, key, L, W) & ~tail_first
    claimed = np.zeros(len(points), dtype=bool)
    for key in LEGS:
        legs[key] &= ~claimed
        claimed |= legs[key]
    # Nothing near the ground may follow the trunk: every vertex below `groundLegHeight` that no column claimed joins the
    # leg whose fetlock is nearest (a stray heel vertex left on the trunk stretches into a flap when the leg swings).
    ground = ~claimed & ~tail_first & (points[:, 2] < W.get("groundLegHeight", 0.0))
    if ground.any():
        fetlocks = np.array([leg_spec(L, key)["fetlock"][:2] for key in LEGS])
        nearest = np.argmin(np.linalg.norm(points[ground][:, None, :2] - fetlocks[None], axis=2), axis=1)
        indices = np.flatnonzero(ground)
        for leg_index, key in enumerate(LEGS):
            legs[key][indices[nearest == leg_index]] = True
        claimed |= ground
    poll_y, base_y = L["poll"][1], L["neckBase"][1]
    tail_root = np.array(L["tailRoot"])
    if "tailFront" in W:
        tail = tail_first & ~claimed
    else:
        tail = (~claimed & (np.abs(points[:, 0]) < W["tailHalfWidth"]) & (points[:, 1] > tail_root[1] - W["tailLead"])
                & (points[:, 2] < tail_root[2] + 0.04))
    head = ~claimed & (points[:, 1] < poll_y + W["headMargin"])
    horns = np.zeros(len(points), dtype=bool)
    if "horns" in W:
        # Horns sweeping back over the neck move rigidly with the head: every unclaimed point behind the poll and above
        # the line from `from` [y, z] to `to` [y, z] (held level beyond its ends), back to `behindY`.
        (y0, z0), (y1, z1) = W["horns"]["from"], W["horns"]["to"]
        line = z0 + (np.clip(points[:, 1], min(y0, y1), max(y0, y1)) - y0) * (z1 - z0) / (y1 - y0)
        horns = ~claimed & ~head & (points[:, 1] < W["horns"]["behindY"]) & (points[:, 2] > line)
        head |= horns
        parts[horns] = "horns"
    neck = ~claimed & ~head & (points[:, 1] < base_y + W["neckMargin"])
    trunk = ~claimed & ~tail & ~head & ~neck
    horn_parts = parts == "horns"
    parts[tail], parts[head & ~horn_parts], parts[neck] = "tail", "head", "neck"
    allow(trunk, "pelvis", "spine1", "spine2", "chest", "neck1")
    allow(neck, "chest", "neck1", "neck2", "head")
    allow(head, "neck2", "head", "ear_l", "ear_r")
    if horns.any():
        # Horns are rigid: the head bone alone, so their tips never bend with the neck they sweep over.
        allowed[horns] = False
        allow(horns, "head")
    allow(tail, "pelvis", "tail1", "tail2", "tail3", "tail4")
    for side, sign in (("l", 1), ("r", -1)):
        near_side = points[:, 0] * sign > -W.get("midlineGap", 0.02)
        shoulder = np.array(leg_spec(L, ("L" if sign > 0 else "R") + "F")["shoulder"])
        hip = np.array(leg_spec(L, ("L" if sign > 0 else "R") + "H")["hip"])
        stifle = np.array(leg_spec(L, ("L" if sign > 0 else "R") + "H")["stifle"])
        near_shoulder = trunk & near_side & (np.linalg.norm(points - shoulder, axis=1) < W["shoulderRadius"])
        near_thigh = trunk & near_side & ((np.linalg.norm(points - hip, axis=1) < W["thighRadius"])
                                          | (np.linalg.norm(points - stifle, axis=1) < W["thighRadius"]))
        allow(near_shoulder, f"scapula_{side}")
        # The upper arm moves only the side of the chest below the point of the shoulder, never the neck or brisket.
        allow(near_shoulder & (points[:, 2] < shoulder[2] + W.get("humerusAbove", 0.05))
              & (np.abs(points[:, 0]) > W.get("humerusMinX", 0.08)), f"humerus_{side}")
        allow(near_thigh, f"femur_{side}")
    if "dewlapZ" in W:
        # The hanging dewlap swings with the chest and neck base, not with the head.
        dewlap = neck & (points[:, 2] < W["dewlapZ"])
        allowed[dewlap] = False
        allow(dewlap, "chest", "neck1")
    if "scapulaNeckRadius" in W:
        # The front of the shoulder reaches into the neck region: let the shoulder blade's influence fade across the
        # boundary instead of stopping at it.
        for side, sign in (("l", 1), ("r", -1)):
            shoulder = np.array(leg_spec(L, ("L" if sign > 0 else "R") + "F")["shoulder"])
            allow(neck & (points[:, 0] * sign > -W.get("midlineGap", 0.02))
                  & (np.linalg.norm(points - shoulder, axis=1) < W["scapulaNeckRadius"]), f"scapula_{side}")
    if "ear" in L and "earRadius" in W:
        for side, sign in (("l", 1), ("r", -1)):
            bone = f"ear_{side}"
            if bone in index:
                far = head & (np.linalg.norm(points - np.array(mirror(L["ear"], sign)), axis=1) >= W["earRadius"])
                allowed[far, index[bone]] = False
    locked = {}
    for key in LEGS:
        side = side_of(key)
        chain = chain_of(key)
        region = legs[key]
        parts[region] = f"leg_{key}"
        top = "scapula_" + side if key[1] == "F" else "pelvis"
        spec = leg_spec(L, key)
        upper_z = (spec["elbow"][2] if key[1] == "F" else spec["stifle"][2]) - W["legBlend"]
        allow(region, *chain)
        allow(region & (points[:, 2] > upper_z), top, "chest" if key[1] == "F" else "pelvis")
        sole = region & (points[:, 2] < W["hoofLockHeight"])
        for vertex in np.flatnonzero(sole):
            locked[int(vertex)] = chain[-1]
    facts = {name: int((parts == name).sum()) for name in set(parts.tolist())}
    facts["lockedHoofVertices"] = len(locked)
    return allowed, locked, facts


# ---------------------------------------------------------------- motion

def osc(spec, u):
    """spec [amplitude, harmonic, phase]: amplitude * cos(2 pi (harmonic u - phase)); u is clip time / clip length."""
    if not spec:
        return 0.0
    amplitude, harmonic, phase = spec
    return amplitude * math.cos(2 * math.pi * (harmonic * u - phase))


def pulse(t, start, length):
    """Smooth 0-1-0 bump over [start, start + length]; zero elsewhere, so loops close."""
    if length <= 0 or t <= start or t >= start + length:
        return 0.0
    return math.sin(math.pi * (t - start) / length) ** 2


def hermite(p0, m0, p1, m1, s):
    s2, s3 = s * s, s * s * s
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1


def quat_x(degrees):
    return Quaternion((1, 0, 0), math.radians(degrees))


class Quadruped:
    def __init__(self, rig, defs, body, L, pivots):
        self.rig, self.defs, self.body, self.L = rig, defs, body, L
        self.rest = {name: (Vector(head), Vector(tail)) for name, (head, tail, _, _) in defs.items()}
        self.legs = {}
        for key in LEGS:
            chain = chain_of(key)
            A, B = self.rest[chain[0]]
            C = self.rest[chain[1]][1]
            F, T = self.rest[chain[3]]
            # P: the measured front edge of the hoof sole on the ground. Stance plants it and the heel rolls over it.
            self.legs[key] = {"chain": chain, "front": key[1] == "F", "side": side_of(key), "A": A, "B": B, "C": C, "F": F, "T": T,
                              "P": Vector(pivots[key]), "a": (B - A).length, "b": (C - B).length, "c": (F - C).length,
                              "interior": (B - C).angle(F - C)}
        # The approved concept stands mid-stride: gaits sweep each front and hind pair about one shared neutral line.
        self.align = {}
        for end in ("F", "H"):
            mean = (self.legs["L" + end]["P"].y + self.legs["R" + end]["P"].y) / 2
            for side in ("L", "R"):
                self.align[side + end] = mean - self.legs[side + end]["P"].y
        self.centre = (Vector(L["hipCentre"]) + Vector(L["withers"])) / 2
        self.facts = []

    # --- trunk, neck, head and tail -------------------------------------------------------------
    def upper(self, motions, trunk_offset=(0, 0, 0), pitch=0.0, roll=0.0, yaw=0.0, flex=0.0, neck=(0.0, 0.0, 0.0),
              head_yaw=0.0, ears=(0.0, 0.0), tail=((0.0, 0.0),) * 4, scapula=None, ear_pitch=0.0):
        """`ear_pitch` (degrees, negative pins the ears back flat against the neck) adds to each ear's flick."""
        L = self.L
        trunk = Matrix.Translation(Vector(trunk_offset)) @ k.rotate_about(self.centre, k.rot(x=pitch, y=roll, z=yaw))
        motions["pelvis"] = trunk @ k.rotate_about(L["lumbar"], k.rot(x=flex / 2))
        motions["spine1"] = trunk
        motions["spine2"] = trunk
        chest = trunk @ k.rotate_about(L["back"], k.rot(x=-flex / 2))
        motions["chest"] = chest
        n1, n2, h = neck
        motions["neck1"] = chest @ k.rotate_about(L["neckBase"], k.rot(x=n1, z=head_yaw * 0.4))
        motions["neck2"] = motions["neck1"] @ k.rotate_about(L["neckMid"], k.rot(x=n2, z=head_yaw * 0.3))
        motions["head"] = motions["neck2"] @ k.rotate_about(L["poll"], k.rot(x=h, z=head_yaw * 0.3))
        if "ear_l" in self.defs:
            for side, sign, flick in (("l", 1, ears[0]), ("r", -1, ears[1])):
                motions[f"ear_{side}"] = motions["head"] @ k.rotate_about(mirror(L["ear"], sign),
                                                                          k.rot(x=ear_pitch, y=sign * flick, z=-sign * flick * 0.4))
        parent = motions["pelvis"]
        for index, (tail_pitch, tail_yaw) in enumerate(tail):
            bone = f"tail{index + 1}"
            parent = parent @ k.rotate_about(self.rest[bone][0], k.rot(x=tail_pitch, z=tail_yaw))
            motions[bone] = parent
        for side in ("l", "r"):
            angle = (scapula or {}).get(side, 0.0)
            motions[f"scapula_{side}"] = chest @ k.rotate_about(self.rest[f"scapula_{side}"][0], k.rot(x=angle))
        return motions

    # --- legs ------------------------------------------------------------------------------------
    def solve(self, motions, key, toe=None, hoof=Quaternion(), fetlock=None, flex=0.0):
        """Place one leg: either a planted sole pivot with a hoof orientation (stance), or a fetlock target with joint
        flexion (swing). Returns the reach shortfall in metres (0 when the chain reaches its target) and the cannon's
        rotation."""
        G = self.legs[key]
        chain = G["chain"]
        top_motion = motions[f"scapula_{G['side']}"] if G["front"] else motions["pelvis"]
        A = top_motion @ G["A"]
        rotation = hoof.to_matrix()
        if fetlock is None:
            fetlock = Vector(toe) + rotation @ (G["F"] - G["P"])
        F = Vector(fetlock)
        interior = G["interior"] - math.radians(flex)
        bf = math.sqrt(max(1e-8, G["b"] ** 2 + G["c"] ** 2 - 2 * G["b"] * G["c"] * math.cos(interior)))
        shortfall = max(0.0, (F - A).length - (G["a"] + bf))
        B = k.solve_two_bone(A, F, G["a"], bf, BACK if G["front"] else AHEAD)
        C = k.solve_two_bone(B, F, G["b"], G["c"], AHEAD if G["front"] else BACK)
        motions[chain[0]] = k.aim(G["A"], G["B"], A, B)
        motions[chain[1]] = k.aim(G["B"], G["C"], B, C)
        motions[chain[2]] = k.aim(G["C"], G["F"], C, F)
        motions[chain[3]] = Matrix.Translation(F) @ rotation.to_4x4() @ Matrix.Translation(-G["F"])
        return shortfall, motions[chain[2]].to_quaternion()

    def plant_all(self, motions):
        short = 0.0
        for key in LEGS:
            s, _ = self.solve(motions, key, toe=self.legs[key]["P"])
            short = max(short, s)
        return short

    # --- clips -------------------------------------------------------------------------------------
    def reach_room(self, G):
        """Largest symmetric stance sweep each leg can reach around its neutral hoof position with the gait's trunk
        drop (rest joint bends kept; the elbow or stifle may straighten fully), with a 1.5 % safety margin."""
        room = {}
        for key in LEGS:
            leg = self.legs[key]
            interior = leg["interior"]
            bf = math.sqrt(max(1e-8, leg["b"] ** 2 + leg["c"] ** 2 - 2 * leg["b"] * leg["c"] * math.cos(interior)))
            reach = (leg["a"] + bf) * 0.985
            top = leg["A"] + Vector((0, 0, G.get("drop", 0.0) - abs((G.get("bob") or [0])[0])))
            neutral = leg["F"] + Vector((0, G.get("shift", {}).get(key[1], 0.0) + self.align[key], 0))
            height = top.z - neutral.z
            width = math.sqrt(max(0.0, reach * reach - height * height))
            room[key] = round(2 * max(0.0, width - abs(neutral.y - top.y)), 4)
        return room

    def gait(self, name, G):
        """A periodic gait from recipe parameters. The stance sweep and duty factor fix the stride; the cycle length is
        snapped to whole 60 Hz frames and the stride recomputed, so the authored ground speed stays exact."""
        v, duty = G["speed"], G["duty"]
        frames = max(8, round(G["sweep"] / duty / v * FPS))
        period = frames / FPS
        stride = v * period
        sweep = duty * stride
        record = {key: {"short": 0.0, "minToe": 9.0} for key in LEGS}

        def phase(key, u):
            return (u - G["offsets"][key]) % 1.0

        def pose_at(t):
            u = t / period
            motions = {}
            pitch = osc(G.get("pitch"), u)
            scap = {}
            for key in LEGS:
                if key[1] == "F":
                    p = phase(key, u)
                    # The shoulder blade swings with the limb: forward in swing, back through stance.
                    swing = (p - duty) / (1 - duty) if p >= duty else None
                    along = (-1 + 2 * (p / duty)) if swing is None else (1 - 2 * k.smoothstep(0, 1, swing))
                    scap[side_of(key)] = along * G.get("scapula", 0.0)
            nod = osc(G.get("nod"), u)
            tail = []
            for index in range(4):
                lag = G.get("tailLag", 0.08) * index
                sway = G.get("tail", [0, 1, 0])
                tail.append((G.get("tailLift", 0.0) * (1 if index == 0 else 0.3) + osc(G.get("tailPitch"), u - lag),
                             osc([sway[0] * (1 + 0.35 * index), sway[1], sway[2]], u - lag)))
            self.upper(motions, (osc(G.get("sway"), u), 0.0, osc(G.get("bob"), u) + G.get("drop", 0.0)),
                       pitch=pitch, roll=osc(G.get("roll"), u), yaw=osc(G.get("yaw"), u), flex=osc(G.get("flex"), u),
                       neck=(-pitch * G.get("counter", 0.5) + nod * 0.5 + G.get("neckBias", 0.0), nod * 0.3, nod * 0.2),
                       tail=tail, scapula=scap)
            for key in LEGS:
                leg = self.legs[key]
                p = phase(key, u)
                neutral = leg["P"] + Vector((0, G.get("shift", {}).get(key[1], 0.0) + self.align[key], 0))
                touch = neutral + Vector((0, -sweep / 2, 0))
                lift_point = neutral + Vector((0, sweep / 2, 0))
                heel = G["heelLift"]
                roll_start = 1 - G.get("rollFraction", 0.25)
                if p < duty:
                    s = p / duty
                    toe = touch + Vector((0, sweep * s, 0))
                    alpha = heel * k.smoothstep(roll_start, 1.0, s)
                    short, _ = self.solve(motions, key, toe=toe, hoof=quat_x(alpha))
                    record[key]["short"] = max(record[key]["short"], short)
                    continue
                s = (p - duty) / (1 - duty)
                q_lift = quat_x(heel)
                start = lift_point + q_lift.to_matrix() @ (leg["F"] - leg["P"])
                end = touch + (leg["F"] - leg["P"])
                swing_seconds = period * (1 - duty)
                # Reach forward past the touch-down point, then retract so the hoof lands moving backward at exactly
                # the ground speed (constant deceleration-free retraction: overshoot = v * t / 2).
                retract = G.get("retraction", 0.2)
                overshoot = v * retract * swing_seconds / 2
                peak_y = end.y - overshoot
                if s < 1 - retract:
                    sigma = s / (1 - retract)
                    y = hermite(start.y, v * swing_seconds * (1 - retract), peak_y, 0.0, sigma)
                else:
                    sigma = (s - (1 - retract)) / retract
                    y = peak_y + overshoot * sigma * sigma
                peak = G.get("liftPeak", {}).get(key[1], 0.5)
                # A sine (not squared) bump: the hoof leaves and strikes the ground with vertical speed, so no frame near
                # contact hovers within the planted band while still swinging.
                bump = math.sin(math.pi * s ** (math.log(0.5) / math.log(peak)))
                z = start.z + (end.z - start.z) * s + G["lift"][key[1]] * bump
                fetlock = Vector((start.x, y, z))
                flex_peak = G.get("flexPeak", {}).get(key[1], 0.4)
                flex_shape = math.sin(math.pi * s ** (math.log(0.5) / math.log(flex_peak)))
                flex = G["flex_" + key[1]] * flex_shape
                # First pass for the cannon orientation, then the hoof: lift pose -> flexed behind the cannon -> flat.
                _, cannon = self.solve(motions, key, fetlock=fetlock, flex=flex, hoof=q_lift)
                relative = cannon @ quat_x(G["fetlockFlex"] * math.sin(math.pi * s))
                hoof = q_lift.slerp(relative, k.smoothstep(0.0, 0.3, s)).slerp(Quaternion(), k.smoothstep(0.62, 1.0, s))
                short, _ = self.solve(motions, key, fetlock=fetlock, flex=flex, hoof=hoof)
                record[key]["short"] = max(record[key]["short"], short)
                toe_now = fetlock + hoof.to_matrix() @ (leg["P"] - leg["F"])
                record[key]["minToe"] = min(record[key]["minToe"], toe_now.z)
            return motions

        fact = k.bake_clip(self.rig, self.defs, name, frames, pose_at)
        fact.update({"speed": v, "duty": duty, "strideMeters": round(stride, 4), "stanceSweepMeters": round(sweep, 4),
                     "cycleHz": round(1 / period, 3), "offsets": G["offsets"], "reachableSweepMeters": self.reach_room(G),
                     "maxReachShortfallMeters": {key: round(value["short"], 4) for key, value in record.items()},
                     "minSwingToeHeight": {key: round(value["minToe"], 4) for key, value in record.items()}})
        return fact

    def idle(self, I):
        """Planted breathing loop; `neckBias` [n1, n2, head] carries the head low and level (a hunting animal), and
        `earPitch` sets the ears' rest angle."""
        seconds = I["seconds"]
        frames = round(seconds * FPS)
        bias = I.get("neckBias", [0.0, 0.0, 0.0])

        def pose_at(t):
            u = t / seconds
            breath = osc(I["breath"], u)
            tail_swish = sum(pulse(t, start, I["tailSwishSeconds"]) * math.sin(2 * math.pi * (t - start) / I["tailSwishSeconds"])
                             for start in I["tailSwishAt"])
            ear = [sum(pulse(t, start, I["earFlickSeconds"]) for start in I["earFlickAt"][side]) * I["earFlickDegrees"] for side in (0, 1)]
            tail = [(osc(I.get("tailPitch"), u), I["tailSwishDegrees"] * tail_swish * (0.6 + 0.4 * index)) for index in range(4)]
            motions = {}
            nod = osc(I["nod"], u)
            self.upper(motions, (osc(I["sway"], u), 0.0, breath * I["breathRise"]), pitch=breath * I["breathPitch"],
                       roll=osc(I.get("roll"), u), neck=(bias[0] + nod * 0.5, bias[1] + nod * 0.3, bias[2] + nod * 0.2),
                       head_yaw=osc(I["look"], u), ears=ear, tail=tail, ear_pitch=I.get("earPitch", 0.0))
            self.plant_all(motions)
            return motions

        return k.bake_clip(self.rig, self.defs, "Idle", frames, pose_at)

    # --- the attack: Windup -> Strike -> Recovery ----------------------------------------------------
    def attack_pose(self, C, crouch, lunge, lift):
        """The attack's poses: `crouch` 0-1 (the windup's loaded crouch), `lunge` 0-1 (the strike's surge and bite) and
        `lift` 0-1 (the forelegs off the ground, reaching). Hind paws stay planted. Returns motions and the worst reach
        shortfall."""
        W, S = C["crouch"], C["lunge"]

        def mix(key, index=None):
            a, b = W.get(key, 0.0), S.get(key, 0.0)
            if index is not None:
                a, b = (a or [0.0, 0.0, 0.0])[index], (b or [0.0, 0.0, 0.0])[index]
            return a * crouch + b * lunge

        motions = {}
        offset = (0.0, W["back"] * crouch - S["surge"] * lunge, -W["sink"] * crouch + S["rise"] * lunge)
        self.upper(motions, offset, pitch=mix("pitch"), flex=mix("flex"), neck=tuple(mix("neck", i) for i in range(3)),
                   tail=[(mix("tail") * (1.0 if index == 0 else 0.4), 0.0) for index in range(4)], ear_pitch=mix("ears"),
                   scapula={"l": mix("scapula"), "r": mix("scapula")})
        short = 0.0
        for key in LEGS:
            leg = self.legs[key]
            if key[1] == "F" and lift > 1e-6:
                fetlock = leg["F"] + Vector((0.0, -S["frontReach"] * lift, S["frontLift"] * lift))
                s, _ = self.solve(motions, key, fetlock=fetlock, flex=S["frontFlex"] * lift, hoof=quat_x(S["pawCurl"] * lift))
            else:
                s, _ = self.solve(motions, key, toe=leg["P"])
            short = max(short, s)
        return motions, short

    def attack_clip(self, C, name, seconds, schedule):
        frames = max(1, round(seconds * FPS))
        worst = [0.0]

        def pose_at(t):
            crouch, lunge, lift = schedule(min(1.0, t / seconds))
            motions, short = self.attack_pose(C, crouch, lunge, lift)
            worst[0] = max(worst[0], short)
            return motions

        fact = k.bake_clip(self.rig, self.defs, name, frames, pose_at)
        fact["maxReachShortfallMeters"] = round(worst[0], 4)
        return fact

    def windup(self, C):
        return self.attack_clip(C, "Windup", C["windupSeconds"], lambda s: (k.smoothstep(0.0, 1.0, s), 0.0, 0.0))

    def strike(self, C):
        return self.attack_clip(C, "Strike", C["strikeSeconds"],
                                lambda s: (1.0 - k.smoothstep(0.0, 0.7, s), k.smoothstep(0.0, 1.0, s), k.smoothstep(0.0, 1.0, s)))

    def recovery(self, C):
        def schedule(s):
            lunge = 1.0 - k.smoothstep(0.0, 1.0, s)
            return 0.0, lunge, lunge * (1.0 - k.smoothstep(0.0, C["landBy"], s))
        return self.attack_clip(C, "Recovery", C["recoverySeconds"], schedule)

    def hit(self, H):
        """One-shot flinch away from the blow, starting and ending at the neutral stance (played additively)."""
        seconds = H["seconds"]
        frames = round(seconds * FPS)

        def pose_at(t):
            p = pulse(t, 0.0, seconds)
            q = pulse(t, seconds * 0.05, seconds * 0.9)
            motions = {}
            self.upper(motions, (H["side"] * p, H["back"] * p, -H["sink"] * p), pitch=H["pitch"] * p, roll=H["roll"] * p,
                       neck=tuple(value * q for value in H["neck"]), head_yaw=H["headYaw"] * q, ear_pitch=H["ears"] * q,
                       tail=[(H["tail"] * q * (1.0 if index == 0 else 0.4), 0.0) for index in range(4)])
            self.plant_all(motions)
            return motions

        return k.bake_clip(self.rig, self.defs, "Hit", frames, pose_at)

    # --- Death ---------------------------------------------------------------------------------------------
    def skin_setup(self):
        """Rest vertices and the bound weights as dense arrays, for evaluating posed meshes here."""
        names = list(self.defs)
        index = {name: column for column, name in enumerate(names)}
        points = k.coords(self.body)
        weights = np.zeros((len(points), len(names)))
        groups = {group.index: group.name for group in self.body.vertex_groups}
        for vertex in self.body.data.vertices:
            for entry in vertex.groups:
                name = groups[entry.group]
                if name in index:
                    weights[vertex.index, index[name]] = entry.weight
        totals = weights.sum(axis=1, keepdims=True)
        k.require(bool((totals > 0).all()), "Unweighted vertex in the death bake")
        self.skin = (names, np.hstack([points, np.ones((len(points), 1))]), weights / totals)

    def skinned(self, motions):
        """Posed vertex positions (linear blend skinning in armature space), missing bones inheriting their parent's
        motion exactly as k2cook.bake_clip does."""
        names, rest, weights = self.skin
        full = {}
        for name in names:
            motion = motions.get(name)
            if motion is None:
                parent = self.defs[name][2]
                motion = full.get(parent, Matrix.Identity(4)) if parent else Matrix.Identity(4)
            full[name] = motion
        stack = np.array([np.array(full[name]) for name in names])          # bones x 4 x 4
        posed = np.einsum("bij,nj->nbi", stack, rest)[:, :, :3]               # vertices x bones x 3
        return np.einsum("nb,nbi->ni", weights, posed)

    def death(self, D):
        """The legs give way (planted, trunk sinking), then the body rolls about a ground line beside the paws onto
        its `side` (+1: its left), the upper legs folding in against it, and settles with the neck and tail laid down.
        Every frame is lowered or raised so the skinned mesh's lowest point lies exactly on the ground."""
        seconds = D["seconds"]
        frames = round(seconds * FPS)
        side = D["side"]
        self.skin_setup()
        record = {"lift": [], "final": None}

        def pose_at(t):
            b = k.smoothstep(0.0, D["buckle"], t)
            r = k.smoothstep(D["buckle"] * 0.6, D["rollEnd"], t)
            s = k.smoothstep(D["rollEnd"] * 0.8, D["settleEnd"], t)
            motions = {}
            self.upper(motions, (0.0, D["back"] * b, -D["sink"] * b), pitch=D["pitch"] * b,
                       neck=tuple(D["neck"][i] * (0.4 * b + 0.6 * s) for i in range(3)), head_yaw=D["headYaw"] * s,
                       tail=[(D["tail"][0] * s, D["tail"][1] * s * (0.5 + 0.5 * index / 3)) for index in range(4)],
                       ear_pitch=D["ears"] * b)
            for key in LEGS:
                self.solve(motions, key, toe=self.legs[key]["P"])
            for key in LEGS:
                if (key[0] == "L") == (side > 0):
                    continue
                leg = self.legs[key]
                top = (motions[f"scapula_{leg['side']}"] if leg["front"] else motions["pelvis"]) @ leg["A"]
                fold = k.rotate_about(top, k.rot(y=-side * D["fold"] * r))
                for bone in leg["chain"]:
                    motions[bone] = fold @ motions[bone]
            roll = k.rotate_about(Vector((side * D["pivot"], 0.0, 0.0)), k.rot(y=side * D["roll"] * r))
            for name in list(motions):
                motions[name] = roll @ motions[name]
            lowest = float(self.skinned(motions)[:, 2].min())
            lift = Matrix.Translation(Vector((0.0, 0.0, -lowest)))
            for name in list(motions):
                motions[name] = lift @ motions[name]
            record["lift"].append(-lowest)
            return motions

        fact = k.bake_clip(self.rig, self.defs, "Death", frames, pose_at)
        final = self.skinned(pose_at(seconds))
        fact.update({"groundLiftMeters": [round(min(record["lift"]), 4), round(max(record["lift"]), 4)],
                     "finalHeightMeters": round(float(final[:, 2].max()), 4),
                     "finalFootprintMeters": [round(float(np.ptp(final[:, 0])), 4), round(float(np.ptp(final[:, 1])), 4)]})
        return fact

    def author(self, R):
        facts = [self.idle(R["idle"])]
        for name in ("Walk", "Run"):
            facts.append(self.gait(name, R["gaits"][name]))
        C = R["attack"]
        facts += [self.windup(C), self.strike(C), self.recovery(C), self.hit(R["hit"]), self.death(R["death"])]
        return facts

# ---------------------------------------------------------------- measurement

def measure(body):
    """Leg columns of the normalized mesh (development aid for landmarks): per quadrant, vertex centroids in height
    bands below the belly."""
    points = k.coords(body)
    report = {"bounds": [points.min(axis=0).round(3).tolist(), points.max(axis=0).round(3).tolist()], "columns": {}}
    mid_y = float(np.median(points[points[:, 2] < 0.3][:, 1]))
    for key in LEGS:
        sign = 1 if key[0] == "L" else -1
        front = key[1] == "F"
        mask = (points[:, 0] * sign > 0.02) & ((points[:, 1] < mid_y) if front else (points[:, 1] > mid_y))
        bands = []
        for z in np.arange(0.02, 1.0, 0.06):
            band = mask & (np.abs(points[:, 2] - z) < 0.03)
            if band.sum() < 6:
                continue
            chosen = points[band]
            bands.append([round(float(z), 2), int(band.sum()), chosen.mean(axis=0).round(3).tolist(),
                          (chosen.max(axis=0) - chosen.min(axis=0)).round(3).tolist()])
        report["columns"][key] = bands
    for z in (0.05, 0.5, 0.9, 1.2):
        band = np.abs(points[:, 2] - z) < 0.02
        if band.any():
            report[f"slice{z}"] = [points[band].min(axis=0).round(3).tolist(), points[band].max(axis=0).round(3).tolist()]
    return report


def sole_pivots(body, locked):
    """Front edge of each hoof's ground contact, from the rigidly locked hoof vertices of the rest mesh."""
    points = k.coords(body)
    pivots = {}
    for key in LEGS:
        hoof = chain_of(key)[-1]
        ids = np.array([vertex for vertex, bone in locked.items() if bone == hoof], dtype=np.int64)
        k.require(len(ids) >= 6, f"{key} hoof has only {len(ids)} locked vertices")
        chosen = points[ids]
        low = chosen[:, 2].min()
        sole = chosen[chosen[:, 2] <= low + 0.012]
        front = sole[sole[:, 1] <= sole[:, 1].min() + 0.015]
        pivots[key] = [round(float(front[:, 0].mean()), 4), round(float(front[:, 1].mean()), 4), round(float(low), 4)]
    return pivots


# ---------------------------------------------------------------- main

def collapse_short_edges(body, min_length, passes=4):
    """Collapse interior edges shorter than `min_length` left by decimation (as cook_troop.py does): their two ends
    take slightly different skin weights, and a millimetre sliver between them then reads as a many-fold stretch in
    motion. UVs are merged with the vertices."""
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


def main():
    k.setup_scene()
    receipt["stage"] = "import"
    body = k.import_single_mesh(args.raw, "body")
    receipt["rawTopology"] = k.topology_report(body)
    receipt["groundSheet"] = g.remove_ground_sheet(body, recipe.get("groundSheet"))
    receipt["normalization"] = k.normalize(body, recipe["heightMeters"], recipe.get("yawDegrees", 0.0), recipe.get("feetFraction", 0.035))
    receipt["cleanup"] = k.clean_mesh(body)
    receipt["specks"] = r.keep_largest(body, recipe.get("minComponentFraction", 0.01))
    receipt["holes"] = r.fill_small_holes(body, recipe.get("fillHoleSides", 12))
    if args.measure:
        receipt["measure"] = measure(body)
        receipt["status"] = "measured"
        return
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
        k.require(recipe["body"].get("albedoGain", 1.0) == 1.0, "quadruped cooks expect albedoGain 1")
        receipt["materials"] = r.bake_body(recipe, high, body, out)
        # k2rig's generic provenance text describes the troops' rear-view projection and tone calibration; the recipe
        # states what this asset's bake actually did.
        k.require("provenance" in recipe["body"], "recipe body.provenance must describe this bake")
        receipt["materials"]["provenance"] = recipe["body"]["provenance"]
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "rig"
    L = recipe["landmarks"]
    defs = skeleton(L)
    rig = k.build_armature(recipe["id"], defs)
    W = recipe["weights"]
    allowed, locked, facts = partition(body, defs, L, W)
    receipt["weights"] = k.bind_heat(body, rig, defs, allowed, locked, relax=W.get("relax", 4), final_relax=W.get("finalRelax", 2))
    receipt["weights"]["regions"] = facts
    receipt["weights"]["pruning"] = r.prune_weights(body, W.get("minWeight", 0.01))
    receipt["rig"] = {"joints": len(defs), "names": list(defs)}
    receipt["stage"] = "clips"
    pivots = sole_pivots(body, locked)
    receipt["rig"]["solePivots"] = pivots
    animal = Quadruped(rig, defs, body, L, pivots)
    receipt["rig"]["pairAlignment"] = {key: round(value, 4) for key, value in animal.align.items()}
    receipt["clips"] = animal.author(recipe)
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
    k.require(sorted(a["name"] for a in doc["animations"]) == sorted(c["name"] for c in receipt["clips"]), "Exported clips differ")
    receipt["output"] = {"file": path.name, "bytes": path.stat().st_size, "sha256": k.sha(path),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cook.blend"))
    receipt["status"] = "cooked-pending-verification" if args.rig_only else "cooked-pending-encoding"
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
