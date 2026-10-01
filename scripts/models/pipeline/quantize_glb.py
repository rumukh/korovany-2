"""Quantize a cooked skinned character GLB's vertex attributes and rotation keys (KHR_mesh_quantization).

python quantize_glb.py <cook dir> <glb name>

Runs after webp_exact.py, in a normal Python with numpy. Float vertex data was about half of a resident's bytes. This step
stores, for every skinned primitive:
  POSITION    SHORT normalized; one uniform scale and an offset map it back to metres. glTF ignores a skinned mesh's node
              transform, so the dequantization is folded into every inverse bind matrix (IBM' = IBM . T(offset) . S(scale)).
              The scale is uniform, so skinned normals and tangents only change length, and the renderer normalizes them.
  NORMAL      BYTE normalized         TANGENT  BYTE normalized (handedness stays +-1)
  TEXCOORD_0  UNSIGNED_SHORT normalized (UVs must lie in [0, 1])
  WEIGHTS_0   UNSIGNED_BYTE normalized, rounded by largest remainder so every vertex sums to exactly 255
  JOINTS_0, indices, images, translation keys and key times are unchanged.
Rotation keys become SHORT normalized. Every quantity is decoded again and its worst error is recorded in cook.json with
the bytes before and after; any error above the stated bound stops the cook. three.js reads all of it without a decoder.
"""
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

FLOAT, BYTE, UBYTE, SHORT, USHORT = 5126, 5120, 5121, 5122, 5123
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
DTYPES = {FLOAT: np.float32, BYTE: np.int8, UBYTE: np.uint8, SHORT: np.int16, USHORT: np.uint16, 5125: np.uint32}
BOUNDS = {"positionMm": 0.1, "normalDegrees": 0.8, "tangentDegrees": 0.8, "uvTexels2048": 0.05, "weight": 0.004,
          "rotationDegrees": 0.01}


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


def read_accessor(doc, binary, index):
    accessor = doc["accessors"][index]
    if "sparse" in accessor:
        raise SystemExit(f"accessor {index} is sparse")
    view = doc["bufferViews"][accessor["bufferView"]]
    dtype = np.dtype(DTYPES[accessor["componentType"]])
    width = COMPONENTS[accessor["type"]]
    element = dtype.itemsize * width
    stride = view.get("byteStride", element)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    if stride == element:
        return np.frombuffer(binary, dtype, accessor["count"] * width, start).reshape(-1, width)
    return np.vstack([np.frombuffer(binary, dtype, width, start + row * stride) for row in range(accessor["count"])])


def angle_degrees(a, b):
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    b = b / np.linalg.norm(b, axis=1, keepdims=True)
    return float(np.degrees(np.arccos(np.clip((a * b).sum(axis=1), -1, 1))).max())


def snorm(values, bits):
    limit = (1 << (bits - 1)) - 1
    return np.clip(np.round(values * limit), -limit, limit), limit


def weights_255(weights):
    """Largest-remainder rounding of each row to integers summing to exactly 255 (rows were normalized by the cook)."""
    sums = weights.sum(axis=1, keepdims=True)
    if np.abs(sums - 1).max() > 1e-3:
        raise SystemExit(f"input weights are not normalized (max error {np.abs(sums - 1).max():.4f})")
    scaled = weights / sums * 255
    base = np.floor(scaled)
    short = (255 - base.sum(axis=1)).astype(int)
    order = np.argsort(-(scaled - base), axis=1, kind="stable")
    for row in np.nonzero(short)[0]:
        base[row, order[row, :short[row]]] += 1
    assert (base.sum(axis=1) == 255).all()
    return base.astype(np.uint8)


def main():
    out, glb_name = Path(sys.argv[1]), sys.argv[2]
    glb = out / glb_name
    cook_path = out / "cook.json"
    receipt = json.loads(cook_path.read_text(encoding="utf-8"))
    if receipt.get("status") != "cooked-pending-verification":
        raise SystemExit(f"cook status is {receipt.get('status')!r}, expected 'cooked-pending-verification'")
    if "quantization" in receipt:
        raise SystemExit("already quantized")
    before_bytes = glb.read_bytes()
    doc, binary = read_glb(glb)
    if "KHR_mesh_quantization" in doc.get("extensionsUsed", []):
        raise SystemExit("already quantized")
    payloads = {}  # accessor index -> (bytes, byteStride or None)
    errors = {key: 0.0 for key in BOUNDS}
    skinned_nodes = [node for node in doc["nodes"] if "skin" in node and "mesh" in node]
    if not skinned_nodes:
        raise SystemExit("no skinned mesh")
    skins = {node["skin"] for node in skinned_nodes}
    meshes = {node["mesh"] for node in skinned_nodes}
    for node in skinned_nodes:
        if any(key in node for key in ("matrix", "translation", "rotation", "scale")):
            raise SystemExit(f"skinned node {node.get('name')} has a transform")
    positions = [doc["meshes"][m]["primitives"][p]["attributes"]["POSITION"] for m in meshes for p in range(len(doc["meshes"][m]["primitives"]))]
    stacked = np.vstack([read_accessor(doc, binary, a).astype(np.float64) for a in set(positions)])
    lo, hi = stacked.min(axis=0), stacked.max(axis=0)
    offset = (lo + hi) / 2
    scale = float((hi - lo).max() / 2) * (1 + 1e-6)
    for m in meshes:
        for primitive in doc["meshes"][m]["primitives"]:
            if "targets" in primitive:
                raise SystemExit("morph targets are not supported")
            for semantic, index in primitive["attributes"].items():
                accessor = doc["accessors"][index]
                if index in payloads or semantic.startswith("JOINTS_") or semantic.startswith("COLOR_"):
                    continue
                if accessor["componentType"] != FLOAT:
                    raise SystemExit(f"{semantic} is not float")
                values = read_accessor(doc, binary, index).astype(np.float64)
                if semantic == "POSITION":
                    q, limit = snorm((values - offset) / scale, 16)
                    decoded = q / limit * scale + offset
                    errors["positionMm"] = max(errors["positionMm"], float(np.abs(decoded - values).max() * 1000))
                    data = np.zeros((len(q), 4), np.int16)
                    data[:, :3] = q
                    payloads[index] = (data.tobytes(), 8)
                    accessor.update(componentType=SHORT, normalized=True, min=q.min(axis=0).astype(int).tolist(),
                                    max=q.max(axis=0).astype(int).tolist())
                elif semantic in ("NORMAL", "TANGENT"):
                    xyz = values[:, :3] / np.linalg.norm(values[:, :3], axis=1, keepdims=True)
                    q, limit = snorm(xyz, 8)
                    key = "normalDegrees" if semantic == "NORMAL" else "tangentDegrees"
                    errors[key] = max(errors[key], angle_degrees(q / limit, values[:, :3]))
                    data = np.zeros((len(q), 4), np.int8)
                    data[:, :3] = q
                    if semantic == "TANGENT":
                        if not np.isin(values[:, 3], (-1.0, 1.0)).all():
                            raise SystemExit("tangent handedness is not +-1")
                        data[:, 3] = np.where(values[:, 3] < 0, -127, 127)
                    payloads[index] = (data.tobytes(), 4 if semantic == "NORMAL" else None)
                    accessor.update(componentType=BYTE, normalized=True)
                elif semantic.startswith("TEXCOORD_"):
                    if values.min() < -1e-6 or values.max() > 1 + 1e-6:
                        raise SystemExit(f"{semantic} leaves [0, 1]")
                    q = np.clip(np.round(values * 65535), 0, 65535)
                    errors["uvTexels2048"] = max(errors["uvTexels2048"], float(np.abs(q / 65535 - values).max() * 2048))
                    payloads[index] = (q.astype(np.uint16).tobytes(), None)
                    accessor.update(componentType=USHORT, normalized=True)
                elif semantic.startswith("WEIGHTS_"):
                    q = weights_255(values)
                    errors["weight"] = max(errors["weight"], float(np.abs(q / 255 - values).max()))
                    payloads[index] = (q.tobytes(), None)
                    accessor.update(componentType=UBYTE, normalized=True)
                else:
                    raise SystemExit(f"unexpected attribute {semantic}")
                if semantic != "POSITION":
                    accessor.pop("min", None)
                    accessor.pop("max", None)
    dequantize = np.array([[scale, 0, 0, offset[0]], [0, scale, 0, offset[1]], [0, 0, scale, offset[2]], [0, 0, 0, 1]])
    for s in skins:
        index = doc["skins"][s]["inverseBindMatrices"]
        matrices = read_accessor(doc, binary, index).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
        folded = (matrices @ dequantize).transpose(0, 2, 1).reshape(-1, 16).astype(np.float32)
        payloads[index] = (folded.tobytes(), None)
        doc["accessors"][index].pop("min", None)
        doc["accessors"][index].pop("max", None)
    rotation_outputs = {sampler["output"] for animation in doc.get("animations", []) for channel in animation["channels"]
                        if channel["target"]["path"] == "rotation"
                        for sampler in [animation["samplers"][channel["sampler"]]]}
    for index in sorted(rotation_outputs):
        accessor = doc["accessors"][index]
        if accessor["componentType"] != FLOAT:
            continue
        values = read_accessor(doc, binary, index).astype(np.float64)
        unit = values / np.linalg.norm(values, axis=1, keepdims=True)
        q, limit = snorm(unit, 16)
        decoded = q / limit
        decoded /= np.linalg.norm(decoded, axis=1, keepdims=True)
        dot = np.clip(np.abs((decoded * unit).sum(axis=1)), -1, 1)
        errors["rotationDegrees"] = max(errors["rotationDegrees"], float(np.degrees(2 * np.arccos(dot)).max()))
        payloads[index] = (q.astype(np.int16).tobytes(), None)
        accessor.update(componentType=SHORT, normalized=True)
        accessor.pop("min", None)
        accessor.pop("max", None)
    failed = {key: round(value, 5) for key, value in errors.items() if value > BOUNDS[key]}
    if failed:
        raise SystemExit(f"quantization errors above their bounds: {failed}")
    # Rebuild the binary: one bufferView per accessor (quantized or copied as is), then the images.
    old_views = doc["bufferViews"]
    new_views, new_payloads = [], []

    def add_view(payload, template, stride):
        view = {"buffer": 0, "byteLength": len(payload)}
        if "target" in template:
            view["target"] = template["target"]
        if stride:
            view["byteStride"] = stride
        new_views.append(view)
        new_payloads.append(payload)
        return len(new_views) - 1

    for index, accessor in enumerate(doc["accessors"]):
        template = old_views[accessor["bufferView"]]
        if index in payloads:
            payload, stride = payloads[index]
        else:
            raw = read_accessor(doc, binary, index) if "byteStride" in template else None
            if raw is not None:
                payload, stride = np.ascontiguousarray(raw).tobytes(), None
            else:
                dtype = np.dtype(DTYPES[accessor["componentType"]])
                start = template.get("byteOffset", 0) + accessor.get("byteOffset", 0)
                payload = binary[start:start + accessor["count"] * COMPONENTS[accessor["type"]] * dtype.itemsize]
                stride = None
        accessor["bufferView"] = add_view(payload, template, stride)
        accessor.pop("byteOffset", None)
    for image in doc.get("images", []):
        template = old_views[image["bufferView"]]
        start = template.get("byteOffset", 0)
        image["bufferView"] = add_view(binary[start:start + template["byteLength"]], template, None)
    doc["bufferViews"] = new_views
    for key in ("extensionsUsed", "extensionsRequired"):
        doc[key] = sorted(set(doc.get(key, [])) | {"KHR_mesh_quantization"})
    write_glb(glb, doc, new_payloads)
    after_bytes = glb.read_bytes()
    receipt["quantization"] = {
        "script": "quantize_glb.py", "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "extension": "KHR_mesh_quantization",
        "settings": {"POSITION": "SHORT normalized; uniform scale and offset folded into the inverse bind matrices",
                     "NORMAL": "BYTE normalized", "TANGENT": "BYTE normalized", "TEXCOORD_0": "UNSIGNED_SHORT normalized",
                     "WEIGHTS_0": "UNSIGNED_BYTE normalized, largest-remainder rounding to 255", "rotation": "SHORT normalized"},
        "dequantization": {"scaleMeters": round(scale, 6), "offsetMeters": [round(float(v), 6) for v in offset]},
        "maxErrors": {key: round(value, 5) for key, value in errors.items()}, "bounds": BOUNDS,
        "inputSha256": hashlib.sha256(before_bytes).hexdigest(), "bytesBefore": len(before_bytes), "bytesAfter": len(after_bytes),
    }
    receipt["output"] = {"file": glb.name, "bytes": len(after_bytes), "sha256": hashlib.sha256(after_bytes).hexdigest(),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    cook_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("QUANTIZED=" + json.dumps({"bytes": [len(before_bytes), len(after_bytes)], "maxErrors": receipt["quantization"]["maxErrors"]}))


main()
