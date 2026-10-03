"""Repair degenerate vertex tangents of a finished cook's GLB in place (a derived cook, <cook>-t).

python repair_tangents.py <cook dir> <glb name>

three.js normalizes each vertex tangent in the vertex shader, so a zero-length tangent (MikkTSpace returns one where every
face around a vertex has a degenerate UV mapping) becomes NaN, every triangle sharing the vertex shades as NaN, and the
high-quality bloom spreads that over a large black block of the frame. Each zero or non-finite tangent is replaced by the
mean of the valid tangents of the vertices it shares triangles with, made perpendicular to its normal (an arbitrary
perpendicular if none is usable), with the neighbours' majority handedness. Only those tangent values change: every other
byte of the GLB is kept. Normals must already be unit length (the script fails otherwise). The cook's status must be
'cooked-pending-verification' or 'cooked-pending-review', unquantized and uncompressed; the repair, the checked counts and
each repaired vertex are recorded in cook.json.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

FLOAT = 5126
INDEX_TYPES = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}


def read_glb(path):
    data = Path(path).read_bytes()
    at, chunks = 12, []
    while at < len(data):
        size, kind = struct.unpack_from("<II", data, at)
        chunks.append((kind, at + 8, size))
        at += size + 8
    doc = json.loads(next(data[start:start + size] for kind, start, size in chunks if kind == 0x4E4F534A))
    binary = next(((start, size) for kind, start, size in chunks if kind == 0x004E4942), None)
    return data, doc, binary


def view_of(doc, accessor_index):
    accessor = doc["accessors"][accessor_index]
    view = doc["bufferViews"][accessor["bufferView"]]
    return accessor, view


def floats(data, bin_start, doc, index, width):
    accessor, view = view_of(doc, index)
    if accessor["componentType"] != FLOAT or accessor.get("normalized"):
        raise SystemExit(f"accessor {index} is not plain float")
    stride = view.get("byteStride", 4 * width)
    start = bin_start + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    rows = np.empty((accessor["count"], width), np.float64)
    for i in range(accessor["count"]):
        rows[i] = struct.unpack_from(f"<{width}f", data, start + i * stride)
    return rows, start, stride


def main():
    out, glb_name = Path(sys.argv[1]), sys.argv[2]
    glb = out / glb_name
    cook_path = out / "cook.json"
    receipt = json.loads(cook_path.read_text(encoding="utf-8"))
    if receipt.get("status") not in ("cooked-pending-verification", "cooked-pending-review"):
        raise SystemExit(f"cook status is {receipt.get('status')!r}")
    for key in ("tangentRepair", "quantization", "staticQuantization", "geometryCompression"):
        if key in receipt:
            raise SystemExit(f"cook already has {key}")
    data, doc, binary = read_glb(glb)
    if binary is None:
        raise SystemExit("GLB has no binary chunk")
    if doc.get("extensionsUsed") and {"KHR_mesh_quantization", "EXT_meshopt_compression"} & set(doc["extensionsUsed"]):
        raise SystemExit("repair tangents before quantization and compression")
    bin_start = binary[0]
    patched = bytearray(data)
    checked, repaired, normals_checked = 0, [], 0
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            attributes = primitive["attributes"]
            if "NORMAL" in attributes:
                normal, _, _ = floats(data, bin_start, doc, attributes["NORMAL"], 3)
                length = np.linalg.norm(normal, axis=1)
                if not np.isfinite(normal).all() or np.abs(length - 1).max() > 1e-3:
                    raise SystemExit(f"{mesh.get('name')}: normals are not unit length (min {np.nanmin(length):.4f})")
                normals_checked += len(normal)
            if "TANGENT" not in attributes:
                continue
            tangent, start, stride = floats(data, bin_start, doc, attributes["TANGENT"], 4)
            checked += len(tangent)
            xyz = tangent[:, :3]
            length = np.linalg.norm(xyz, axis=1)
            bad = ~np.isfinite(tangent).all(axis=1) | (length < 0.5)
            if not bad.any():
                continue
            if "indices" not in primitive:
                raise SystemExit("non-indexed primitive")
            accessor, view = view_of(doc, primitive["indices"])
            dtype = np.dtype(INDEX_TYPES[accessor["componentType"]])
            first = bin_start + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            faces = np.frombuffer(data, dtype=dtype, count=accessor["count"], offset=first).reshape(-1, 3).astype(np.int64)
            for vertex in np.flatnonzero(bad):
                around = np.unique(faces[(faces == vertex).any(axis=1)])
                around = around[(around != vertex) & ~bad[around]]
                n = normal[vertex]
                total = xyz[around].sum(axis=0) if len(around) else np.zeros(3)
                t = total - n * float(n @ total)
                source = "neighbours"
                if np.linalg.norm(t) < 1e-6:
                    axis = np.array([1.0, 0.0, 0.0]) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
                    t = np.cross(n, axis)
                    source = "perpendicular"
                t = t / np.linalg.norm(t)
                w = 1.0 if (tangent[around, 3].sum() if len(around) else 1.0) >= 0 else -1.0
                struct.pack_into("<4f", patched, start + int(vertex) * stride, *t.astype(np.float32), w)
                repaired.append({"mesh": mesh.get("name"), "vertex": int(vertex), "source": source, "neighbours": int(len(around)),
                                 "before": [round(float(v), 6) if np.isfinite(v) else str(v) for v in tangent[vertex]],
                                 "after": [round(float(v), 6) for v in (*t, w)]})
    before_sha = hashlib.sha256(data).hexdigest()
    glb.write_bytes(bytes(patched))
    after = glb.read_bytes()
    # Verify: only tangent bytes changed, and every tangent is now unit length.
    _, doc_after, _ = read_glb(glb)
    for mesh in doc_after["meshes"]:
        for primitive in mesh["primitives"]:
            if "TANGENT" in primitive["attributes"]:
                tangent, _, _ = floats(after, bin_start, doc_after, primitive["attributes"]["TANGENT"], 4)
                length = np.linalg.norm(tangent[:, :3], axis=1)
                if not np.isfinite(tangent).all() or np.abs(length - 1).max() > 1e-3 or not np.isin(tangent[:, 3], (-1.0, 1.0)).all():
                    raise SystemExit("tangents still invalid after repair")
    changed = sum(1 for a, b in zip(data, after) if a != b)
    if len(after) != len(data) or changed > 16 * len(repaired):
        raise SystemExit("repair changed more than the repaired tangents")
    receipt["tangentRepair"] = {
        "script": "repair_tangents.py", "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "why": "three.js normalizes vertex tangents in the vertex shader; a zero-length tangent becomes NaN and the bloom spreads it.",
        "normalsChecked": normals_checked, "tangentsChecked": checked, "repaired": repaired,
        "inputSha256": before_sha, "bytesChanged": changed,
    }
    receipt["output"] = {**receipt["output"], "bytes": len(after), "sha256": hashlib.sha256(after).hexdigest()}
    cook_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    print("TANGENTS=" + json.dumps({"checked": checked, "repaired": len(repaired), "bytesChanged": changed}))


if __name__ == "__main__":
    main()
