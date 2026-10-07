"""Halve the large maps of a finished cook: the game camera never samples a character's or wagon's top mip level.

python resize_maps.py <cook dir> <glb name> [min size, default 1024]

Runs on a cook before meshopt_glb.mjs (which stays last). The follow camera keeps 18-40 m from the hero with a 48 degree
view and a pixel ratio capped at 1.75, so a 1024 px character or wagon map is sampled from its 512 px level or coarser:
halving the maps leaves the game's frames unchanged and quarters their texture memory (KTX2 pilot, 2026-10-06). Maps
narrower than <min size> keep their exact bytes.

Each halved image is decoded from the cook's WebP and reduced with a 2x2 box filter, as the GPU builds mip level 1: in
linear light for sRGB base colour (alpha, the dye mask, stays linear) and plainly for normal, occlusion, roughness and
metal data. Base colour is encoded with webp_exact.py's settings (WebP at the cook's quality, method 6, `exact`, lossless
alpha; the mask must survive exactly); the other maps at the glTF export's quality 92. Every other buffer view keeps its
exact bytes, which is checked before writing. Records `textureResize` in cook.json and amends `baseEncoding` for the
dye-masked images it re-encoded.
"""
import hashlib
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
import PIL
from PIL import Image, features

DATA_QUALITY = 92


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise SystemExit(f"invalid GLB header: {path}")
    at, doc, binary = 12, None, b""
    while at < len(data):
        size, kind = struct.unpack_from("<II", data, at)
        payload = data[at + 8:at + 8 + size]
        if kind == 0x4E4F534A:
            doc = json.loads(payload)
        elif kind == 0x004E4942:
            binary = payload
        at += size + 8
    return doc, binary


def write_glb(path, doc, views):
    blob = bytearray()
    for index, payload in enumerate(views):
        while len(blob) % 4:
            blob.append(0)
        doc["bufferViews"][index]["byteOffset"] = len(blob)
        doc["bufferViews"][index]["byteLength"] = len(payload)
        blob.extend(payload)
    while len(blob) % 4:
        blob.append(0)
    doc["buffers"] = [{"byteLength": len(blob)}]
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text
    out += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    Path(path).write_bytes(out)
    return out


def sha(data):
    return hashlib.sha256(data).hexdigest()


def to_linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255.0


def halve(pixels, colour):
    """2x2 box filter to half size; sRGB channels averaged in linear light, everything else plainly."""
    out = pixels.astype(np.float64)
    if colour:
        out[..., :3] = to_linear(out[..., :3])
    h, w = out.shape[:2]
    if h % 2 or w % 2:
        raise SystemExit(f"cannot halve an odd {w}x{h} image")
    out = out.reshape(h // 2, 2, w // 2, 2, out.shape[2]).mean(axis=(1, 3))
    if colour:
        out[..., :3] = to_srgb(out[..., :3])
    return np.clip(np.floor(out + 0.5), 0, 255).astype(np.uint8)


def decode(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"))


def rgb_error(decoded, exact, mask=None):
    error = np.abs(decoded[..., :3].astype(np.int16) - exact[..., :3].astype(np.int16)).mean(axis=2)
    if mask is not None:
        return round(float(error[mask].mean()), 3) if mask.any() else None
    return round(float(error.mean()), 3)


def colour_sources(doc):
    found = set()
    for material in doc.get("materials", []):
        for info in (material.get("pbrMetallicRoughness", {}).get("baseColorTexture"), material.get("emissiveTexture")):
            if info:
                texture = doc["textures"][info["index"]]
                found.add(texture.get("extensions", {}).get("EXT_texture_webp", {}).get("source", texture.get("source")))
    return found


def main():
    out, glb_name = Path(sys.argv[1]), sys.argv[2]
    min_size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    glb = out / glb_name
    cook_path = out / "cook.json"
    receipt = json.loads(cook_path.read_text(encoding="utf-8"))
    if receipt.get("status") not in ("cooked-pending-verification", "cooked-pending-review"):
        raise SystemExit(f"cook status is {receipt.get('status')!r}, expected a finished cook")
    if "geometryCompression" in receipt:
        raise SystemExit("runs before meshopt_glb.mjs; this cook is already compressed")
    if "textureResize" in receipt:
        raise SystemExit("already resized")
    doc, binary = read_glb(glb)
    if len(doc.get("buffers", [])) != 1:
        raise SystemExit("expected one buffer (a cook before meshopt_glb.mjs)")
    if any("EXT_meshopt_compression" in view.get("extensions", {}) for view in doc["bufferViews"]):
        raise SystemExit("runs before meshopt_glb.mjs; this GLB is already compressed")
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    before = list(views)
    colour = colour_sources(doc)
    exact_images = {entry["image"]: entry for entry in receipt.get("baseEncoding", {}).get("images", [])}
    exact_quality = receipt.get("baseEncoding", {}).get("settings", {}).get("quality", 90)
    resized, kept, encoded = [], [], []
    for index, image in enumerate(doc["images"]):
        name = image.get("name") or f"image-{index}"
        data = views[image["bufferView"]]
        source = Image.open(io.BytesIO(data))
        if min(source.size) < min_size:
            kept.append({"image": name, "size": list(source.size), "bytes": len(data), "sha256": sha(data)})
            continue
        alpha = source.mode in ("RGBA", "LA")
        pixels = np.asarray(source.convert("RGBA"))
        is_colour = index in colour
        target = halve(pixels, is_colour)
        buffer = io.BytesIO()
        if is_colour:
            quality = exact_quality if name in exact_images or alpha else DATA_QUALITY
            Image.fromarray(target if alpha else target[..., :3], "RGBA" if alpha else "RGB").save(
                buffer, "WEBP", quality=quality, method=6, exact=True)
            settings = {"quality": quality, "method": 6, "exact": True, **({"alpha": "lossless"} if alpha else {})}
        else:
            quality = DATA_QUALITY
            Image.fromarray(target[..., :3], "RGB").save(buffer, "WEBP", quality=quality, method=6)
            settings = {"quality": quality, "method": 6}
        payload = buffer.getvalue()
        decoded = decode(payload)
        if decoded.shape[:2] != target.shape[:2]:
            raise SystemExit(f"{name}: encoded size {decoded.shape[1::-1]} is not {target.shape[1::-1]}")
        if alpha and not np.array_equal(decoded[..., 3], target[..., 3]):
            raise SystemExit(f"{name}: the alpha (dye mask) did not survive WebP encoding exactly")
        fact = {"image": name, "role": "colour" if is_colour else "data", "sizeBefore": list(pixels.shape[1::-1]),
                "size": list(target.shape[1::-1]), "bytesBefore": len(data), "bytes": len(payload), "sha256Before": sha(data),
                "sha256": sha(payload), "settings": settings, "meanAbsRgbError": rgb_error(decoded, target)}
        resized.append(fact)
        if is_colour and alpha:
            dyed, undyed = target[..., 3] > 0, target[..., 3] == 0
            encoded.append({"image": name, "size": fact["size"], "bytes": len(payload), "sha256": fact["sha256"],
                            "bytesBefore": len(data), "meanAbsRgbError": {"dyed": rgb_error(decoded, target, dyed),
                                                                          "undyed": rgb_error(decoded, target, undyed)},
                            "undyedFraction": round(float(undyed.mean()), 4)})
        views[image["bufferView"]] = payload
    if not resized:
        raise SystemExit(f"no map is {min_size} px or larger")
    images = {image["bufferView"] for image in doc["images"]}
    for index, payload in enumerate(views):
        if index not in images and payload != before[index]:
            raise SystemExit(f"buffer view {index} changed")
    source_bytes = glb.read_bytes()
    result = write_glb(glb, doc, views)
    check, check_binary = read_glb(glb)
    for index, view in enumerate(check["bufferViews"]):
        payload = check_binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]
        if index not in images and payload != before[index]:
            raise SystemExit(f"buffer view {index} did not survive the rewrite")
    encoder = f"Pillow {PIL.__version__} / libwebp {features.version('webp')}"
    script_sha = sha(Path(__file__).read_bytes())
    receipt["textureResize"] = {
        "script": "resize_maps.py", "scriptSha256": script_sha, "encoder": encoder, "minSize": min_size,
        "filter": "2x2 box to half size, as the GPU builds mip level 1: sRGB colour in linear light, alpha and data plainly",
        "reason": "The game camera never samples this model's top mip level (follow camera at 18-40 m, 48 degree view, pixel ratio "
                  "at most 1.75); halving its large maps leaves the game's frames unchanged and quarters their texture memory.",
        "inputSha256": sha(source_bytes), "bytesBefore": len(source_bytes), "bytesAfter": len(result), "images": resized, "kept": kept,
    }
    if encoded:
        # The dye-masked images this step re-encoded replace their webp_exact.py records; the others keep theirs.
        base = receipt.get("baseEncoding", {"settings": {"quality": exact_quality, "method": 6, "exact": True, "alpha": "lossless"}, "images": []})
        records = {entry["image"]: entry for entry in base.get("images", [])}
        for entry in encoded:
            records[entry["image"]] = {**entry, "encoder": encoder, "script": "resize_maps.py", "scriptSha256": script_sha}
        receipt["baseEncoding"] = {**base, "images": list(records.values()),
                                   "amendedBy": {"script": "resize_maps.py", "scriptSha256": script_sha, "encoder": encoder,
                                                 "settings": {"quality": exact_quality, "method": 6, "exact": True, "alpha": "lossless"},
                                                 "images": [entry["image"] for entry in encoded]}}
    receipt["output"] = {"file": glb.name, "bytes": len(result), "sha256": sha(result),
                         "images": [(img.get("name"), check["bufferViews"][img["bufferView"]]["byteLength"]) for img in check.get("images", [])]}
    cook_path.write_bytes((json.dumps(receipt, indent=2, default=str) + "\n").encode())
    print("RESIZE=" + json.dumps({"bytes": [len(source_bytes), len(result)], "images": [[f["image"], f["size"][0], f["bytes"]] for f in resized]}))


main()
