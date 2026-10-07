"""Encode a finished cook's images as KTX2 (Basis Universal UASTC) with KHR_texture_basisu.

BASISU_WASM=<basisu_st.wasm> BASIS_TRANSCODER=<three/examples/jsm/libs/basis> python ktx2_glb.py <cook dir> <glb name>

Runs on a cook before meshopt_glb.mjs (which stays last). Each WebP image is decoded losslessly and encoded by the Basis
Universal 2.50 command-line encoder, its single-threaded WASI build run by Node through ktx2_tool.mjs, so the bytes are
the same on every host: UASTC LDR 4x4 at level 2 with rate-distortion optimisation (lambda 1 for base colour and for
occlusion, roughness and metal, 0.5 for normals; 32 KiB dictionary) and Zstandard level 22, with a full mip chain built
by a 2x2 box filter with clamped edges, as the GPU builds its own (sRGB colour in linear light, data and normals
plainly). Base colour is tagged sRGB, everything else linear. Each file is then opened with the game's own transcoder
(three.js's), every level is transcoded to every GPU format three.js may pick and to RGBA8, and the RGBA8 error against
a box-filtered reference is recorded at mip 0 and mip 2 (the levels a close-up and the gameplay camera sample). Every
other buffer view keeps its exact bytes, which is checked before writing. Records `textureCompression` in cook.json.
"""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
TOOL = HERE / "ktx2_tool.mjs"
ENCODER_SHA256 = "b42d951b1bf146133578e8c7927ad4a4a857552846a46a3ee33b541b2a06bc7d"
TRANSCODER_SHA256 = {
    "basis_transcoder.js": "8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1",
    "basis_transcoder.wasm": "6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a",
}
COMMON = ["-uastc", "-uastc_level", "2", "-uastc_rdo_d", "32768", "-uastc_rdo_m", "-ktx2", "-ktx2_zstandard_level", "22",
          "-mipmap", "-mip_filter", "box", "-mip_clamp", "-no_multithreading"]
ROLE = {
    "colour": ["-uastc_rdo_l", "1", "-srgb"],
    "data": ["-uastc_rdo_l", "1", "-linear"],
    "normal": ["-uastc_rdo_l", "0.5", "-normal_map"],
}
KTX2_ID = bytes([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A])


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


def box(pixels, levels, colour):
    out = pixels.astype(np.float64)
    if colour:
        out[..., :3] = to_linear(out[..., :3])
    for _ in range(levels):
        h, w = out.shape[:2]
        out = out.reshape(h // 2, 2, w // 2, 2, out.shape[2]).mean(axis=(1, 3))
    if colour:
        out[..., :3] = to_srgb(out[..., :3])
    return np.clip(np.floor(out + 0.5), 0, 255)


def roles(doc):
    found = {}

    def add(info, role):
        if info is not None:
            texture = doc["textures"][info["index"]]
            source = texture.get("extensions", {}).get("EXT_texture_webp", {}).get("source", texture.get("source"))
            found.setdefault(source, set()).add(role)
    for material in doc.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        add(pbr.get("baseColorTexture"), "colour")
        add(material.get("emissiveTexture"), "colour")
        add(pbr.get("metallicRoughnessTexture"), "data")
        add(material.get("occlusionTexture"), "data")
        add(material.get("normalTexture"), "normal")
    result = {}
    for source, role_set in found.items():
        if len(role_set) != 1:
            raise SystemExit(f"image {source} serves mixed roles {sorted(role_set)}")
        result[source] = role_set.pop()
    return result


def ktx2_header(data):
    """The KTX2 fields the game relies on: one 2D UASTC image with a full mip chain, Zstandard, its transfer function."""
    if data[:12] != KTX2_ID:
        raise SystemExit("not a KTX2 file")
    vk_format, _, width, height, depth, layers, faces, levels, scheme = struct.unpack_from("<9I", data, 12)
    dfd_offset = struct.unpack_from("<I", data, 48)[0]
    block = dfd_offset + 4
    model, primaries, transfer = data[block + 8], data[block + 9], data[block + 10]
    samples = ((struct.unpack_from("<I", data, block + 4)[0] >> 16) - 24) // 16
    channel = data[block + 24 + 3] & 0x0F
    return {"vkFormat": vk_format, "width": width, "height": height, "depth": depth, "layers": layers, "faces": faces,
            "levels": levels, "supercompression": scheme, "colorModel": model, "primaries": primaries, "transfer": transfer,
            "samples": samples, "channel": channel}


def node(*args):
    done = subprocess.run(["node", "--no-warnings", str(TOOL), *args], capture_output=True, text=True)
    if done.returncode:
        raise SystemExit(f"ktx2_tool.mjs {args[0]} failed:\n{done.stdout[-4000:]}\n{done.stderr[-4000:]}")
    return done.stdout


def main():
    out, glb_name = Path(sys.argv[1]), sys.argv[2]
    encoder = Path(os.environ.get("BASISU_WASM", ""))
    transcoder = Path(os.environ.get("BASIS_TRANSCODER", ""))
    if not encoder.is_file() or sha(encoder.read_bytes()) != ENCODER_SHA256:
        raise SystemExit("set BASISU_WASM to Basis Universal 2.50's bin/basisu_st.wasm")
    for name, digest in TRANSCODER_SHA256.items():
        if not (transcoder / name).is_file() or sha((transcoder / name).read_bytes()) != digest:
            raise SystemExit(f"set BASIS_TRANSCODER to three.js 0.169.0's examples/jsm/libs/basis ({name})")
    glb = out / glb_name
    cook_path = out / "cook.json"
    receipt = json.loads(cook_path.read_text(encoding="utf-8"))
    if receipt.get("status") not in ("cooked-pending-verification", "cooked-pending-review"):
        raise SystemExit(f"cook status is {receipt.get('status')!r}, expected a finished cook")
    if "geometryCompression" in receipt or "textureCompression" in receipt:
        raise SystemExit("runs once, before meshopt_glb.mjs")
    doc, binary = read_glb(glb)
    if len(doc.get("buffers", [])) != 1 or any("EXT_meshopt_compression" in v.get("extensions", {}) for v in doc["bufferViews"]):
        raise SystemExit("expected an uncompressed single-buffer GLB (a cook before meshopt_glb.mjs)")
    views = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in doc["bufferViews"]]
    before = list(views)
    role_of = roles(doc)
    images = []
    with tempfile.TemporaryDirectory(dir=out) as work:
        version = node("encode", str(encoder), work, "-version").splitlines()[0].strip()
        if "v2.50.0" not in version:
            raise SystemExit(f"unexpected encoder version {version!r}")
        for index, image in enumerate(doc["images"]):
            name = image.get("name") or f"image-{index}"
            role = role_of.get(index)
            if role is None:
                raise SystemExit(f"{name} is not used by a material slot")
            data = views[image["bufferView"]]
            source = Image.open(io.BytesIO(data))
            if source.format != "WEBP":
                raise SystemExit(f"{name} is {source.format}, expected WebP")
            alpha = source.mode in ("RGBA", "LA")
            pixels = np.asarray(source.convert("RGBA"))
            height, width = pixels.shape[:2]
            if width != height or width & (width - 1):
                raise SystemExit(f"{name} is {width}x{height}; expected a square power of two")
            Image.fromarray(pixels if alpha else pixels[..., :3]).save(Path(work) / f"{index}.png")
            args = [*COMMON, *ROLE[role], "-force_alpha" if alpha else "-no_alpha", "-file", f"/work/{index}.png", "-output_file", f"/work/{index}.ktx2"]
            node("encode", str(encoder), work, *args)
            payload = (Path(work) / f"{index}.ktx2").read_bytes()
            header = ktx2_header(payload)
            expected = {"vkFormat": 0, "width": width, "height": height, "depth": 0, "layers": 0, "faces": 1,
                        "levels": width.bit_length(), "supercompression": 2, "colorModel": 166, "primaries": 1,
                        "transfer": 2 if role == "colour" else 1, "samples": 1, "channel": 3 if alpha else 0}
            if header != expected:
                raise SystemExit(f"{name}: KTX2 header {header}, expected {expected}")
            levels_dir = Path(work) / f"{index}-levels"
            node("levels", str(transcoder), str(Path(work) / f"{index}.ktx2"), str(levels_dir))
            summary = json.loads((levels_dir / "levels.json").read_text(encoding="utf-8"))
            if summary["levels"] != header["levels"] or summary["hasAlpha"] != alpha:
                raise SystemExit(f"{name}: the transcoder read {summary}")
            fact = {"image": name, "role": role, "size": [width, height], "alpha": alpha, "bytesBefore": len(data), "bytes": len(payload),
                    "sha256Before": sha(data), "sha256": sha(payload), "levels": header["levels"],
                    "transfer": "sRGB" if role == "colour" else "linear", "settings": args[:-4], "transcodedTo": summary["targets"]}
            for n in (0, 2):
                entry = summary["rgba"][n]
                got = np.frombuffer((levels_dir / f"level-{n}.rgba").read_bytes(), np.uint8).reshape(entry["height"], entry["width"], 4).astype(np.float64)
                ref = box(pixels, n, role == "colour")
                diff = np.abs(got[..., :3] - ref[..., :3])
                mse = float((diff ** 2).mean())
                result = {"meanAbsRgbError": round(float(diff.mean()), 3), "psnr": round(10 * np.log10(255 ** 2 / mse), 2) if mse else 99.0}
                if alpha:
                    alpha_diff = np.abs(got[..., 3] - ref[..., 3])
                    result["alphaMeanAbsError"] = round(float(alpha_diff.mean()), 3)
                    result["alphaMaxError"] = int(alpha_diff.max())
                fact[f"mip{n}"] = result
            images.append(fact)
            views[image["bufferView"]] = payload
            image["mimeType"] = "image/ktx2"
    for texture in doc["textures"]:
        extensions = texture.setdefault("extensions", {})
        source = extensions.pop("EXT_texture_webp", {}).get("source", texture.get("source"))
        if source is None:
            raise SystemExit("a texture has no image")
        texture.pop("source", None)
        extensions["KHR_texture_basisu"] = {"source": source}
    for key in ("extensionsUsed", "extensionsRequired"):
        doc[key] = sorted({name for name in doc.get(key, []) if name != "EXT_texture_webp"} | {"KHR_texture_basisu"})
    image_views = {image["bufferView"] for image in doc["images"]}
    source_bytes = glb.read_bytes()
    result = write_glb(glb, doc, views)
    check, check_binary = read_glb(glb)
    for index, view in enumerate(check["bufferViews"]):
        if index not in image_views and check_binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]] != before[index]:
            raise SystemExit(f"buffer view {index} did not survive the rewrite")
    receipt["textureCompression"] = {
        "extension": "KHR_texture_basisu", "codec": "Basis Universal UASTC LDR 4x4 in KTX2, Zstandard supercompression",
        "encoder": {"name": "Basis Universal basisu", "version": version, "build": "bin/basisu_st.wasm (WASI, single-threaded) of tag v2_50",
                    "source": "https://github.com/BinomialLLC/basis_universal", "license": "Apache-2.0", "sha256": ENCODER_SHA256},
        "transcoder": {"name": "three.js 0.169.0 examples/jsm/libs/basis (the game's)", "sha256": TRANSCODER_SHA256},
        "script": "ktx2_glb.py", "scriptSha256": sha(Path(__file__).read_bytes()), "toolSha256": sha(TOOL.read_bytes()),
        "mips": "full chain, 2x2 box filter with clamped edges (sRGB colour in linear light)",
        "inputSha256": sha(source_bytes), "bytesBefore": len(source_bytes), "bytesAfter": len(result), "images": images,
    }
    receipt["output"] = {"file": glb.name, "bytes": len(result), "sha256": sha(result),
                         "images": [(img.get("name"), check["bufferViews"][img["bufferView"]]["byteLength"]) for img in check.get("images", [])]}
    cook_path.write_bytes((json.dumps(receipt, indent=2, default=str) + "\n").encode())
    print("KTX2=" + json.dumps({"bytes": [len(source_bytes), len(result)], "images": [[f["image"], f["bytes"], f["mip0"]["psnr"], f["mip2"]["psnr"]] for f in images]}))


main()
