"""Cook the Korovany II crows, small skinned birds for version 3 worlds, in Blender 5.2.2 LTS from approved TRELLIS meshes.

blender -b --factory-startup --python cook_crow.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
    [--rig-only] [--measure]

One script, two recipes: the perched crow (`pose: perched`, clips Perch and Peck) and the crow in flight (`pose: flight`,
clips Fly, Glide and TakeOff). The view shows one or the other and swaps them at take-off and landing. The shared helpers
k2cook.py, k2materials.py, k2rig.py and k2sheet.py come from scripts/models/pipeline, unchanged; the flow follows
cook_sheep.py (also unchanged). Weights are region-constrained distance weights (k2cook.bind): TRELLIS fuses the folded
wings into the body, and the bird is about 20-40 pixels tall in play, so the rig is small. Coordinates are cooked metres
on Blender axes: +Z up, the bird faces -Y, its left is +X; the glTF exporter converts once to the game's +Y up / +Z forward.

Clips (no root motion; the view moves the bird):
  Perch    planted breathing loop: the head looks about, the tail flicks
  Peck     planted loop: the body tips forward about the hips and the beak strikes the ground twice
  Fly      flapping loop at about 3 beats a second; the wing tips lag the arms, the body bobs against the stroke
  Glide    wings held in a shallow dihedral with a slow sway
  TakeOff  one-shot of fast, deep beats with the body pitched up
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
parser.add_argument("--measure", action="store_true", help="report slices of the normalized mesh and stop")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
k.require(recipe.get("schema") == "korovany2-bird-recipe/1", "Expected a korovany2-bird-recipe/1 recipe")
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
here = Path(__file__).parent
receipt = {"schema": "korovany2-bird-cook/1", "status": "running", "asset": recipe["id"], "pose": recipe["pose"], "blender": k.blender_facts(),
           "scripts": {"cook_crow.py": k.sha(here / "cook_crow.py"),
                       **{name: k.sha(SHARED / name) for name in ("k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py")}},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()
FPS = 60


# ---------------------------------------------------------------- skeletons

def perched_skeleton(L):
    defs = {}

    def add(name, head, tail, parent, deform=True):
        defs[name] = (tuple(head), tuple(tail), parent, deform)

    add("root", (0, 0, 0), (0, -0.1, 0), None, False)
    add("legs", L["feet"], L["hip"], "root")
    add("body", L["hip"], L["chest"], "legs")
    add("neck", L["chest"], L["poll"], "body")
    add("head", L["poll"], L["beak"], "neck")
    add("tail", L["tailBase"], L["tailTip"], "body")
    return defs


def flight_skeleton(L):
    defs = {}

    def add(name, head, tail, parent, deform=True):
        defs[name] = (tuple(head), tuple(tail), parent, deform)

    add("root", (0, 0, 0), (0, -0.1, 0), None, False)
    add("body", L["tailBase"], L["chest"], "root")
    add("head", L["chest"], L["beak"], "body")
    add("tail", L["tailBase"], L["tailTip"], "body")
    for side, sign in (("l", 1), ("r", -1)):
        shoulder, elbow, tip = (Vector(L[name]) * Vector((sign, 1, 1)) for name in ("shoulder", "elbow", "wingTip"))
        add(f"wing_{side}", shoulder, elbow, "body")
        add(f"tip_{side}", elbow, tip, f"wing_{side}")
    return defs


def perched_regions(points, defs, L, W):
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    index = {name: column for column, name in enumerate(names)}
    allowed = np.zeros((len(points), len(names)), dtype=bool)
    legs = points[:, 2] < L["hip"][2] - W["legsBelowHip"]
    head = ~legs & (points[:, 1] < L["poll"][1] + W["headMargin"]) & (points[:, 2] > L["chest"][2] - W["headDrop"])
    tail = ~legs & ~head & (points[:, 1] > L["tailBase"][1] - W["tailMargin"])
    body = ~legs & ~head & ~tail
    for mask, bones in ((legs, ("legs",)), (head, ("neck", "head")), (tail, ("body", "tail")), (body, ("body", "neck", "legs"))):
        for bone in bones:
            allowed[mask, index[bone]] = True
    return allowed, {"legs": int(legs.sum()), "head": int(head.sum()), "tail": int(tail.sum()), "body": int(body.sum())}


def flight_regions(points, defs, L, W):
    """The tail fan (everything behind the wings' trailing edge), the head ahead of the chest, the body between the wing
    roots, and each wing outside them; arms blend into the body at the shoulder and into the hands at the wrist."""
    names = [name for name, (_, _, _, deform) in defs.items() if deform]
    index = {name: column for column, name in enumerate(names)}
    allowed = np.zeros((len(points), len(names)), dtype=bool)
    half, x = W["bodyHalfWidth"], points[:, 0]
    tail = points[:, 1] > L["tailBase"][1] + W["tailStart"]
    head = ~tail & (np.abs(x) <= half) & (points[:, 1] < L["chest"][1] + W["headMargin"])
    centre = ~tail & ~head & (np.abs(x) <= half)
    facts = {"head": int(head.sum()), "tail": int(tail.sum()), "body": int(centre.sum())}
    for mask, bones in ((head, ("body", "head")), (tail, ("body", "tail")), (centre, ("body",))):
        for bone in bones:
            allowed[mask, index[bone]] = True
    for side, sign in (("l", 1), ("r", -1)):
        near = x * sign
        allowed[centre & (near > half - W["shoulderBlend"]), index[f"wing_{side}"]] = True
        wing = ~tail & ~head & (near > half)
        allowed[wing, index[f"wing_{side}"]] = True
        allowed[wing & (near < half + W["shoulderBlend"]), index["body"]] = True
        allowed[wing & (near > L["elbow"][0] - W["elbowBlend"]), index[f"tip_{side}"]] = True
        facts[f"wing_{side}"] = int(wing.sum())
    return allowed, facts


# ---------------------------------------------------------------- motion

def osc(amplitude, u, harmonic=1, phase=0.0):
    return amplitude * math.sin(2 * math.pi * (harmonic * u - phase))


def pulse(t, start, length):
    if length <= 0 or t <= start or t >= start + length:
        return 0.0
    return math.sin(math.pi * (t - start) / length) ** 2


class Bird:
    def __init__(self, rig, defs):
        self.rig, self.defs = rig, defs
        self.rest = {name: (Vector(head), Vector(tail)) for name, (head, tail, _, _) in defs.items()}

    def at(self, bone):
        return self.rest[bone][0]

    def perched(self, motions, body=0.0, bob=0.0, neck=0.0, head=0.0, look=0.0, tail=0.0):
        # Positive pitch tips the front down (k2cook.rot: +X rotation tips +Z toward -Y, the bird's front).
        motions["legs"] = Matrix.Identity(4)
        motions["body"] = Matrix.Translation((0, 0, bob)) @ k.rotate_about(self.at("body"), k.rot(x=body))
        motions["neck"] = motions["body"] @ k.rotate_about(self.at("neck"), k.rot(x=neck, z=look * 0.4))
        motions["head"] = motions["neck"] @ k.rotate_about(self.at("head"), k.rot(x=head, z=look * 0.6))
        motions["tail"] = motions["body"] @ k.rotate_about(self.at("tail"), k.rot(x=tail))
        return motions

    def flight(self, motions, wing=0.0, tip=0.0, pitch=0.0, roll=0.0, bob=0.0, head=0.0, tail=0.0, sweep=0.0):
        """`wing` and `tip` raise the arms and the outer wings in degrees (positive up); `sweep` swings them back."""
        motions["body"] = Matrix.Translation((0, 0, bob)) @ k.rotate_about(self.at("body"), k.rot(x=pitch, y=roll))
        motions["head"] = motions["body"] @ k.rotate_about(self.at("head"), k.rot(x=head))
        motions["tail"] = motions["body"] @ k.rotate_about(self.at("tail"), k.rot(x=tail))
        for side, sign in (("l", 1), ("r", -1)):
            # About +Y, a positive angle carries +X downward: the left wing rises with a negative angle.
            arm = motions["body"] @ k.rotate_about(self.at(f"wing_{side}"), k.rot(y=-sign * wing, z=sign * sweep))
            motions[f"wing_{side}"] = arm
            motions[f"tip_{side}"] = arm @ k.rotate_about(self.at(f"tip_{side}"), k.rot(y=-sign * tip))
        return motions

    def bake(self, name, seconds, pose_at):
        return k.bake_clip(self.rig, self.defs, name, round(seconds * FPS), pose_at)


def author_perched(bird, C):
    P, K = C["perch"], C["peck"]

    def perch(t):
        u = t / P["seconds"]
        look = sum(P["lookDegrees"][i] * pulse(t, start, P["lookSeconds"]) for i, start in enumerate(P["lookAt"]))
        tail = sum(pulse(t, start, P["flickSeconds"]) for start in P["flickAt"]) * P["flickDegrees"]
        return bird.perched({}, body=osc(P["breathDegrees"], u, 3), bob=osc(P["bob"], u, 3), neck=osc(P["neckDegrees"], u, 2, 0.2),
                            head=osc(P["headDegrees"], u, 1, 0.4), look=look, tail=tail)

    def peck(t):
        u = t / K["seconds"]
        # Tip forward over the first fifth, two strikes at the bottom, back up over the last fifth.
        down = min(1.0, k.smoothstep(0.0, 0.2, u) * 1.0) * (1 - k.smoothstep(0.8, 1.0, u))
        strikes = sum(pulse(u, start, K["strikeLength"]) for start in K["strikesAt"])
        return bird.perched({}, body=K["bodyDegrees"] * down, neck=K["neckDegrees"] * down + K["strikeNeck"] * strikes,
                            head=K["headDegrees"] * down + K["strikeHead"] * strikes, tail=-K["tailDegrees"] * down,
                            look=osc(K["lookDegrees"], u))

    return [bird.bake("Perch", P["seconds"], perch), bird.bake("Peck", K["seconds"], peck)]


def author_flight(bird, C):
    F, G, T = C["fly"], C["glide"], C["takeOff"]

    def beat(spec, t, period):
        u = t / period
        wing = spec["wingBias"] + osc(spec["wingDegrees"], u)
        tip = spec["tipBias"] + osc(spec["tipDegrees"], u, 1, spec["tipLag"])
        # The body rises on the downstroke and sinks on the upstroke.
        bob = -osc(spec["bob"], u, 1, spec.get("bobLag", 0.25))
        return wing, tip, bob, u

    def fly(t):
        wing, tip, bob, u = beat(F, t, F["seconds"])
        return bird.flight({}, wing=wing, tip=tip, bob=bob, pitch=F["pitch"] + osc(F["pitchDegrees"], u, 1, 0.1),
                           tail=osc(F["tailDegrees"], u, 1, 0.3), sweep=F["sweep"] * (0.5 - 0.5 * math.cos(2 * math.pi * u)))

    def glide(t):
        u = t / G["seconds"]
        return bird.flight({}, wing=G["wingBias"] + osc(G["wingDegrees"], u), tip=G["tipBias"] + osc(G["tipDegrees"], u, 1, 0.15),
                           roll=osc(G["rollDegrees"], u, 1, 0.3), pitch=G["pitch"], tail=osc(G["tailDegrees"], u, 2))

    def take_off(t):
        period = T["beatSeconds"]
        wing, tip, bob, _ = beat(T, t, period)
        rise = k.smoothstep(0.0, 0.25, t / T["seconds"])
        return bird.flight({}, wing=wing, tip=tip, bob=bob, pitch=T["pitch"] * rise, tail=T["tailDegrees"] * rise,
                           head=-T["pitch"] * 0.5 * rise, sweep=T["sweep"] * (0.5 - 0.5 * math.cos(2 * math.pi * t / period)))

    facts = [bird.bake("Fly", F["seconds"], fly), bird.bake("Glide", G["seconds"], glide), bird.bake("TakeOff", T["seconds"], take_off)]
    facts[0]["beatsPerSecond"] = round(1 / F["seconds"], 3)
    facts[2]["beatsPerSecond"] = round(1 / T["beatSeconds"], 3)
    return facts


# ---------------------------------------------------------------- measurement

def measure(body):
    """Slices of the normalized mesh along each axis (development aid for landmarks)."""
    points = k.coords(body)
    lo, hi = points.min(axis=0), points.max(axis=0)
    report = {"bounds": [lo.round(3).tolist(), hi.round(3).tolist()], "slices": {}}
    for axis, name in ((0, "x"), (1, "y"), (2, "z")):
        rows = []
        for a in np.linspace(lo[axis], hi[axis], 13)[:-1]:
            step = (hi[axis] - lo[axis]) / 12
            band = (points[:, axis] >= a) & (points[:, axis] < a + step)
            if band.sum() < 3:
                continue
            chosen = points[band]
            rows.append([round(float(a + step / 2), 3), int(band.sum()), chosen.min(axis=0).round(3).tolist(), chosen.max(axis=0).round(3).tolist()])
        report["slices"][name] = rows
    return report


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
    receipt["uvAfter"] = m.uv_report(body)
    for polygon in body.data.polygons:
        polygon.use_smooth = True
    receipt["topology"] = k.topology_report(body)
    k.require(receipt["topology"]["triangles"] <= recipe["triangleBudget"], "Body exceeds its triangle budget")
    receipt["stage"] = "materials"
    if args.rig_only:
        receipt["materials"] = {"skipped": "rig-only development cook; source material kept"}
    else:
        k.require(recipe["body"].get("albedoGain", 1.0) == 1.0, "bird cooks expect albedoGain 1 (use toneGamma)")
        receipt["materials"] = r.bake_body(recipe, high, body, out)
        k.require("provenance" in recipe["body"], "recipe body.provenance must describe this bake")
        receipt["materials"]["provenance"] = recipe["body"]["provenance"]
    bpy.data.objects.remove(high, do_unlink=True)
    receipt["stage"] = "rig"
    L, W = recipe["landmarks"], recipe["weights"]
    perched = recipe["pose"] == "perched"
    defs = perched_skeleton(L) if perched else flight_skeleton(L)
    rig = k.build_armature(recipe["id"], defs)
    allowed, facts = (perched_regions if perched else flight_regions)(k.coords(body), defs, L, W)
    receipt["weights"] = k.bind(body, rig, defs, allowed, relax=W.get("relax", 12), falloff=W.get("falloff", 0.02))
    receipt["weights"]["regions"] = facts
    receipt["weights"]["pruning"] = r.prune_weights(body, W.get("minWeight", 0.01))
    receipt["rig"] = {"joints": len(defs), "names": list(defs)}
    receipt["stage"] = "clips"
    bird = Bird(rig, defs)
    receipt["clips"] = author_perched(bird, recipe["clips"]) if perched else author_flight(bird, recipe["clips"])
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
