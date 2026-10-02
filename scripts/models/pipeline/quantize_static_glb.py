"""Quantize a cooked static (unskinned) GLB's vertex attributes (KHR_mesh_quantization).

python quantize_static_glb.py <cook dir> <glb name>

For props (the Echo Well, wagons, cargo, landmarks); runs after webp_exact.py (or the prop cook's own encoding) and
before meshopt_glb.mjs, in a normal Python with numpy. Every mesh of a GLB without skins is stored as:
  POSITION    SHORT normalized with one uniform scale per mesh and no offset: the node that holds the mesh gets that
              scale (node.scale x s), so it rotates and spins about its own origin exactly as before (the game spins the
              wagon wheels' nodes). The node's children get the inverse scale (translation / s, scale / s), so their
              world transforms do not change. The scale is uniform, so normals and tangents keep their directions.
  NORMAL      BYTE normalized         TANGENT  BYTE normalized (handedness stays +-1)
  TEXCOORD_n  UNSIGNED_SHORT normalized when the UVs lie in [0, 1]; otherwise they stay float
  indices, images and everything else are unchanged.
Every quantity is decoded again and its worst error is recorded in cook.json with the bytes before and after; any error
above the stated bound stops the cook. three.js reads all of it without a decoder.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

# Helpers as in quantize_glb.py (which runs on import, and whose shipped hash must not change).
FLOAT, BYTE, UBYTE, SHORT, USHORT = 5126, 5120, 5121, 5122, 5123
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
DTYPES = {FLOAT: np.float32, BYTE: np.int8, UBYTE: np.uint8, SHORT: np.int16, USHORT: np.uint16, 5125: np.uint32}
BOUNDS = {"positionMm": 0.1, "normalDegrees": 0.8, "tangentDegrees": 0.8, "uvTexels2048": 0.05}


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


def main():
    out, glb_name = Path(sys.argv[1]), sys.argv[2]
    glb = out / glb_name
    cook_path = out / "cook.json"
    receipt = json.loads(cook_path.read_text(encoding="utf-8"))
    if receipt.get("status") not in ("cooked-pending-verification", "cooked-pending-review"):
        raise SystemExit(f"cook status is {receipt.get('status')!r}, expected a cooked status pending verification")
    if "staticQuantization" in receipt or "quantization" in receipt:
        raise SystemExit("already quantized")
    before_bytes = glb.read_bytes()
    doc, binary = read_glb(glb)
    for key in ("extensionsUsed", "extensionsRequired"):
        if {"KHR_mesh_quantization", "EXT_meshopt_compression"} & set(doc.get(key, [])):
            raise SystemExit("already quantized or compressed")
    if doc.get("skins"):
        raise SystemExit("skinned GLB: use quantize_glb.py")
    nodes = doc["nodes"]
    animated = {channel["target"].get("node") for animation in doc.get("animations", []) for channel in animation["channels"]}
    users = {}
    for index, node in enumerate(nodes):
        if "mesh" in node:
            users.setdefault(node["mesh"], []).append(index)
    parent = {child: index for index, node in enumerate(nodes) for child in node.get("children", [])}
    errors = {key: 0.0 for key in BOUNDS}
    payloads = {}
    node_scale = {}
    float_uvs = []
    for mesh_index, node_indices in sorted(users.items()):
        mesh = doc["meshes"][mesh_index]
        positions = {primitive["attributes"]["POSITION"] for primitive in mesh["primitives"]}
        stacked = np.vstack([read_accessor(doc, binary, index).astype(np.float64) for index in positions])
        scale = float(np.abs(stacked).max()) * (1 + 1e-6)
        if scale <= 0:
            raise SystemExit(f"mesh {mesh.get('name')} is empty")
        for node_index in node_indices:
            node = nodes[node_index]
            if "matrix" in node:
                raise SystemExit(f"node {node.get('name')} uses a matrix")
            if node_index in animated:
                raise SystemExit(f"node {node.get('name')} is animated")
            for child in node.get("children", []):
                if child in animated or "matrix" in nodes[child]:
                    raise SystemExit(f"child {nodes[child].get('name')} of {node.get('name')} is animated or uses a matrix")
            if node_index in node_scale and abs(node_scale[node_index] - scale) > 1e-12:
                raise SystemExit(f"node {node.get('name')} holds two meshes")
            node_scale[node_index] = scale
        for primitive in mesh["primitives"]:
            if "targets" in primitive:
                raise SystemExit("morph targets are not supported")
            for semantic, index in primitive["attributes"].items():
                accessor = doc["accessors"][index]
                if index in payloads or semantic.startswith("COLOR_"):
                    continue
                if accessor["componentType"] != FLOAT:
                    raise SystemExit(f"{semantic} of {mesh.get('name')} is not float")
                values = read_accessor(doc, binary, index).astype(np.float64)
                if semantic == "POSITION":
                    q, limit = snorm(values / scale, 16)
                    decoded = q / limit * scale
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
                    accessor.pop("min", None)
                    accessor.pop("max", None)
                elif semantic.startswith("TEXCOORD_"):
                    if values.min() < -1e-6 or values.max() > 1 + 1e-6:
                        float_uvs.append(f"{mesh.get('name')}.{semantic}")
                        continue
                    q = np.clip(np.round(values * 65535), 0, 65535)
                    errors["uvTexels2048"] = max(errors["uvTexels2048"], float(np.abs(q / 65535 - values).max() * 2048))
                    payloads[index] = (q.astype(np.uint16).tobytes(), None)
                    accessor.update(componentType=USHORT, normalized=True)
                    accessor.pop("min", None)
                    accessor.pop("max", None)
                else:
                    raise SystemExit(f"unexpected attribute {semantic}")
    failed = {key: round(value, 5) for key, value in errors.items() if value > BOUNDS[key]}
    if failed:
        raise SystemExit(f"quantization errors above their bounds: {failed}")
    scaled_nodes = []
    for node_index, scale in sorted(node_scale.items()):
        node = nodes[node_index]
        node["scale"] = [float(component * scale) for component in node.get("scale", [1.0, 1.0, 1.0])]
        for child in node.get("children", []):
            child_node = nodes[child]
            child_node["translation"] = [float(component / scale) for component in child_node.get("translation", [0.0, 0.0, 0.0])]
            child_node["scale"] = [float(component / scale) for component in child_node.get("scale", [1.0, 1.0, 1.0])]
        scaled_nodes.append({"node": node.get("name"), "scale": round(scale, 6), "children": [nodes[c].get("name") for c in node.get("children", [])]})
    # Rebuild the binary as quantize_glb.py does: one bufferView per accessor, then the images.
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
    receipt["staticQuantization"] = {
        "script": "quantize_static_glb.py", "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "extension": "KHR_mesh_quantization",
        "settings": {"POSITION": "SHORT normalized; one uniform scale per mesh folded into its node's scale (no offset), the inverse into its children",
                     "NORMAL": "BYTE normalized", "TANGENT": "BYTE normalized", "TEXCOORD": "UNSIGNED_SHORT normalized where the UVs lie in [0, 1]"},
        "nodes": scaled_nodes, "floatUvs": float_uvs,
        "maxErrors": {key: round(value, 5) for key, value in errors.items()}, "bounds": BOUNDS,
        "inputSha256": hashlib.sha256(before_bytes).hexdigest(), "bytesBefore": len(before_bytes), "bytesAfter": len(after_bytes),
    }
    receipt["output"] = {"file": glb.name, "bytes": len(after_bytes), "sha256": hashlib.sha256(after_bytes).hexdigest(),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    cook_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("QUANTIZED=" + json.dumps({"bytes": [len(before_bytes), len(after_bytes)], "maxErrors": receipt["staticQuantization"]["maxErrors"],
                                     "floatUvs": float_uvs}))


main()
