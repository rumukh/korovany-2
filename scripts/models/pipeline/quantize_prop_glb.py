"""Quantize a cooked static prop GLB's vertex attributes with a centred position range (KHR_mesh_quantization).

python quantize_prop_glb.py <cook dir> <glb name>

For the batch E landmarks and batch F pickups, which stand up to about 20 m tall on a 2.8 m footprint: the earlier
quantize_static_glb.py stores positions with one uniform scale and no offset, so a tall prop's base-to-top range spends
half the 16-bit codes on empty space below the ground and its error (half a step of the largest coordinate) exceeds that
script's fixed 0.1 mm bound. Here every mesh of a GLB without skins or animation, held by a root node with no children,
is stored as:
  POSITION    SHORT normalized about the centre of the mesh's bounding box, with one uniform scale (the largest
              coordinate distance from that centre): the node gets that scale (node.scale x s) and the centre (node
              translation + node rotation (node scale x centre)), so world positions are unchanged and the scale stays
              uniform, keeping normals and tangents in their directions.
  NORMAL      BYTE normalized         TANGENT  BYTE normalized (handedness stays +-1)
  TEXCOORD_n  UNSIGNED_SHORT normalized when the UVs lie in [0, 1]; otherwise they stay float
  indices, images and everything else are unchanged.
Every quantity is decoded again and its worst error recorded in cook.json with the bytes before and after. The position
bound is absolute (0.1 mm) or, for props whose half-extent exceeds 6.5 m, 0.51 of one 16-bit step of that half-extent
(rounding to the nearest code can never exceed half a step), recorded with the error relative to the prop's extent; any
error above its bound stops the cook. three.js reads all of it without a decoder.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

FLOAT, BYTE, UBYTE, SHORT, USHORT = 5126, 5120, 5121, 5122, 5123
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
DTYPES = {FLOAT: np.float32, BYTE: np.int8, UBYTE: np.uint8, SHORT: np.int16, USHORT: np.uint16, 5125: np.uint32}
BOUNDS = {"positionMm": 0.1, "positionHalfSteps": 0.51, "normalDegrees": 0.8, "tangentDegrees": 0.8, "uvTexels2048": 0.05}


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


def rotate(quaternion, vector):
    x, y, z, w = quaternion
    u = np.array([x, y, z], dtype=np.float64)
    v = np.asarray(vector, dtype=np.float64)
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


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
    if doc.get("skins") or doc.get("animations"):
        raise SystemExit("skinned or animated GLB: this script is for static props")
    nodes = doc["nodes"]
    children = {child for node in nodes for child in node.get("children", [])}
    users = {}
    for index, node in enumerate(nodes):
        if "mesh" in node:
            users.setdefault(node["mesh"], []).append(index)
    errors = {"positionMm": 0.0, "normalDegrees": 0.0, "tangentDegrees": 0.0, "uvTexels2048": 0.0}
    payloads, placed, float_uvs, position_facts = {}, {}, [], []
    for mesh_index, node_indices in sorted(users.items()):
        mesh = doc["meshes"][mesh_index]
        positions = {primitive["attributes"]["POSITION"] for primitive in mesh["primitives"]}
        stacked = np.vstack([read_accessor(doc, binary, index).astype(np.float64) for index in positions])
        low, high = stacked.min(axis=0), stacked.max(axis=0)
        centre = (low + high) / 2
        scale = float(np.abs(stacked - centre).max()) * (1 + 1e-6)
        if scale <= 0:
            raise SystemExit(f"mesh {mesh.get('name')} is empty")
        step_mm = scale / 32767 * 1000
        bound_mm = max(BOUNDS["positionMm"], BOUNDS["positionHalfSteps"] * step_mm)
        for node_index in node_indices:
            node = nodes[node_index]
            if "matrix" in node or node.get("children") or node_index in children:
                raise SystemExit(f"node {node.get('name')} must be a root node with no matrix and no children")
            if node_index in placed:
                raise SystemExit(f"node {node.get('name')} holds two meshes")
            node_scale = node.get("scale", [1.0, 1.0, 1.0])
            if max(node_scale) - min(node_scale) > 1e-9:
                raise SystemExit(f"node {node.get('name')} has a non-uniform scale")
            placed[node_index] = (scale, centre)
        mesh_error = 0.0
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
                    q, limit = snorm((values - centre) / scale, 16)
                    decoded = q / limit * scale + centre
                    error = float(np.abs(decoded - values).max() * 1000)
                    if error > bound_mm:
                        raise SystemExit(f"position error {error:.5f} mm above its bound {bound_mm:.5f} mm in {mesh.get('name')}")
                    mesh_error = max(mesh_error, error)
                    errors["positionMm"] = max(errors["positionMm"], error)
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
        extent = float((high - low).max())
        position_facts.append({"mesh": mesh.get("name"), "centre": [round(float(c), 6) for c in centre], "scale": round(scale, 6),
                               "stepMm": round(step_mm, 5), "boundMm": round(bound_mm, 5), "maxErrorMm": round(mesh_error, 5),
                               "extentMeters": round(extent, 4), "maxErrorOfExtent": float(f"{mesh_error / 1000 / extent:.3g}")})
    failed = {key: round(value, 5) for key, value in errors.items() if key != "positionMm" and value > BOUNDS[key]}
    if failed:
        raise SystemExit(f"quantization errors above their bounds: {failed}")
    scaled_nodes = []
    for node_index, (scale, centre) in sorted(placed.items()):
        node = nodes[node_index]
        node_scale = node.get("scale", [1.0, 1.0, 1.0])
        shift = rotate(node.get("rotation", [0.0, 0.0, 0.0, 1.0]), np.array(node_scale) * centre)
        node["translation"] = [float(t + s) for t, s in zip(node.get("translation", [0.0, 0.0, 0.0]), shift)]
        node["scale"] = [float(component * scale) for component in node_scale]
        scaled_nodes.append({"node": node.get("name"), "scale": round(scale, 6), "translation": [round(t, 6) for t in node["translation"]]})
    # Rebuild the binary as quantize_static_glb.py does: one bufferView per accessor, then the images.
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
        "script": "quantize_prop_glb.py", "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "extension": "KHR_mesh_quantization",
        "settings": {"POSITION": "SHORT normalized about the bounding-box centre with one uniform scale; the scale and centre folded into the root node",
                     "NORMAL": "BYTE normalized", "TANGENT": "BYTE normalized", "TEXCOORD": "UNSIGNED_SHORT normalized where the UVs lie in [0, 1]"},
        "nodes": scaled_nodes, "positions": position_facts, "floatUvs": float_uvs,
        "maxErrors": {key: round(value, 5) for key, value in errors.items()}, "bounds": BOUNDS,
        "inputSha256": hashlib.sha256(before_bytes).hexdigest(), "bytesBefore": len(before_bytes), "bytesAfter": len(after_bytes),
    }
    receipt["output"] = {"file": glb.name, "bytes": len(after_bytes), "sha256": hashlib.sha256(after_bytes).hexdigest(),
                         "images": [(img.get("name"), doc["bufferViews"][img["bufferView"]]["byteLength"]) for img in doc.get("images", [])]}
    cook_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("QUANTIZED=" + json.dumps({"bytes": [len(before_bytes), len(after_bytes)], "maxErrors": receipt["staticQuantization"]["maxErrors"],
                                     "positions": position_facts, "floatUvs": float_uvs}))


main()
