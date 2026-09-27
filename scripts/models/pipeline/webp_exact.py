"""Encode dye-masked base-colour images with libwebp's `exact` option and finish a character cook.

python webp_exact.py <cook dir> <glb name> <quality> <image name>[,<image name>...]

Base-colour alpha carries the faction-dye mask, not coverage. libwebp's default lossy mode (the mode Blender's
writer and glTF exporter use) discards RGB wherever alpha is 0 and flattens runs of fully transparent 8x8 blocks
to one colour, which erased the texture on every undyed surface. This step reads the exact arrays the cook saved
(<name>.npy, Blender pixel order), encodes them with `exact`, verifies the round trip, replaces only those images
in the GLB and records the result in cook.json. Runs in a normal Python with Pillow, after Blender exits.
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


def decode(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGBA")).astype(np.int16)


def rgb_error(decoded, exact, mask):
    error = np.abs(decoded[..., :3] - exact[..., :3].astype(np.int16)).mean(axis=2)
    return round(float(error[mask].mean()), 3) if mask.any() else None


def main():
    out, glb_name, quality, names = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3]), sys.argv[4].split(",")
    glb = out / glb_name
    cook_path = out / "cook.json"
    receipt = json.loads(cook_path.read_text(encoding="utf-8"))
    if receipt.get("status") != "cooked-pending-encoding":
        raise SystemExit(f"cook status is {receipt.get('status')!r}, expected 'cooked-pending-encoding'")
    doc, binary = read_glb(glb)
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    facts = []
    for image in doc["images"]:
        name = image.get("name")
        if name not in names:
            continue
        array = np.load(out / f"{name}.npy")
        # Blender stores rows bottom-up; image files (and glTF, whose exporter flips V) are top-down.
        exact = np.clip(np.round(array[::-1] * 255), 0, 255).astype(np.uint8)
        buffer = io.BytesIO()
        Image.fromarray(exact, "RGBA").save(buffer, "WEBP", quality=quality, method=6, exact=True)
        data = buffer.getvalue()
        decoded, before = decode(data), decode(views[image["bufferView"]])
        if not np.array_equal(decoded[..., 3], exact[..., 3]):
            raise SystemExit(f"{name}: the dye mask did not survive WebP alpha encoding exactly")
        if (np.abs(before[..., 3] - exact[..., 3].astype(np.int16)) <= 1).mean() < 0.999:
            raise SystemExit(f"{name}: saved array does not match the exported image's dye mask (orientation?)")
        dyed, undyed = exact[..., 3] > 0, exact[..., 3] == 0
        fact = {"image": name, "size": list(exact.shape[1::-1]), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "bytesBefore": len(views[image["bufferView"]]),
                "meanAbsRgbError": {"dyed": rgb_error(decoded, exact, dyed), "undyed": rgb_error(decoded, exact, undyed)},
                "meanAbsRgbErrorBefore": {"dyed": rgb_error(before, exact, dyed), "undyed": rgb_error(before, exact, undyed)},
                "undyedFraction": round(float(undyed.mean()), 4)}
        views[image["bufferView"]] = data
        image["mimeType"] = "image/webp"
        (out / f"{name}.webp").write_bytes(data)
        facts.append(fact)
    missing = set(names) - {fact["image"] for fact in facts}
    if missing:
        raise SystemExit(f"images not found in {glb_name}: {sorted(missing)}")
    write_glb(glb, doc, views)
    doc, _ = read_glb(glb)
    bytes_ = glb.read_bytes()
    receipt["baseEncoding"] = {
        "encoder": f"Pillow {PIL.__version__} / libwebp {features.version('webp')}", "script": "webp_exact.py",
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "settings": {"quality": quality, "method": 6, "exact": True, "alpha": "lossless"},
        "reason": "Base-colour alpha is the dye mask; libwebp's default lossy mode discards RGB under alpha 0.",
        "images": facts,
    }
    receipt["output"] = {"file": glb.name, "bytes": len(bytes_), "sha256": hashlib.sha256(bytes_).hexdigest(),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    receipt["status"] = "cooked-pending-verification"
    cook_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("WEBP_EXACT=" + json.dumps({"output": receipt["output"], "images": facts}))


main()
