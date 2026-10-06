"""Assemble portable provenance and approval records for Korovany II version 3 world assets.

    python assemble_world_provenance.py <asset-id> [...]          (models: W0-W2 kits, W0 and W3 nature, W3b reeds, props, sheep, crows, deer, goats)
    python assemble_world_provenance.py --surfaces                  (every surface layer)

Reads the authoring folders under the authoring root, $K2_AUTHORING (cook receipts, generation receipts, review records),
and writes scripts/world/assets/<id>/{provenance.json, approval.json, concept.png} and
scripts/world/textures/<id>/provenance.json. Concept images are re-encoded from pixels only (no metadata). Host paths are
never written. Script digests are SHA-256 of LF-normalised text, equal to the committed copies.
"""
import hashlib
import io
import json
import os
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[3]
if not os.environ.get("K2_AUTHORING"):
    raise SystemExit("Set K2_AUTHORING to the authoring root.")
AUTHORING = Path(os.environ["K2_AUTHORING"])
MODELS_PIPELINE = REPO / "scripts" / "models" / "pipeline"
WORLD_PIPELINE = REPO / "scripts" / "world" / "pipeline"
TRELLIS_LICENSE = ("Derived from TRELLIS-image-large output. TRELLIS's textured GLB export depends on components licensed for "
                   "research and evaluation only (Gaussian export, diffoctreerast); no commercial clearance is established. "
                   "The owner acknowledged publishing TRELLIS-derived assets on the public Korovany II site on 2026-09-26.")
AZURE_TOOL = {"name": "Azure OpenAI gpt-image-2.5-sunburst", "runtime": "Azure OpenAI image generation (cloud)",
              "role": "concept art", "approval": "Owner approved cloud concept generation for in-game objects on 2026-10-04."}
TRELLIS_TOOL = {"name": "TRELLIS-image-large", "model": "microsoft/TRELLIS-image-large",
                "modelRevision": "25e0d31ffbebe4b5a97464dd851910efc3002d96", "offline": True,
                "licensing": {"wholeToolchainMit": False, "commercialClearanceEstablished": False}}
BLENDER_TOOL = {"name": "Blender 5.2.2 LTS", "build": "d13f752e3b9c", "role": "generation, cooking, rigging and bakes (CPU Cycles)"}
QWEN_TOOL = {"name": "Qwen Image Edit Plus 2511", "runtime": "WanGP (local, CLI)", "checkpoint": "qwen_image_edit_plus2_20B_quanto_bf16_int8",
             "steps": 50, "guidanceScale": 4.0, "role": "surface texture from a scripted layout swatch"}
MESHOPT = {"name": "meshoptimizer 0.22.0 (npm)", "role": "lossless EXT_meshopt_compression"}


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_text(path: Path) -> str:
    return sha_bytes(path.read_text(encoding="utf-8").replace("\r\n", "\n").encode())


def script_digests(names):
    out = {}
    for name in names:
        path = WORLD_PIPELINE / name if (WORLD_PIPELINE / name).exists() else MODELS_PIPELINE / name
        prefix = "world/pipeline/" if path.parent == WORLD_PIPELINE else "models/pipeline/"
        out[prefix + name] = sha_text(path)
    return out


def write_json(path: Path, value) -> None:
    text = json.dumps(value, indent=1, ensure_ascii=False) + "\n"
    if "C:\\" in text or "/Users/" in text or ":\\\\" in text:
        raise SystemExit(f"host path in {path.name}")
    path.write_bytes(text.encode())


def portable(text: str) -> str:
    return text.replace(str(AUTHORING), "<authoring>").replace(str(AUTHORING).replace("\\", "/"), "<authoring>")


def strip_png(source: Path, target: Path) -> str:
    image = Image.open(source).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    target.write_bytes(buffer.getvalue())
    return sha_bytes(buffer.getvalue())


def review(asset: str, gate: str):
    path = AUTHORING / asset / "reviews" / f"{gate}-gate.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def model(asset: str, kind: str, cook_dir: Path, scripts, glb: Path, extra=None):
    out = REPO / "scripts" / "world" / "assets" / asset
    out.mkdir(parents=True, exist_ok=True)
    data = glb.read_bytes()
    shipped = REPO / "public" / "world" / asset / f"{asset}.glb"
    if shipped.read_bytes() != data:
        raise SystemExit(f"{asset}: public GLB differs from the cook output")
    provenance = {"schema": "korovany2-world-asset/1", "id": asset, "kind": kind,
                  "output": {"file": f"public/world/{asset}/{asset}.glb", "sha256": sha_bytes(data), "bytes": len(data)}}
    provenance.update(extra or {})
    provenance["cook"] = {"scripts": script_digests(scripts), "scriptsNote": "SHA-256 of each script with LF line endings, equal to its committed copy."}
    receipt = cook_dir / "cook.json"
    if receipt.exists():
        cook = json.loads(receipt.read_text(encoding="utf-8"))
        for key in ("normalization", "topology", "decimation", "materials", "clips", "rig", "weights", "geometryCompression",
                    "staticQuantization", "quantization", "baseEncoding", "tangentRepair", "seconds"):
            if key in cook:
                provenance["cook"][key] = json.loads(portable(json.dumps(cook[key], default=str)))
    write_json(out / "provenance.json", provenance)
    return provenance


def shipped_cook(asset: str, glb_name: str) -> str:
    """The cook revision whose output is byte-identical to the shipped GLB (W1 props went through several revisions)."""
    shipped = (REPO / "public" / "world" / asset / f"{asset}.glb").read_bytes()
    for folder in sorted((AUTHORING / asset / "cook").iterdir()):
        if (folder / glb_name).is_file() and (folder / glb_name).read_bytes() == shipped:
            return folder.name
    raise SystemExit(f"{asset}: no cook revision produced the shipped {glb_name}")


def trellis_asset(asset: str, kind: str, cook: str, glb_name: str, scripts, limitations):
    cook_dir = AUTHORING / asset / "cook" / cook
    concept_gate = review(asset, "concept")
    candidate = concept_gate["candidate"]
    out = REPO / "scripts" / "world" / "assets" / asset
    out.mkdir(parents=True, exist_ok=True)
    concept_sha = strip_png(AUTHORING / asset / "concepts" / f"candidate-{candidate}.png", out / "concept.png")
    recipe = json.loads((out / "recipe.json").read_text(encoding="utf-8"))
    raw = AUTHORING / asset / "raw" / recipe["source"]["candidate"] / "generation.json"
    generation = json.loads(raw.read_text(encoding="utf-8"))
    prompt = (AUTHORING / asset / "concepts" / "prompt.txt").read_text(encoding="utf-8")
    (out / "concept-prompt.txt").write_bytes(prompt.replace("\r\n", "\n").encode())
    trellis = dict(TRELLIS_TOOL, seed=recipe["source"]["seed"], inferenceSeconds=round(generation.get("elapsedSeconds", 0), 1),
                   output={"sha256": generation["output"]["sha256"], "bytes": generation["output"]["bytes"]})
    model_gate, ingame_gate = review(asset, "model"), review(asset, "in-game")
    if not model_gate or not ingame_gate:
        raise SystemExit(f"{asset}: model and in-game gate records are required")
    extra = {"license": TRELLIS_LICENSE, "tools": [AZURE_TOOL, trellis, BLENDER_TOOL, MESHOPT],
             "source": {"concept": {"candidate": candidate, "sha256": concept_sha, "note": "Pixels of the accepted Azure candidate, re-encoded without metadata."},
                        "trellis": {"candidate": recipe["source"]["candidate"], "sha256": generation["output"]["sha256"]}},
             "limitations": limitations + model_gate.get("limitations", [])}
    provenance = model(asset, kind, cook_dir, scripts, cook_dir / glb_name, extra)
    approval = {"schema": "korovany2-world-approval/1", "asset": asset, "delegation": "_reviews/delegation-2026-10-04-world.json",
                "decisions": [
                    {"gate": "concept", "decision": "accepted", "candidate": candidate, "sha256": concept_sha, "rationale": concept_gate["rationale"]},
                    {"gate": "model", "decision": model_gate["decision"], "sha256": provenance["output"]["sha256"],
                     "rationale": model_gate["rationale"], **gate_limits(model_gate)},
                    {"gate": "in-game", "decision": ingame_gate["decision"], "sha256": provenance["output"]["sha256"],
                     "rationale": ingame_gate["rationale"], **gate_limits(ingame_gate)}]}
    write_json(out / "approval.json", approval)


def gate_limits(record) -> dict:
    """A gate's recorded limitations, for the approval (W0 gate records have none)."""
    return {"limitations": record["limitations"]} if record.get("limitations") else {}


def generated_asset(asset: str, kind: str, kit: str, revision: str, script: str, limitations, scripts=None,
                    barks=("bark-spruce", "bark-birch")):
    cook_dir = AUTHORING / kit / "cook" / revision / asset
    source = {"generator": f"world/pipeline/{script}"}
    if kind == "tree" and barks:
        # The impostor cards are rendered from the shipped bark layers; record the exact images the cook read.
        surfaces = REPO / "public" / "world" / "surfaces"
        source["impostorBarkAlbedo"] = {name: sha_bytes((surfaces / f"{name}-albedo.webp").read_bytes()) for name in barks}
    gates = {gate: review(kit, f"{asset}-{gate}") for gate in ("model", "in-game")}
    for gate, record in gates.items():
        if not record:
            raise SystemExit(f"{asset}: the {gate} gate record is required")
    extra = {"license": "Original geometry generated by a committed Blender script for Korovany II; no third-party model or image. "
                        "Surfaces come from the world surface layers (see scripts/world/textures).",
             "tools": [BLENDER_TOOL, MESHOPT], "source": source, "limitations": limitations + gates["model"].get("limitations", [])}
    provenance = model(asset, kind, cook_dir, scripts or [script, "meshopt_glb.mjs"], cook_dir / f"{asset}.glb", extra)
    out = REPO / "scripts" / "world" / "assets" / asset
    write_json(out / "approval.json", {"schema": "korovany2-world-approval/1", "asset": asset,
                                       "delegation": "_reviews/delegation-2026-10-04-world.json",
                                       "decisions": [{"gate": gate, "decision": record["decision"], "sha256": provenance["output"]["sha256"],
                                                      "rationale": record["rationale"], **gate_limits(record)} for gate, record in gates.items()]})


def surfaces():
    import subprocess
    import tempfile
    root = REPO / "scripts" / "world" / "textures"
    published = REPO / "public" / "world" / "surfaces"
    swatch_script = WORLD_PIPELINE / "make_surface_swatch.py"
    for folder in sorted(root.iterdir()):
        recipe = json.loads((folder / "recipe.json").read_text(encoding="utf-8"))
        layer = recipe["layer"]
        cook = json.loads((folder / "cook.json").read_text(encoding="utf-8"))
        if cook["recipeSha256"] != sha_text(folder / "recipe.json"):
            raise SystemExit(f"{layer}: cooked from a different recipe; re-cook it")
        if cook["scriptSha256"] != sha_text(WORLD_PIPELINE / "cook_surface.py"):
            raise SystemExit(f"{layer}: cooked by a different cook_surface.py; re-cook it")
        outputs = {}
        for map_name in ("albedo", "height"):
            data = (published / f"{layer}-{map_name}.webp").read_bytes()
            if cook["outputs"][f"{layer}-{map_name}.webp"]["sha256"] != sha_bytes(data):
                raise SystemExit(f"{layer}: shipped {map_name} differs from its cook receipt")
            outputs[map_name] = {"file": f"public/world/surfaces/{layer}-{map_name}.webp", "sha256": sha_bytes(data), "bytes": len(data)}
        derived = recipe.get("derivedFrom")
        seed = cook["candidate"].removeprefix("candidate-").removesuffix(".png")
        decision_path = AUTHORING / (derived or recipe["id"]) / "reviews" / f"candidate-{seed}.json"
        if not cook["candidate"].startswith("candidate-") or not decision_path.exists():
            raise SystemExit(f"{layer}: shipped from {cook['candidate']}, which has no candidate decision record")
        decision = json.loads(decision_path.read_text(encoding="utf-8"))
        if decision["decision"] != "accepted":
            raise SystemExit(f"{layer}: candidate {seed} was {decision['decision']}")
        source_id = derived or recipe["id"]
        generation = json.loads((AUTHORING / source_id / "concepts" / f"candidate-{seed}.json").read_text(encoding="utf-8"))
        if str(generation["seed"]) != seed or generation["steps"] != QWEN_TOOL["steps"] or generation["guidance_scale"] != QWEN_TOOL["guidanceScale"]:
            raise SystemExit(f"{layer}: candidate {seed} was not generated with the recorded Qwen settings")
        source = {"recipe": "recipe.json", "candidate": cook["candidate"], "candidateSha256": cook["candidateSha256"],
                  "seed": generation["seed"], "generationSeconds": round(generation["generation_seconds"], 1)}
        if derived:
            source["derivedFrom"] = derived
        else:
            # The layout this candidate was generated from is redrawn from the committed recipe and script, byte for byte.
            with tempfile.TemporaryDirectory() as temp:
                redrawn = Path(temp) / "layout.png"
                subprocess.run([sys.executable, str(swatch_script), str(folder / "recipe.json"), str(redrawn)], check=True, capture_output=True)
                layout = sha_bytes(redrawn.read_bytes())
            if layout != sha_bytes((AUTHORING / source_id / "concepts" / "layout.png").read_bytes()):
                raise SystemExit(f"{layer}: the committed recipe no longer redraws the layout that generated candidate {seed}")
            source["layoutSha256"] = layout
        provenance = {"schema": "korovany2-world-surface/1", "id": recipe["id"], "layer": layer, "outputs": outputs,
                      "license": "Generated locally for Korovany II with Qwen Image Edit Plus 2511 (WanGP) from an original scripted "
                                 "layout swatch; no photograph or third-party texture.",
                      "tools": [QWEN_TOOL],
                      "source": source,
                      "approval": {"gate": "candidate", "decision": "accepted", "rationale": decision["rationale"],
                                   **({"limitations": decision["limitations"]} if decision.get("limitations") else {}),
                                   "delegation": "_reviews/delegation-2026-10-04-world.json"},
                      "cook": {"scripts": script_digests(["cook_surface.py", "make_surface_swatch.py"]), "steps": cook["steps"],
                               "albedoMeanSrgb": cook["albedoMeanSrgb"]}}
        write_json(folder / "provenance.json", provenance)


W0_PROPS = {"prop-haystack", "prop-woodpile", "prop-barrels", "prop-scarecrow", "prop-hay-cart"}
W1_KIT = {"kit-stonehouse", "kit-brickhouse", "kit-townhouse-a", "kit-townhouse-b", "kit-inn", "kit-stable", "kit-chapel",
          "kit-chapel-fen", "kit-smithy", "kit-watchtower", "kit-stall", "kit-stilthut", "kit-saltshed", "kit-boathut", "kit-kiln",
          "kit-wall"}
W1_KIT_REVISION = "r1"
W2_KIT = {"kit-curtain", "kit-curtain-ruin", "kit-tower-round", "kit-tower-square", "kit-tower-ruin", "kit-keep", "kit-gate-arch",
          "kit-ruin-chapel", "kit-ruin-house", "kit-camp-tower"}
W2_KIT_REVISION = "r1"
# W3a: build_nature_w3.py (which imports build_nature.py's helpers unchanged) cooks the dark-forest species, re-cooks the W0
# trees with a middle level of detail, and builds the undergrowth, the crags and the forest floor.
W3_TREES = {"tree-spruce", "tree-birch", "tree-deadoak", "tree-blackpine", "tree-twistedoak", "tree-deadbirch"}
W3_PLANTS = {"plant-bracken", "plant-bramble"}
W3_CRAGS = {f"rock-crag-{style}-{shape}" for style in ("moss", "snow", "bare") for shape in "abcd"}
W3_FLOOR = {"rock-mossy", "wood-log", "wood-stump"}
W3_NATURE = W3_TREES | W3_PLANTS | W3_CRAGS | W3_FLOOR
W3_NATURE_REVISION = "r1"
W3_TREE_LIMITS = ["Scripted trees with alpha-tested cards: no wind motion, no subsurface or translucency; a middle level of detail "
                  "(fewer rings, sides and cards) from 24 m and crossed-card impostors beyond 58 m.",
                  "Black pine crowns are clumps of needle cards, not modelled shoots; twisted and dead oaks carry only a few dead "
                  "leaves; oaks use the pine or spruce bark layer, there is no oak bark."]
W3_LIMITS = {
    "plant": ["Undergrowth is alpha-tested cards on a few stems with a 128 px impostor: no wind motion, and it is presentation "
              "only (the hero walks through it)."],
    "crag": ["Crags are overlapping convex blocks with flat facets and sharp edges: no overhangs, caves, gullies or eroded "
             "detail; grain and weathering are in the cliff surface layer.",
             "Snow and moss lie on whole upward facets, so their edges follow the facets; the talus is a ring of granite rubble "
             "blocks, not loose scree."],
    "floor": ["Fallen logs and stumps are scripted tubes with splintered ends: no peeling bark, rot or hollow cores; boulders "
              "are displaced primitives with moss on their upper faces."],
}
# W3b: build_nature_w3b.py (which imports build_nature_w3.py and build_nature.py unchanged) cooks the reed beds.
W3B_PLANTS = {"plant-reeds"}
W3B_NATURE_REVISION = "r1"
W3B_LIMITS = ["Reed beds are alpha-tested cards with a 128 px impostor: no wind motion, no reflection in the water, and they are "
              "presentation only (the hero walks through them on the bank)."]


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--surfaces" in args:
        surfaces()
    PROP_LIMITS = ["Single-view TRELLIS reconstruction from one approved concept: the far side, back and underside are TRELLIS's invention.",
                   "Roughness and metalness come from colour classes and Cycles bakes, not measured PBR."]
    for asset in args:
        if asset in W0_PROPS:
            trellis_asset(asset, "prop", "r2", f"{asset}-albedo512.glb",
                          ["cook_landmark.py", "k2cook.py", "k2materials.py", "k2sheet.py", "repair_tangents.py", "quantize_prop_glb.py", "meshopt_glb.mjs"],
                          PROP_LIMITS)
        elif asset.startswith("prop-"):
            size = json.loads((REPO / "scripts" / "world" / "assets" / asset / "recipe.json").read_text(encoding="utf-8"))["albedoSizes"][0]
            glb_name = f"{asset}-albedo{size}.glb"
            trellis_asset(asset, "prop", shipped_cook(asset, glb_name), glb_name,
                          ["cook_landmark.py", "k2cook.py", "k2materials.py", "k2sheet.py", "repair_tangents.py", "quantize_prop_glb.py", "meshopt_glb.mjs"],
                          PROP_LIMITS)
        elif asset == "char-sheep":
            # W2 recooked the sheep at 512 px (texture memory); the shipped bytes name their revision.
            trellis_asset(asset, "fauna", shipped_cook(asset, "char-sheep.glb"), "char-sheep.glb",
                          ["cook_sheep.py", "k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py", "webp_exact.py", "quantize_glb.py", "meshopt_glb.mjs"],
                          PROP_LIMITS + ["Clips are procedural (IK gaits, oscillators), not motion capture; there is no blending of grazing into walking."])
        elif asset in ("char-deer", "char-goat"):
            # W3b: cook_quadruped.py generalises cook_sheep.py (unchanged, as the shipped sheep names it) with a rigid horn region.
            trellis_asset(asset, "fauna", shipped_cook(asset, f"{asset}.glb"), f"{asset}.glb",
                          ["cook_quadruped.py", "k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py", "webp_exact.py", "quantize_glb.py", "meshopt_glb.mjs"],
                          PROP_LIMITS + ["Clips are procedural (IK gaits, oscillators), not motion capture; there is no blending of grazing into walking."])
        elif asset in ("char-crow", "char-crow-flight"):
            trellis_asset(asset, "fauna", shipped_cook(asset, f"{asset}.glb"), f"{asset}.glb",
                          ["cook_crow.py", "k2rig.py", "k2cook.py", "k2materials.py", "k2sheet.py", "webp_exact.py", "quantize_glb.py", "meshopt_glb.mjs"],
                          PROP_LIMITS + ["Clips are procedural oscillators on a small rig (body, head, tail; arms and hands of each wing), not motion capture.",
                                         "TRELLIS fused the perched crow's folded wings into its body and the flying crow's feathers into flat sheets; "
                                         "the view swaps the perched and flying models at take-off and landing instead of folding the wings."])
        elif asset in W3B_PLANTS:
            generated_asset(asset, "tree", "nature-w3b", W3B_NATURE_REVISION, "build_nature_w3b.py", W3B_LIMITS,
                            scripts=["build_nature_w3b.py", "build_nature_w3.py", "build_nature.py", "meshopt_glb.mjs"], barks=())
        elif asset in W3_NATURE:
            kind = "tree" if asset in W3_TREES | W3_PLANTS else "kit" if asset in W3_CRAGS else "rock"
            limits = (W3_TREE_LIMITS if asset in W3_TREES else W3_LIMITS["plant"] if asset in W3_PLANTS
                      else W3_LIMITS["crag"] if asset in W3_CRAGS else W3_LIMITS["floor"])
            generated_asset(asset, kind, "nature-w3", W3_NATURE_REVISION, "build_nature_w3.py", limits,
                            scripts=["build_nature_w3.py", "build_nature.py", "meshopt_glb.mjs"],
                            barks=("bark-spruce", "bark-birch", "bark-pine") if asset in W3_TREES else ())
        elif asset in W2_KIT:
            # build_kit_w2.py imports the W0 and W1 kits' builders, frustums, roofs, bake and export unchanged: all three
            # scripts made these bytes.
            generated_asset(asset, "kit", "kit-w2", W2_KIT_REVISION, "build_kit_w2.py",
                            ["Box-modelled masonry: flat wall faces, straight battlements and many-sided round towers; stones, joints "
                             "and moss are in the surface layers, not in the geometry.",
                             "Towers, keep and gatehouse are closed shells: no interiors, stairs or reachable wall-walks."],
                            scripts=["build_kit_w2.py", "build_kit_w1.py", "build_kit.py", "meshopt_glb.mjs"])
        elif asset in W1_KIT:
            # build_kit_w1.py imports the W0 kit's builder, roof, bake and export unchanged: both scripts made these bytes.
            generated_asset(asset, "kit", "kit-w1", W1_KIT_REVISION, "build_kit_w1.py",
                            ["Box-modelled architecture: straight beams and flat walls, no sagging, no carved detail; detail is in the surface layers.",
                             "Closed buildings have no interiors: doors and shutters are shut and windows are dark reveals."],
                            scripts=["build_kit_w1.py", "build_kit.py", "meshopt_glb.mjs"])
        elif asset.startswith("kit-"):
            generated_asset(asset, "kit", "kit-w0", "r1", "build_kit.py",
                            ["Box-modelled architecture: straight beams and flat walls, no sagging, no carved detail; detail is in the surface layers."])
        elif asset.startswith("tree-") or asset == "rock-boulder":
            generated_asset(asset, "tree" if asset.startswith("tree-") else "rock", "nature-w0", "r1", "build_nature.py",
                            ["Scripted trees with alpha-tested cards: no wind motion, no subsurface or translucency; distant trees are crossed-card impostors.",
                             "Dead oaks reuse the spruce bark layer; there is no oak bark yet."] if asset.startswith("tree-") else
                            ["Scripted boulders from displaced primitives with one granite layer; no cliffs or outcrops yet."])
