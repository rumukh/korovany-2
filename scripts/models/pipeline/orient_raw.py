"""Turn a raw TRELLIS GLB by 180 degrees about its vertical (+Y) axis, losslessly, when TRELLIS reconstructed the
figure facing away from the camera (+Z is the game's and the cook's front).

python orient_raw.py <asset.glb> <out-dir>
Every POSITION is mapped (x, y, z) -> (-x, y, -z): an exact sign flip of IEEE floats, a proper rotation, so winding,
UVs, indices, textures and every other byte stay as they were. Requires identity node transforms (TRELLIS exports
them). Writes <out-dir>/asset.glb and <out-dir>/orientation.json (source and output SHA-256, the operation).
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main(source, out_dir):
    source, out_dir = Path(source), Path(out_dir)
    data = source.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise SystemExit("not a glTF 2.0 binary")
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise SystemExit("first chunk is not JSON")
    gltf = json.loads(data[20:20 + json_length])
    bin_header = 20 + json_length
    bin_length, bin_type = struct.unpack_from("<II", data, bin_header)
    if bin_type != 0x004E4942:
        raise SystemExit("second chunk is not BIN")
    binary = bytearray(data[bin_header + 8:bin_header + 8 + bin_length])
    for node in gltf.get("nodes", []):
        for key in ("matrix", "rotation", "translation", "scale"):
            if key in node:
                raise SystemExit(f"node {node.get('name')} has a {key}; expected identity transforms")
    turned = set()
    for mesh in gltf["meshes"]:
        for primitive in mesh["primitives"]:
            index = primitive["attributes"]["POSITION"]
            if index in turned:
                continue
            accessor = gltf["accessors"][index]
            if accessor["type"] != "VEC3" or accessor["componentType"] != 5126 or accessor.get("sparse"):
                raise SystemExit("POSITION must be a dense float VEC3 accessor")
            view = gltf["bufferViews"][accessor["bufferView"]]
            stride = view.get("byteStride", 12)
            start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            count = accessor["count"]
            raw = np.frombuffer(binary, dtype="<f4", count=(count - 1) * stride // 4 + 3, offset=start).copy()
            positions = np.lib.stride_tricks.as_strided(raw, shape=(count, 3), strides=(stride, 4)).copy()
            positions[:, 0] *= -1
            positions[:, 2] *= -1
            for row in range(count):
                struct.pack_into("<3f", binary, start + row * stride, *positions[row])
            low, high = accessor["min"], accessor["max"]
            accessor["min"] = [-high[0], low[1], -high[2]]
            accessor["max"] = [-low[0], high[1], -low[2]]
            turned.add(index)
    text = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    text += b" " * ((4 - len(text) % 4) % 4)
    out = bytearray(struct.pack("<III", 0x46546C67, 2, 0))
    out += struct.pack("<II", len(text), 0x4E4F534A) + text
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    struct.pack_into("<I", out, 8, len(out))
    out_dir.mkdir(parents=True, exist_ok=False)
    (out_dir / "asset.glb").write_bytes(out)
    receipt = {"schema": "korovany2-raw-orientation/1", "operation": "rotate 180 degrees about +Y: (x, y, z) -> (-x, y, -z)",
               "reason": "TRELLIS reconstructed the figure facing away from the camera; the cook and the game expect +Z forward",
               "source": {"file": source.name, "sha256": sha(data), "bytes": len(data)},
               "output": {"file": "asset.glb", "sha256": sha(bytes(out)), "bytes": len(out)},
               "positionAccessors": sorted(turned), "lossless": True}
    (out_dir / "orientation.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("ORIENTED", json.dumps(receipt))


if __name__ == "__main__":
    main(*sys.argv[1:3])
