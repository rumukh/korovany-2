"""Cook a korovany-2 resident (a named NPC) in Blender 5.2.2 LTS.

blender -b --factory-startup --python cook_resident.py -- --raw <source.glb> --recipe <recipe.json> --out <new dir>
    [--rig-only] [--debug-maps]

The source is the approved TRELLIS mesh with its approved rear-view projection (project_rear.py). The output
directory must not exist. Writes <id>.glb, cook.json and map previews. The skeleton, weights and body bakes are the
shared humanoid ones in k2rig.py; residents carry no items. This file authors the resident clip set:

  Idle   planted standing loop: two breaths, a slow weight shift and a glance, arms relaxed at the sides
  Talk   planted conversation loop: the same stance with open-hand gestures, nods and a lean toward the listener
No clip moves the root joint, and both loops start and end in the same pose with zero velocity, so the presenter
can cross-fade between them at any time and hold Idle's first frame still under reduced motion.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np

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
           "scripts": {name: k.sha(here / name) for name in ("cook_resident.py", "k2rig.py", "k2cook.py", "k2materials.py")},
           "recipeSha256": k.sha(args.recipe), "rawSha256": k.sha(args.raw)}
started = time.monotonic()
FPS = 60


def frames_of(seconds):
    return max(1, round(seconds * FPS))


def bump(t, start, end):
    """Raised-cosine window: 0 outside [start, end], 1 at its centre, with zero slope at both ends."""
    if t <= start or t >= end:
        return 0.0
    return 0.5 - 0.5 * math.cos(2 * math.pi * (t - start) / (end - start))


def add(a, b, scale=1.0):
    return tuple(x + scale * y for x, y in zip(a, b))


class Resident:
    def __init__(self, rig, defs, body):
        self.rig, self.defs, self.body = rig, defs, body
        self.P = r.Poser(defs, recipe)
        self.C = recipe["clips"]
        H = self.P.H
        C = self.C
        ankle = {side: H[f"foot_{side}"].copy() for side in ("l", "r")}
        self.stance = {side: ankle[side].copy() for side in ("l", "r")}
        for side in ("l", "r"):
            self.stance[side].x = math.copysign(C["stanceHalfWidth"], ankle[side].x)
        self.poses = {name: self.resolve(pose) for name, pose in C["poses"].items()}
        self.facts = []
        self.bends = {}
        self.skirt_gain = tuple(C.get("skirtFollow", (0.8, 0.8)))

    BODY_DEFAULTS = {"offset": (0, 0, 0), "pelvis": (0, 0, 0), "spine": (0, 0, 0), "chest": (0, 0, 0), "head": (0, 0, 0),
                     "neck": (0, 0, 0), "skirt": 0.0}
    ARM_DEFAULTS = {"curl": 30.0, "twist": 0.0, "hand": (0, 0, 0), "clavicle": (0, 0, 0)}

    def resolve(self, pose):
        pose = json.loads(json.dumps(pose))
        for key, value in self.BODY_DEFAULTS.items():
            pose.setdefault(key, value)
        pose.setdefault("sink", self.C["sink"])
        for side in ("l", "r"):
            for key, value in self.ARM_DEFAULTS.items():
                pose[side].setdefault(key, value)
        return pose

    def body_of(self, pose, extra):
        def get(key):
            return add(pose.get(key, (0, 0, 0)), extra.get(key, (0, 0, 0)))

        offset = get("offset")
        offset = (offset[0], offset[1], offset[2] - pose["sink"] - extra.get("sink", 0.0))
        return self.P.body(offset, get("pelvis"), get("spine"), get("chest"), get("head"), get("neck"))

    def arms(self, motion, pose, clip, hands=None):
        """Wrist targets are the pose's (rest chest space) plus per-side offsets; `hands` adds hand eulers and curl,
        and may pull the elbow pole toward a gesture's own (`pole` with its blend weight `poleWeight`)."""
        hands = hands or {}
        for side in ("l", "r"):
            spec = dict(pose[side])
            delta = hands.get(side, {})
            spec["wrist"] = add(spec["wrist"], delta.get("wrist", (0, 0, 0)))
            spec["hand"] = add(spec["hand"], delta.get("hand", (0, 0, 0)))
            spec["twist"] = spec["twist"] + delta.get("twist", 0.0)
            spec["curl"] = spec["curl"] + delta.get("curl", 0.0)
            if "pole" in delta:
                weight = min(1.0, delta.get("poleWeight", 0.0))
                spec["pole"] = add(tuple(c * (1 - weight) for c in spec["pole"]), delta["pole"], weight)
            self.P.arm(motion, side, spec)
        record = self.bends.setdefault(clip, {"l": 0.0, "r": 0.0})
        for side in ("l", "r"):
            record[side] = max(record[side], self.P.wrist_bend(motion, side))
            record[side + "Short"] = max(record.get(side + "Short", 0.0), self.P.reach_short.get(side, 0.0))

    def plant(self, motion):
        for side in ("l", "r"):
            self.P.leg(motion, side, self.stance[side])

    def bake(self, name, seconds, pose_at):
        self.P.reset()
        frames = frames_of(seconds)
        # Warm the solver's continuity over one whole cycle so neighbouring frames solve alike.
        for frame in range(frames + 1):
            pose_at(frame / FPS)
        first = {}

        def evaluate(t):
            # A loop's last frame is its first frame, exactly.
            if "motion" in first and abs(t - frames / FPS) < 1e-6:
                return first["motion"]
            motion = r.clean_motion(pose_at(t))
            if t == 0:
                first["motion"] = motion
            return motion

        fact = k.bake_clip(self.rig, self.defs, name, frames, evaluate)
        fact["loop"] = True
        self.facts.append(fact)
        return fact

    def breathing(self, t, seconds, breaths, sway):
        """Shared standing life: whole breaths and one slow weight shift per loop, each closing on the loop."""
        breath = math.sin(2 * math.pi * breaths * t / seconds)
        shift = math.sin(2 * math.pi * t / seconds)
        glance = math.sin(2 * math.pi * t / seconds + 0.9)
        I = self.C["idle"]
        return {"offset": (I["shift"] * shift * sway, 0, 0), "sink": I["breathSink"] * (1 - math.cos(2 * math.pi * breaths * t / seconds)) / 2,
                "pelvis": (0, I["pelvisTilt"] * shift * sway, I["pelvisTurn"] * shift * sway),
                "spine": (I["spineBreath"] * breath, 0, 0), "chest": (I["chestBreath"] * breath, -0.5 * I["pelvisTilt"] * shift * sway, 0),
                "head": (0.3 * I["chestBreath"] * breath, 0, I["glance"] * glance * sway)}, breath

    def idle(self):
        I = self.C["idle"]
        seconds = I["seconds"]
        base = self.poses[I["pose"]]

        def at(t):
            extra, breath = self.breathing(t, seconds, I["breaths"], 1.0)
            motion = self.body_of(base, extra)
            self.plant(motion)
            lift = (0, 0, I["armBreath"] * breath)
            self.arms(motion, base, "Idle", {"l": {"wrist": lift}, "r": {"wrist": lift}})
            self.P.skirt_follow(motion, self.skirt_gain, base["skirt"])
            return motion

        return self.bake("Idle", seconds, at)

    def talk(self):
        """Conversation loop. Each gesture is a raised-cosine bump of wrist, hand and body offsets over the talk pose,
        so the loop closes exactly and every gesture eases in and out."""
        T = self.C["talk"]
        seconds = T["seconds"]
        base = self.poses[T["pose"]]

        def at(t):
            extra, breath = self.breathing(t, seconds, T["breaths"], T.get("sway", 0.6))
            hands = {"l": {"wrist": (0, 0, T.get("armBreath", 0.006) * breath)}, "r": {"wrist": (0, 0, T.get("armBreath", 0.006) * breath)}}
            for gesture in T["gestures"]:
                weight = bump(t, gesture["start"], gesture["end"])
                if weight == 0.0:
                    continue
                for key in ("pelvis", "spine", "chest", "head", "neck", "offset"):
                    if key in gesture:
                        extra[key] = add(extra.get(key, (0, 0, 0)), gesture[key], weight)
                for side in ("l", "r"):
                    if side not in gesture:
                        continue
                    spec = gesture[side]
                    entry = hands.setdefault(side, {})
                    for key in ("wrist", "hand"):
                        if key in spec:
                            entry[key] = add(entry.get(key, (0, 0, 0)), spec[key], weight)
                    for key in ("twist", "curl"):
                        if key in spec:
                            entry[key] = entry.get(key, 0.0) + spec[key] * weight
                    if "pole" in spec:
                        # The strongest gesture owns the elbow direction; its pull fades with its window.
                        if weight >= entry.get("poleWeight", 0.0):
                            entry["pole"], entry["poleWeight"] = tuple(spec["pole"]), weight
                # Nods ride on the gesture: a quick dip of the head at the gesture's peak.
                if "nod" in gesture:
                    nod = bump(t, gesture["start"] + 0.35 * (gesture["end"] - gesture["start"]), gesture["start"] + 0.75 * (gesture["end"] - gesture["start"]))
                    extra["head"] = add(extra.get("head", (0, 0, 0)), (gesture["nod"], 0, 0), nod)
            motion = self.body_of(base, extra)
            self.plant(motion)
            self.arms(motion, base, "Talk", hands)
            self.P.skirt_follow(motion, self.skirt_gain, base["skirt"])
            return motion

        return self.bake("Talk", seconds, at)

    def author(self, only=None):
        if only is None or "Idle" in only:
            self.idle()
        if only is None or "Talk" in only:
            self.talk()
        for fact in self.facts:
            record = self.bends.get(fact["name"])
            if record:
                fact["maxWristBendDegrees"] = {side: round(record[side], 1) for side in ("l", "r")}
                fact["maxReachShortfallMeters"] = {side: round(record.get(side + "Short", 0.0), 4) for side in ("l", "r")}
        return self.facts


def retint(body, specs):
    """Declared colour repairs of the cooked base colour, after the bake and before the tone lift (the troop cook's
    rule): texels inside a box whose colour matches the rule move toward `target` (sRGB) by `strength`, feathered at
    the mask edge, keeping each texel's luma relative to the masked mean so painted detail survives. For hues TRELLIS
    changed on every seed (Vesk's slate-blue coat became green-grey); a repaint of existing texels, not new detail."""
    image = bpy.data.images["body-base"]
    size = image.size[0]
    position, coverage = m.bake_geometry(body, size, "Position")
    base = m.pixels(image)
    rgb = base[..., :3].copy()
    facts = []
    for spec in specs:
        value = rgb.max(axis=2)
        saturation = (value - rgb.min(axis=2)) / np.maximum(value, 1e-4)
        inside = r.boxes(position, spec) & coverage
        rule = spec.get("colour", {})
        mask = (inside & (value >= rule.get("minValue", 0.0)) & (value <= rule.get("maxValue", 1.0))
                & (saturation >= rule.get("minSaturation", 0.0)) & (saturation <= rule.get("maxSaturation", 1.0)))
        if not mask.any():
            facts.append({"name": spec["name"], "texels": 0})
            continue
        luma = m.luminance(rgb)
        mean_luma = max(float(luma[mask].mean()), 1e-4)
        relative = np.clip(luma / mean_luma, 0.5, 1.6)
        relative = (1 + (relative - 1) * spec.get("keepDetail", 1.0))[..., None]
        target = np.array(spec["target"], dtype=np.float64)
        if spec.get("keepLuma"):
            # Hue and saturation from the concept, brightness from the reconstruction: the calibrated tone lift that
            # follows brightens every texel alike.
            target = target * (mean_luma / max(float(m.luminance(target[None, None, :])[0, 0]), 1e-4))
        edge = spec.get("edgeMeters", 0.0)
        ramp = np.ones(value.shape, dtype=np.float32)
        if edge > 0:
            x, y, z = np.abs(position[..., 0]), position[..., 1], position[..., 2]
            for key, distance in (("zMax", lambda b: b - z), ("zMin", lambda b: z - b), ("xMax", lambda b: b - x),
                                  ("yMax", lambda b: b - y), ("yMin", lambda b: y - b)):
                if key in spec:
                    u = np.clip(distance(spec[key]) / edge, 0, 1)
                    ramp = np.minimum(ramp, u * u * (3 - 2 * u))
        weight = (np.clip(m.blur(mask.astype(np.float32), spec.get("feather", 2)), 0, 1) * inside * ramp)[..., None] * spec["strength"]
        before = rgb[mask].mean(axis=0)
        rgb = rgb * (1 - weight) + np.clip(target * relative, 0, 1) * weight
        facts.append({"name": spec["name"], "texels": int(mask.sum()), "meanBefore": before.round(3).tolist(),
                      "meanAfter": rgb[mask].mean(axis=0).round(3).tolist(), "appliedTarget": target.round(4).tolist(),
                      **{key: spec[key] for key in ("target", "strength", "edgeMeters", "keepDetail", "keepLuma") if key in spec}})
    base[..., :3] = m.fill_gutters(rgb, coverage)
    m.set_pixels(image, base)
    image.pack()
    return facts


def lift_tone(gamma, calibration):
    """Lift the finished base colour (after repairs) by the luma power `gamma` (k2rig.tone_lift: chroma ratios kept,
    channels never clipped)."""
    image = bpy.data.images["body-base"]
    base = m.pixels(image)
    before = float(m.luminance(base[..., :3]).mean())
    base[..., :3] = r.tone_lift(base[..., :3], gamma)
    m.set_pixels(image, base)
    image.pack()
    return {"toneGamma": gamma, "toneCalibration": calibration,
            "toneLift": {"order": "after bake and colour repairs", "meanLumaBefore": round(before, 4),
                         "meanLumaAfter": round(float(m.luminance(base[..., :3]).mean()), 4)}}


def downsample(pixels, size):
    """Box-filter an (h, w, c) float image down to size x size (an integer factor)."""
    factor = pixels.shape[0] // size
    k.require(factor >= 1 and pixels.shape[0] == size * factor and pixels.shape[1] == size * factor, "ORM size must divide the bake")
    return pixels.reshape(size, factor, size, factor, -1).mean(axis=(1, 3)).astype(np.float32)


def thin_animation(path, step):
    """Keep every `step`-th key of every sampler, and the last, so 60 Hz standing loops ship at 60 / step Hz; three.js
    interpolates between keys and the per-frame verifier checks the shipped skin at 60 Hz. Unused accessors are left
    for k.prune_animation to compact."""
    doc, binary = k.read_glb(path)
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    widths = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}
    before = sum(len(views[doc["accessors"][s["output"]]["bufferView"]]) for a in doc.get("animations", []) for s in a["samplers"])

    def floats(index):
        accessor = doc["accessors"][index]
        width = widths[accessor["type"]]
        data = np.frombuffer(views[accessor["bufferView"]], dtype="<f4", count=accessor["count"] * width, offset=accessor.get("byteOffset", 0))
        return data.reshape(accessor["count"], width)

    def append(values, kind, bounds):
        views.append(np.ascontiguousarray(values, dtype="<f4").tobytes())
        doc["bufferViews"].append({"buffer": 0, "byteLength": len(views[-1])})
        accessor = {"bufferView": len(doc["bufferViews"]) - 1, "componentType": 5126, "count": len(values), "type": kind}
        if bounds:
            accessor["min"], accessor["max"] = [float(values.min())], [float(values.max())]
        doc["accessors"].append(accessor)
        return len(doc["accessors"]) - 1

    inputs, after = {}, 0
    for animation in doc.get("animations", []):
        for sampler in animation["samplers"]:
            times = floats(sampler["input"])[:, 0]
            keep = list(range(0, len(times), step))
            if keep[-1] != len(times) - 1:
                keep.append(len(times) - 1)
            if sampler["input"] not in inputs:
                inputs[sampler["input"]] = append(times[keep].reshape(-1, 1), "SCALAR", True)
            output = doc["accessors"][sampler["output"]]
            sampler["output"] = append(floats(sampler["output"])[keep], output["type"], False)
            after += len(views[-1])
            sampler["input"] = inputs[sampler["input"]]
    k.write_glb(path, doc, views)
    return {"step": step, "keyRateHz": 60 / step, "outputBytesBefore": before, "outputBytesAfter": after}


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
        # As in the troop cook: bake uncalibrated, repair declared colours, then lift the tone, so re-tinted texels are
        # lifted like the rest.
        k.require(recipe["body"].get("albedoGain", 1.0) == 1.0, "resident cooks expect albedoGain 1")
        tone_gamma = recipe["body"].get("toneGamma", 1.0)
        bake_recipe = json.loads(json.dumps(recipe))
        bake_recipe["body"].pop("toneGamma", None)
        receipt["materials"] = r.bake_body(bake_recipe, high, body, out, args.debug_maps)
        if recipe["body"].get("retint"):
            receipt["materials"]["retint"] = retint(body, recipe["body"]["retint"])
            receipt["materials"]["provenance"] = receipt["materials"]["provenance"].replace(
                "Artistic derivation", "Declared colour repairs (retint) then move matching texels inside boxes toward "
                "target colours sampled from the approved concept. Artistic derivation")
        if tone_gamma != 1.0:
            receipt["materials"].update(lift_tone(tone_gamma, recipe["body"].get("toneCalibration")))
            receipt["materials"]["provenance"] = receipt["materials"]["provenance"].replace(
                "Artistic derivation", "Base colour then lifted by luma power toneGamma after the repairs (chroma ratios "
                "kept), calibrated in the game against the approved concept. Artistic derivation")
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
        # "free" relaxes across the body-part partition for cloth TRELLIS fused to a limb (a shawl hanging over the
        # forearms), so the hand-over from torso to arm spreads over several rings instead of one row of edges. A list
        # frees only those joints; the others (skirt panels, legs) stay inside their partition.
        free = S.get("free")
        mask = allowed
        if free is True:
            mask = None
        elif free:
            mask = allowed.copy()
            for joint in free:
                if joint in names:
                    mask[:, names.index(joint)] = True
        facts_ = r.soften_seams(body, S.get("iterations", 8), S.get("rings", 4), locked.keys(), mask,
                                None if mask is None else names, S.get("threshold", 0.6), S.get("zRange"))
        receipt["weights"]["seams"].append({**facts_, "free": free or False})
    receipt["weights"]["pruning"] = r.prune_weights(body, W.get("minWeight", 0.01))
    receipt["rig"] = {"joints": len(defs), "names": list(defs)}
    receipt["stage"] = "clips"
    only = set(recipe.get("developmentClips", [])) or None if args.rig_only else None
    receipt["clips"] = Resident(rig, defs, body).author(only)
    receipt["stage"] = "export"
    path = out / f"{recipe['id']}.glb"
    k.export_glb(path, [rig, body], tangents=not args.rig_only)
    if not args.rig_only:
        np.save(out / "body-base.npy", m.pixels(bpy.data.images["body-base"]))
        receipt["baseEncoding"] = {"pending": ["body-base"], "encoder": "webp_exact.py"}
        orm = m.pixels(bpy.data.images["body-orm"])
        orm_size = recipe.get("ormSize", orm.shape[0])
        k.replace_images(path, {"body-orm": m.encode_webp(downsample(orm, orm_size), out / "body-orm.webp", recipe["ormQuality"], "Non-Color")})
        receipt["ormSize"] = orm_size
    if recipe.get("animationKeyStep", 1) > 1:
        receipt["animationThinning"] = thin_animation(path, recipe["animationKeyStep"])
    receipt["animationPruning"] = k.prune_animation(path)
    doc, _ = k.read_glb(path)
    k.require(len(doc.get("skins", [])) == 1, "Export did not retain one skin")
    k.require(sorted(a["name"] for a in doc["animations"]) == sorted(c["name"] for c in receipt["clips"]), "Exported clips differ")
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
