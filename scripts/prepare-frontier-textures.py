"""Derive repeat-safe game maps from the original six-panel generated atlas.

Offline asset preparation only; Pillow and NumPy are not runtime dependencies.
Normal and roughness maps are artistic luminance-derived approximations, not
measured physical scans.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


SURFACES = ("ground", "stone", "wood", "roof", "bark", "cloth")


def periodic_edges(pixels: np.ndarray, band: int = 32) -> np.ndarray:
    result = pixels.copy()
    # Blend opposing edge strips symmetrically, keeping the interior untouched.
    for axis in (0, 1):
        working = np.swapaxes(result, 0, axis)
        for offset in range(band):
            weight = (1 - offset / band) ** 2
            left, right = working[offset].copy(), working[-1 - offset].copy()
            average = (left + right) * 0.5
            working[offset] = left * (1 - weight) + average * weight
            working[-1 - offset] = right * (1 - weight) + average * weight
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("atlas", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--surface", choices=("rock",))
    args = parser.parse_args()
    atlas = Image.open(args.atlas).convert("RGB")
    if not args.surface and atlas.size != (1536, 1024):
        raise ValueError(f"Expected 1536x1024 atlas, got {atlas.size}")
    args.output.mkdir(parents=True, exist_ok=True)
    outputs = []
    names = (args.surface,) if args.surface else SURFACES
    for index, name in enumerate(names):
        x, y = index % 3 * 512, index // 3 * 512
        tile = atlas.resize((512, 512), Image.Resampling.LANCZOS) if args.surface else atlas.crop((x, y, x + 512, y + 512))
        rgb = periodic_edges(np.asarray(tile, dtype=np.float32) / 255)
        luminance = rgb @ np.array([0.2126, 0.7152, 0.0722])
        low, high = np.percentile(luminance, [2, 98])
        height = np.clip((luminance - low) / max(float(high - low), 0.01), 0, 1)
        # Neutral albedo retains fine detail without double-tinting region colors.
        color = np.clip(0.53 + height[..., None] * 0.44 + (rgb - luminance[..., None]) * 0.18, 0, 1)
        softened = np.asarray(Image.fromarray(np.uint8(height * 255)).filter(ImageFilter.GaussianBlur(0.7)), dtype=np.float32) / 255
        dx = (np.roll(softened, -1, axis=1) - np.roll(softened, 1, axis=1)) * 1.8
        dy = (np.roll(softened, -1, axis=0) - np.roll(softened, 1, axis=0)) * 1.8
        normal = np.stack([-dx, dy, np.ones_like(dx)], axis=-1)
        normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
        normal = normal * 0.5 + 0.5
        roughness = np.repeat((0.78 + (1 - height[..., None]) * 0.2), 3, axis=-1)
        for kind, data in (("color", color), ("normal", normal), ("roughness", roughness)):
            path = args.output / f"{name}-{kind}.webp"
            # Lossless encoding preserves matching edges and tangent-space vectors.
            Image.fromarray(np.uint8(np.clip(data, 0, 1) * 255)).save(path, lossless=True, method=6)
            outputs.append({"file": path.name, "width": 512, "height": 512,
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    manifest = {
        "generator": "Azure OpenAI gpt-image-2",
        "source": "Original generated frontier material; no third-party reference assets",
        "sourceSize": list(atlas.size),
        "sourceSha256": hashlib.sha256(args.atlas.read_bytes()).hexdigest(),
        "processing": "Seam blending, neutral albedo, artistic luminance-derived OpenGL normals and roughness",
        "surfaces": list(names),
        "maps": outputs,
    }
    manifest_name = f"manifest-{args.surface}.json" if args.surface else "manifest.json"
    (args.output / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"maps": len(outputs), "directory": str(args.output),
                      "bytes": sum((args.output / item["file"]).stat().st_size for item in outputs)}))


if __name__ == "__main__":
    main()
