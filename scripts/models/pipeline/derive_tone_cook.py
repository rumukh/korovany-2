"""Lift a finished character cook's base colour by a calibrated luma power, without re-running Blender.

python derive_tone_cook.py <source cook dir> <target cook dir> <gamma> <calibration json>

The troop, hero and resident cooks lift their base colour by `toneGamma` inside Blender (k2rig.tone_lift), calibrated
in the game against the approved concept. The line soldier's Phase 1 cook predates that step. This applies the same
lift to the source cook's exact saved base-colour array (body-base.npy, Blender pixel order, the array webp_exact.py
encoded): each texel's Rec.709 luma L of its sRGB-encoded colour becomes L**gamma, and every channel of the texel is
scaled by the same factor, so chroma ratios are kept, and never past 1. The faction-dye mask in alpha is unchanged.
The lifted image is encoded with webp_exact.py's settings (WebP at the source's quality, method 6, `exact`, lossless
alpha) and replaces only that image in a copy of the source GLB; every other buffer view, and the glTF JSON apart
from buffer offsets and lengths, is verified byte-identical. The source receipt is copied to the target with the
derivation recorded, ready for quantize_glb.py and meshopt_glb.mjs. Runs in a normal Python with Pillow.
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

LUMA = np.array([0.2126, 0.7152, 0.0722])
IMAGE = "body-base"


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
    return doc, [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]


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


def layout_free(doc):
    """The glTF JSON without buffer offsets and lengths, which move when one image's size changes."""
    doc = json.loads(json.dumps(doc))
    for view in doc["bufferViews"]:
        view.pop("byteOffset", None)
        view.pop("byteLength", None)
    doc.pop("buffers", None)
    return doc


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGBA")).astype(np.int16)


def rgb_error(decoded, exact, mask):
    error = np.abs(decoded[..., :3] - exact[..., :3].astype(np.int16)).mean(axis=2)
    return round(float(error[mask].mean()), 3) if mask.any() else None


def to_bytes(array):
    # Blender stores rows bottom-up; image files (and glTF, whose exporter flips V) are top-down.
    return np.clip(np.round(array[::-1] * 255), 0, 255).astype(np.uint8)


def tone_lift(rgb, gamma):
    """k2rig.tone_lift: each texel's luma L becomes L**gamma, one scale per texel, never past a channel's 1."""
    luma = np.maximum(rgb @ LUMA, 1 / 255)
    ceiling = 1 / np.maximum(rgb.max(axis=-1), 1 / 255)
    scale = np.minimum(luma ** (gamma - 1), ceiling)
    return np.clip(rgb * np.maximum(scale, 1.0)[..., None], 0, 1), float((luma ** (gamma - 1) > ceiling).mean())


def mean_luma(exact):
    return round(float((exact[..., :3].astype(np.float64) / 255 @ LUMA).mean() * 255), 2)


def main():
    source, target, gamma = Path(sys.argv[1]), Path(sys.argv[2]), float(sys.argv[3])
    calibration = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
    if not 0.3 <= gamma < 1.0:
        raise SystemExit("gamma must be in [0.3, 1)")
    if not isinstance(calibration.get("toneCalibration"), str):
        raise SystemExit("the calibration record needs its toneCalibration text")
    receipt = json.loads((source / "cook.json").read_text(encoding="utf-8"))
    if receipt.get("status") != "cooked-pending-verification":
        raise SystemExit(f"source cook status is {receipt.get('status')!r}, expected 'cooked-pending-verification'")
    if "derivedFrom" in receipt:
        raise SystemExit("lift the Blender cook itself, whose saved base-colour array its output was encoded from")
    if receipt["materials"].get("toneGamma", 1.0) != 1.0:
        raise SystemExit("the source cook is already tone-lifted")
    encoding = receipt["baseEncoding"]
    settings = encoding["settings"]
    if settings != {"quality": settings["quality"], "method": 6, "exact": True, "alpha": "lossless"}:
        raise SystemExit(f"unexpected source encoding settings {settings}")
    output = receipt["output"]
    glb = source / output["file"]
    if sha(glb.read_bytes()) != output["sha256"]:
        raise SystemExit(f"{glb.name} differs from its receipt")
    if target.exists():
        raise SystemExit(f"{target} exists")
    doc, views = read_glb(glb)
    view = next(img for img in doc["images"] if img.get("name") == IMAGE)["bufferView"]
    record = next(fact for fact in encoding["images"] if fact["image"] == IMAGE)
    if sha(views[view]) != record["sha256"]:
        raise SystemExit(f"{IMAGE} in {glb.name} differs from its encoding record")

    # The saved array is the one the source image was encoded from: the same dye mask, and the same recorded error.
    array = np.load(source / f"{IMAGE}.npy")
    exact_before = to_bytes(array)
    before = decode(views[view])
    if not np.array_equal(before[..., 3], exact_before[..., 3]):
        raise SystemExit(f"{IMAGE}.npy does not match the encoded dye mask")
    dyed, undyed = exact_before[..., 3] > 0, exact_before[..., 3] == 0
    for key, mask in (("dyed", dyed), ("undyed", undyed)):
        if abs(rgb_error(before, exact_before, mask) - record["meanAbsRgbError"][key]) > 0.002:
            raise SystemExit(f"{IMAGE}.npy is not the array the source encoding was measured against ({key})")

    rgb, limited = tone_lift(array[..., :3].astype(np.float64), gamma)
    # Blender holds pixels as float32, so the lift is stored at that precision as the in-cook lift would be.
    exact = to_bytes(np.dstack([rgb.astype(np.float32), array[..., 3:4]]))
    if not np.array_equal(exact[..., 3], exact_before[..., 3]):
        raise SystemExit("the lift changed the dye mask")
    buffer = io.BytesIO()
    Image.fromarray(exact, "RGBA").save(buffer, "WEBP", quality=settings["quality"], method=6, exact=True)
    data = buffer.getvalue()
    decoded = decode(data)
    if not np.array_equal(decoded[..., 3], exact[..., 3]):
        raise SystemExit("the dye mask did not survive WebP alpha encoding exactly")
    error = {"dyed": rgb_error(decoded, exact, dyed), "undyed": rgb_error(decoded, exact, undyed)}
    if max(value for value in error.values() if value is not None) >= 3:
        raise SystemExit(f"WebP round-trip error too large: {error}")

    target.mkdir(parents=True)
    new_views = list(views)
    new_views[view] = data
    write_glb(target / output["file"], json.loads(json.dumps(doc)), new_views)
    written, written_views = read_glb(target / output["file"])
    changed = [index for index, payload in enumerate(written_views) if payload != views[index]]
    if changed != [view] or layout_free(written) != layout_free(doc):
        raise SystemExit(f"more than {IMAGE} changed: views {changed}")
    (target / f"{IMAGE}.webp").write_bytes(data)
    shipped = (target / output["file"]).read_bytes()

    receipt["derivedFrom"] = {"cook": source.name, "sha256": output["sha256"], "bytes": output["bytes"],
                              "note": f"The exact {source.name} output with its {IMAGE} image lifted by derive_tone_cook.py; "
                                      "the Blender cook was not re-run."}
    receipt["toneDerivation"] = {
        "script": "derive_tone_cook.py", "scriptSha256": sha(Path(__file__).read_bytes()), "image": IMAGE, "toneGamma": gamma,
        "formula": "k2rig.tone_lift on the cook's saved base-colour array: each texel's Rec.709 luma L of its sRGB-encoded "
                   "colour becomes L**toneGamma, one scale per texel (chroma ratios kept), never past a channel's 1; the "
                   "dye mask in alpha is unchanged",
        "meanLuma": {"before": mean_luma(exact_before), "after": mean_luma(exact)},
        "channelLimitedFraction": round(limited, 5),
        "imageBefore": {"sha256": record["sha256"], "bytes": len(views[view])},
        "unchanged": "every other buffer view, and the glTF JSON apart from buffer offsets and lengths (verified)",
        "calibration": calibration,
    }
    receipt["materials"]["toneGamma"] = gamma
    receipt["materials"]["toneCalibration"] = calibration["toneCalibration"]
    receipt["materials"]["provenance"] = receipt["materials"]["provenance"].replace(
        "Artistic derivation", "Base colour then lifted by luma power toneGamma after the cook (derive_tone_cook.py; chroma "
        "ratios kept), calibrated in the game against the approved concept. Artistic derivation")
    fact = {"image": IMAGE, "size": list(exact.shape[1::-1]), "bytes": len(data), "sha256": sha(data), "bytesBefore": len(views[view]),
            "meanAbsRgbError": error, "undyedFraction": round(float(undyed.mean()), 4),
            "encoder": f"Pillow {PIL.__version__} / libwebp {features.version('webp')}", "script": "derive_tone_cook.py",
            "note": "Re-encoded with the settings above after the tone lift; the other images are the source cook's bytes."}
    encoding["images"] = [fact if entry["image"] == IMAGE else entry for entry in encoding["images"]]
    receipt["output"] = {"file": output["file"], "bytes": len(shipped), "sha256": sha(shipped),
                         "images": [(img.get("name"), written["bufferViews"][img["bufferView"]]["byteLength"]) for img in written["images"]]}
    (target / "cook.json").write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("TONE_DERIVED=" + json.dumps({"output": receipt["output"], "toneDerivation": {
        key: receipt["toneDerivation"][key] for key in ("toneGamma", "meanLuma", "channelLimitedFraction")}, "image": fact}))


main()
