"""World surface albedo as KTX2 texture arrays (Basis Universal UASTC), with the game's roughness derivation done offline.

Reads the cooked albedo and height WebPs (cook_surface.py) of the recipe's tiling layers, in the recipe's order (the
game's WORLD_SURFACES), and builds each layer's albedo with its roughness in alpha. The roughness is derived from the
height map exactly as deriveSurface in src/view/world-assets.ts derives it: heights rounded through float32 like the
game's Float32Array, float64 arithmetic in the same order, JavaScript rounding. The layers therefore equal what the game
assembled at load from the same files (checked against the browser's own WebP decode and deriveSurface). The game still
derives the tangent normals at load from the height maps: they are texel-scale noise, which no GPU block codec keeps
within the world's download budget.

Encodes the layers as the recipe's parts, runs of consecutive layers that the game joins into one array at load, each a
KTX2 array with a full box-filtered mip chain (colour in linear light, as the GPU built it), through surface_tool.mjs
(Basis Universal's single-threaded WASI encoder, so the bytes are the same on any host; the parts encode side by side in
separate processes). A part over the recipe's per-file budget stops the cook. Opens every part with the game's transcoder
(every layer of every level to every GPU format three.js may pick, and RGBA8), measures PSNR per layer and level against
the uncompressed layers and their box-filtered mip levels, and writes a receipt. The receipt also holds the SHA-256 of
this port's output on a fixed height fixture, which the world asset tests compare with the game's own deriveSurface.

python surface_albedo_ktx2.py <recipe.json> <surfaces dir> <basisu_st.wasm> <transcoder dir> <work dir> <out dir> <receipt.json>
"""
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import PIL
from PIL import Image, features

TOOL = Path(__file__).with_name("surface_tool.mjs")
COMMON = ["-tex_array", "-mipmap", "-mip_filter", "box", "-no_multithreading", "-ktx2"]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def js_round(x: np.ndarray) -> np.ndarray:
    """JavaScript's Math.round: the nearest integer, halves toward +infinity (floor(x + 0.5) can round 0.49999999999999994 up)."""
    whole = np.floor(x)
    return whole + (x - whole >= 0.5)


def derive(height: np.ndarray, relief: float, roughness: float) -> np.ndarray:
    """deriveSurface for one layer: RGBA8 of tangent normal X, Y (+v along increasing rows), roughness and 255, from the
    height map's bytes (rows top-down), with wrapping gradients so the result tiles."""
    size = height.shape[0]
    h = (height.astype(np.float64) / 255).astype(np.float32).astype(np.float64)
    strength = relief * size / 128
    du = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * strength
    dv = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * strength
    inverse = 1 / np.sqrt(du * du + dv * dv + 1)
    x = js_round((0.5 - du * inverse * 0.5) * 255)
    y = js_round((0.5 - dv * inverse * 0.5) * 255)
    rough = js_round(np.minimum(1, np.maximum(0.3, roughness + (0.5 - h) * 0.12)) * 255)
    return np.dstack([x, y, rough, np.full_like(x, 255)]).astype(np.uint8)


def fixture(spec: dict) -> str:
    """SHA-256 of deriveSurface's output on a seeded height field (a 32-bit LCG's top bytes), one block per finish."""
    state, size = spec["seed"], spec["size"]
    values = []
    for _ in range(size * size):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        values.append(state >> 24)
    height = np.array(values, dtype=np.uint8).reshape(size, size)
    return sha256(b"".join(derive(height, finish["relief"], finish["roughness"]).tobytes() for finish in spec["finishes"]))


def albedo_layers(recipe: dict, surfaces: Path):
    """Each layer's albedo with its roughness in alpha, and the source files it came from."""
    size = recipe["size"]
    layers, inputs = [], []
    for layer in recipe["layers"]:
        name = layer["name"]
        record = {"layer": name}
        maps = {}
        for kind in ("albedo", "height"):
            path = surfaces / f"{name}-{kind}.webp"
            data = path.read_bytes()
            record[kind] = {"file": path.name, "sha256": sha256(data), "bytes": len(data)}
            image = Image.open(path)
            if image.size != (size, size):
                raise SystemExit(f"{path} is {image.size[0]}x{image.size[1]}, expected {size}x{size}")
            maps[kind] = np.asarray(image.convert("RGBA"))
        albedo = maps["albedo"].copy()
        albedo[..., 3] = derive(maps["height"][..., 0], layer["relief"], layer["roughness"])[..., 2]
        layers.append(albedo)
        inputs.append(record)
    return layers, inputs


def srgb_to_linear(v: np.ndarray) -> np.ndarray:
    v = v / 255
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v: np.ndarray) -> np.ndarray:
    v = np.clip(v, 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055) * 255


def reference_levels(layer: np.ndarray):
    """Box-filtered mip levels of one layer (colour in linear light, alpha linear), as floats 0..255."""
    levels = [layer.astype(np.float64)]
    current = layer.astype(np.float64)
    current[..., :3] = srgb_to_linear(current[..., :3]) * 255
    while current.shape[0] > 1:
        current = (current[0::2, 0::2] + current[1::2, 0::2] + current[0::2, 1::2] + current[1::2, 1::2]) / 4
        level = current.copy()
        level[..., :3] = linear_to_srgb(level[..., :3] / 255)
        levels.append(np.floor(level + 0.5))
    return levels


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else round(10 * np.log10(255 ** 2 / mse), 2)


def write_layers(work: Path, layers) -> list:
    names = []
    for index, layer in enumerate(layers):
        name = f"albedo-{index:02d}.png"
        Image.fromarray(layer, "RGBA").save(work / name, compress_level=1)
        names.append(name)
    return names


def encode(wasm: Path, work: Path, args: list, inputs: list, output: str) -> None:
    command = ["node", str(TOOL), "encode", str(wasm), str(work), *COMMON, *args, "-output_file", f"/work/{output}",
               *(f"/work/{name}" for name in inputs)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"basisu failed for {output}:\n{result.stdout[-4000:]}\n{result.stderr[-4000:]}")


def verify(transcoder: Path, file: Path, layers: int, out: Path) -> dict:
    result = subprocess.run(["node", str(TOOL), "layers", str(transcoder), str(file), str(layers), str(out)], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"transcoder check failed for {file}:\n{result.stderr[-4000:]}")
    return json.loads((out / "layers.json").read_bytes().decode())


def measure(layers: list, summary: dict, decoded: Path) -> list:
    """PSNR of colour and roughness of each of a part's layers at each level."""
    per_level = []
    references = [reference_levels(layer) for layer in layers]
    for entry in summary["rgba"]:
        level, width = entry["level"], entry["width"]
        data = np.frombuffer((decoded / f"level-{level}.rgba").read_bytes(), dtype=np.uint8).reshape(len(layers), width, width, 4)
        per_level.append({"level": level,
                          "colour": [psnr(reference[level][..., :3], data[index][..., :3]) for index, reference in enumerate(references)],
                          "roughness": [psnr(reference[level][..., 3], data[index][..., 3]) for index, reference in enumerate(references)]})
    return per_level


def main() -> None:
    if len(sys.argv) != 8:
        raise SystemExit(__doc__)
    recipe_path, surfaces, wasm, transcoder, work, out, receipt_path = (Path(arg) for arg in sys.argv[1:])
    recipe_bytes = recipe_path.read_bytes()
    recipe = json.loads(recipe_bytes.decode())
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    layers, inputs = albedo_layers(recipe, surfaces)
    names = write_layers(work, layers)
    parts, first = [], 0
    for part in recipe["parts"]:
        parts.append((part["file"], first, first + part["layers"]))
        first += part["layers"]
    if first != len(layers):
        raise SystemExit(f"the parts hold {first} layers, the recipe lists {len(layers)}")
    with ThreadPoolExecutor(len(parts)) as pool:
        list(pool.map(lambda part: encode(wasm, work, recipe["basisu"], names[part[1]:part[2]], part[0]), parts))
    outputs, levels, targets = [], None, None
    for file, start, end in parts:
        summary = verify(transcoder, work / file, end - start, work / f"decoded-{start:02d}")
        if summary["codec"] != "uastc" or not summary["hasAlpha"] or summary["transferFunction"] != 2:
            raise SystemExit(f"{file}: expected UASTC with alpha and the sRGB transfer function, got {summary}")
        data = (work / file).read_bytes()
        if len(data) > recipe["maxFileBytes"]:
            raise SystemExit(f"{file} is {len(data)} bytes, over the {recipe['maxFileBytes']} byte per-file budget")
        shutil.copyfile(work / file, out / file)
        outputs.append({"file": file, "firstLayer": start, "layers": summary["layers"], "sha256": sha256(data), "bytes": len(data),
                        "codec": summary["codec"], "width": summary["width"], "levels": summary["levels"], "hasAlpha": summary["hasAlpha"],
                        "transferFunction": summary["transferFunction"], "rgba8Sha256": [entry["sha256"] for entry in summary["rgba"]]})
        measured = measure(layers[start:end], summary, work / f"decoded-{start:02d}")
        levels = measured if levels is None else [
            {"level": a["level"], "colour": a["colour"] + b["colour"], "roughness": a["roughness"] + b["roughness"]} for a, b in zip(levels, measured)]
        targets = summary["targets"]
    receipt = {
        "schema": "korovany2-surface-albedo-cook/2",
        "recipe": {"file": recipe_path.name, "sha256": sha256(recipe_bytes)},
        "inputs": inputs,
        "layerSha256": [sha256(np.ascontiguousarray(layer).tobytes()) for layer in layers],
        "derivationFixture": {**recipe["fixture"], "sha256": fixture(recipe["fixture"])},
        "encoder": {"wasm": wasm.name, "sha256": sha256(wasm.read_bytes()), "arguments": [*COMMON, *recipe["basisu"]]},
        "outputs": outputs,
        "verification": {"targets": targets, "levels": [
            {"level": entry["level"], **{kind: {"min": min(entry[kind]), "median": float(np.median(entry[kind])), "perLayer": entry[kind]}
                                         for kind in ("colour", "roughness")}} for entry in levels]},
        "tools": {"python": platform.python_version(), "pillow": PIL.__version__, "libwebp": features.version("webp"),
                  "numpy": np.__version__, "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()},
    }
    receipt_path.write_bytes((json.dumps(receipt, indent=1) + "\n").encode())
    level0 = receipt["verification"]["levels"][0]
    for output in outputs:
        print(output["file"], output["bytes"], output["sha256"])
    print("colour", level0["colour"]["min"], level0["colour"]["median"], "roughness", level0["roughness"]["min"],
          "fixture", receipt["derivationFixture"]["sha256"])


if __name__ == "__main__":
    main()
