"""Cook one Korovany II world surface layer from an accepted local Qwen 2511 candidate.

    python cook_surface.py <recipe.json> <candidate.png> <out-dir> [--size 512] [--receipt <cook.json>]

Writes `<layer>-albedo.webp` (sRGB colour) and `<layer>-height.webp` (grayscale relief; the game derives tangent normals
and roughness from it at load), all tileable, and a receipt (`--receipt`, else `<out-dir>/<layer>-cook.json`). Steps,
recorded in the receipt:

1. de-light: divide out the candidate's low-frequency luminance (uneven exposure or vignetting), keep its mean;
2. wrap blend: a variance-preserving cross-fade of each border band with the half-offset image, so opposite edges meet
   (both axes) without a low-contrast band;
3. grade: optional recipe gain and saturation toward the world palette, an optional low-frequency chroma evening (a
   broad tint patch would repeat as a grid), and an optional soft roll-off of linear luminance above a knee toward a
   ceiling (tames near-white specks that no damp ground has);
4. resize to the layer size (Lanczos) and derive height from the blurred luminance, percentile-stretched.

An artistic derivation from a photograph-like image, not measured PBR.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("recipe", type=Path)
parser.add_argument("candidate", type=Path)
parser.add_argument("out", type=Path)
parser.add_argument("--size", type=int, default=512)
parser.add_argument("--receipt", type=Path)
args = parser.parse_args()
recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
cook = recipe.get("cook", {})
layer = recipe["layer"]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha_text(path: Path) -> str:
    """SHA-256 of a text file with LF line endings, as git stores it."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def luminance(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def wrap_blur(channel, sigma):
    """Gaussian blur with wrap-around edges (the image is treated as a tile), by FFT."""
    fy = np.fft.fftfreq(channel.shape[0])[:, None]
    fx = np.fft.fftfreq(channel.shape[1])[None, :]
    kernel = np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(channel) * kernel)).astype(np.float32)


def wrap_blend(image, band):
    """Blend the border bands with the half-offset image along both axes, so opposite edges match. The cross-fade is
    variance-preserving (Heitz and Neyret 2018): deviations from the tile mean are divided by sqrt(wa^2 + wb^2), so the
    band keeps the detail contrast of the rest of the tile instead of reading as a soft grid line."""
    size = image.shape[0]
    distance = np.minimum(np.arange(size), size - 1 - np.arange(size)).astype(np.float32)
    t = np.clip(1 - distance / band, 0, 1)
    weight = t * t * (3 - 2 * t)
    mean = image.reshape(-1, image.shape[-1]).mean(axis=0)

    def blend(a, b, w):
        norm = np.sqrt((1 - w) ** 2 + w ** 2)
        return mean + ((a - mean) * (1 - w) + (b - mean) * w) / norm

    out = blend(image, np.roll(image, size // 2, axis=1), weight[None, :, None])
    out = blend(out, np.roll(out, size // 2, axis=0), weight[:, None, None])
    return np.clip(out, 0, None)


def seam_ratio(image):
    """Mean border step divided by the mean step between interior neighbours (1 is invisible)."""
    inner = np.abs(np.diff(image, axis=1)).mean()
    edge = (np.abs(image[:, 0] - image[:, -1]).mean() + np.abs(image[0] - image[-1]).mean()) / 2
    return float(edge / max(inner, 1e-6))


source = Image.open(args.candidate).convert("RGB")
side = min(source.size)
source = source.crop(((source.width - side) // 2, (source.height - side) // 2, (source.width + side) // 2, (source.height + side) // 2))
rgb = srgb_to_linear(np.asarray(source).astype(np.float32) / 255)
seams_before = seam_ratio(rgb)
lum = luminance(rgb)
# A narrower de-light (recipe cook.delightFraction, default 1/8 of the side) also removes a dark strip along one edge.
delight_sigma = side * cook.get("delightFraction", 1 / 8)
low = wrap_blur(lum, delight_sigma)
delight = np.clip(lum.mean() / np.maximum(low, 1e-4), 0.6, 1.7)
rgb = rgb * delight[..., None]
rgb = wrap_blend(rgb, side * cook.get("blendFraction", 0.08))
seams_after = seam_ratio(rgb)
gain = cook.get("gain", 1.0)
saturation = cook.get("saturation", 1.0)
grey = luminance(rgb)[..., None]
rgb = np.clip((grey + (rgb - grey) * saturation) * gain, 0, 1)
if cook.get("evenChroma"):
    # Divide out the low-frequency chroma (each channel's share of the luminance, blurred like the de-light), keeping the
    # tile's mean tint, so a broad tint patch does not repeat as a grid; fine colour detail stays.
    lum = np.maximum(luminance(rgb), 1e-4)
    for channel in range(3):
        ratio = rgb[..., channel] / lum
        low_ratio = wrap_blur(ratio, side / 8)
        rgb[..., channel] *= ratio.mean() / np.maximum(low_ratio, 1e-4)
    rgb = np.clip(rgb, 0, 1)
highlights = cook.get("highlights")
if highlights:
    # Soft roll-off of linear luminance above the knee toward the ceiling, keeping each pixel's chroma ratios.
    knee, ceiling = float(highlights["knee"]), float(highlights["ceiling"])
    lum = luminance(rgb)
    span = ceiling - knee
    rolled = np.where(lum > knee, knee + span * (1 - np.exp(-np.maximum(lum - knee, 0) / span)), lum)
    rgb = rgb * (rolled / np.maximum(lum, 1e-6))[..., None]
srgb = (linear_to_srgb(rgb) * 255 + 0.5).astype(np.uint8)
albedo = Image.fromarray(srgb, "RGB").resize((args.size, args.size), Image.Resampling.LANCZOS)
lum_small = luminance(srgb_to_linear(np.asarray(albedo).astype(np.float32) / 255))
height = wrap_blur(lum_small, cook.get("heightBlur", 0.8))
low_h, high_h = np.percentile(height, 1), np.percentile(height, 99)
height = np.clip((height - low_h) / max(high_h - low_h, 1e-6), 0, 1)
if cook.get("invertHeight"):
    height = 1 - height
args.out.mkdir(parents=True, exist_ok=True)
albedo_path = args.out / f"{layer}-albedo.webp"
height_path = args.out / f"{layer}-height.webp"
albedo.save(albedo_path, "WEBP", quality=cook.get("albedoQuality", 88), method=6)
Image.fromarray((height * 255 + 0.5).astype(np.uint8), "L").save(height_path, "WEBP", quality=cook.get("heightQuality", 90), method=6)
receipt = {
    "schema": "korovany2-surface-cook/1",
    "layer": layer,
    "recipe": recipe["id"],
    "recipeSha256": sha_text(args.recipe),
    "candidate": args.candidate.name,
    "candidateSha256": sha(args.candidate),
    "script": "scripts/world/pipeline/cook_surface.py",
    "scriptSha256": sha_text(Path(__file__)),
    "size": args.size,
    "steps": {
        "delight": {"sigmaPixels": delight_sigma, "clamp": [0.6, 1.7]},
        "wrapBlend": {"bandFraction": cook.get("blendFraction", 0.08), "mode": "variance-preserving",
                      "seamRatioBefore": round(seams_before, 3), "seamRatioAfter": round(seams_after, 3)},
        "grade": {"gain": gain, "saturation": saturation, **({"highlights": highlights} if highlights else {}),
                  **({"evenChroma": True} if cook.get("evenChroma") else {})},
        "height": {"blurPixels": cook.get("heightBlur", 0.8), "percentiles": [1, 99], "inverted": bool(cook.get("invertHeight"))},
    },
    "albedoMeanSrgb": [round(float(v), 1) for v in np.asarray(albedo).reshape(-1, 3).mean(axis=0)],
    "outputs": {p.name: {"bytes": p.stat().st_size, "sha256": sha(p)} for p in (albedo_path, height_path)},
}
(args.receipt or args.out / f"{layer}-cook.json").write_bytes((json.dumps(receipt, indent=1) + "\n").encode())
print(json.dumps({"layer": layer, "seams": [receipt["steps"]["wrapBlend"]["seamRatioBefore"], receipt["steps"]["wrapBlend"]["seamRatioAfter"]],
                  "bytes": {k: v["bytes"] for k, v in receipt["outputs"].items()}}))
