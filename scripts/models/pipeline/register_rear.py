"""Register a rear-view painting to the mesh's orthographic back silhouette, ready for projection.

python register_rear.py <painting.png> <rear-mask.png> <outDir>

Writes painting-registered.png (same frame as rear-camera.json, painted colours extended past the painted
silhouette so edge texels never sample the backdrop), overlay.png (mesh silhouette in magenta over the
registered painting) and registration.json. Qwen may mirror the sculpt it repaints, so both orientations are
scored and the better one is kept (the decision is recorded).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

painting_path, mask_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
paint = np.asarray(Image.open(painting_path).convert("RGB"), dtype=np.float32)
target = np.asarray(Image.open(mask_path).convert("L")) > 127
H, W = target.shape
if paint.shape[:2] != (H, W):
    raise SystemExit(f"painting {paint.shape[:2]} does not match mask {(H, W)}")


def foreground(image):
    border = np.concatenate([image[:6].reshape(-1, 3), image[-6:].reshape(-1, 3), image[:, :6].reshape(-1, 3), image[:, -6:].reshape(-1, 3)])
    backdrop = np.median(border, axis=0)
    fg = np.abs(image - backdrop).sum(axis=2) > 30
    fg = ndimage.binary_opening(fg, iterations=2)
    labels, count = ndimage.label(fg)
    if count == 0:
        raise SystemExit("no foreground found in painting")
    sizes = ndimage.sum(fg, labels, range(1, count + 1))
    fg = labels == (int(np.argmax(sizes)) + 1)
    return ndimage.binary_fill_holes(ndimage.binary_closing(fg, iterations=3)), backdrop


def iou(a, b):
    return float((a & b).sum() / max(1, (a | b).sum()))


def warp(array, sx, sy, tx, ty, resample):
    """Scale about the target silhouette centre, then translate. PIL affine maps output -> input."""
    cy, cx = ndimage.center_of_mass(target)
    a, e = 1 / sx, 1 / sy
    c = cx - (cx + tx) * a
    f = cy - (cy + ty) * e
    mode = "L" if array.ndim == 2 else "RGB"
    image = Image.fromarray(array.astype(np.uint8) if array.dtype != bool else (array * 255).astype(np.uint8), mode)
    warped = image.transform((W, H), Image.AFFINE, (a, 0, c, 0, e, f), resample=resample)
    result = np.asarray(warped)
    return result > 127 if array.dtype == bool else result.astype(np.float32)


def register(fg):
    """Coarse-to-fine search of anisotropic scale and translation maximizing silhouette IoU, started from both
    the identity and the centroid alignment."""
    ty0, tx0 = np.subtract(ndimage.center_of_mass(target), ndimage.center_of_mass(fg))
    results = []
    for start in ([1.0, 1.0, 0.0, 0.0], [1.0, 1.0, float(tx0), float(ty0)]):
        params = list(start)
        best = (iou(warp(fg, *params, Image.NEAREST), target), *params)
        for step_scale, step_shift in ((0.04, 16), (0.02, 8), (0.01, 4), (0.005, 2), (0.0025, 1)):
            improved = True
            while improved:
                improved = False
                for index, delta in ((0, step_scale), (0, -step_scale), (1, step_scale), (1, -step_scale),
                                     (2, step_shift), (2, -step_shift), (3, step_shift), (3, -step_shift)):
                    trial = params.copy()
                    trial[index] += delta
                    score = iou(warp(fg, *trial, Image.NEAREST), target)
                    if score > best[0] + 1e-5:
                        best = (score, *trial)
                        params = trial
                        improved = True
        results.append(best)
    return max(results, key=lambda result: result[0])


fg, backdrop = foreground(paint)
# Painted floor shadows below the feet are not part of the figure.
fg[int(np.nonzero(target.any(axis=1))[0].max()) + 6:, :] = False
fg = ndimage.binary_opening(fg, iterations=1)
labels, count = ndimage.label(fg)
fg = labels == (int(np.argmax(ndimage.sum(fg, labels, range(1, count + 1)))) + 1)
candidates = {}
for mirrored in (False, True):
    f = fg[:, ::-1] if mirrored else fg
    candidates[mirrored] = (iou(f, target), register(f))
mirror = candidates[True][1][0] > candidates[False][1][0]
initial_iou, (score, sx, sy, tx, ty) = candidates[mirror]
source = paint[:, ::-1] if mirror else paint
source_fg = fg[:, ::-1] if mirror else fg
registered = warp(source, sx, sy, tx, ty, Image.BICUBIC)
registered_fg = warp(source_fg, sx, sy, tx, ty, Image.NEAREST)
# Extend painted colours outward from a slightly eroded painted silhouette (nearest painted pixel).
core = ndimage.binary_erosion(registered_fg, iterations=2)
_, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
filled = registered[iy, ix]
Image.fromarray(np.clip(filled + 0.5, 0, 255).astype(np.uint8), "RGB").save(out / "painting-registered.png")
edge = target ^ ndimage.binary_erosion(target)
overlay = registered.copy()
overlay[edge] = (255, 0, 255)
Image.fromarray(np.clip(overlay, 0, 255).astype(np.uint8), "RGB").save(out / "overlay.png")
outside = target & ~registered_fg
report = {
    "painting": painting_path.name, "mirrored": bool(mirror),
    "iouAsGenerated": round(candidates[False][0], 4), "iouMirroredUnaligned": round(candidates[True][0], 4),
    "iouRegisteredUnmirrored": round(candidates[False][1][0], 4), "iouRegisteredMirrored": round(candidates[True][1][0], 4),
    "iouFinal": round(score, 4), "scaleX": round(sx, 4), "scaleY": round(sy, 4), "shiftPx": [round(tx, 1), round(ty, 1)],
    "meshPixelsWithoutPaint": int(outside.sum()), "meshPixels": int(target.sum()),
    "backdropSrgb": backdrop.round(1).tolist(),
    "note": "Mesh pixels without paint receive the nearest painted colour (edge extension), not the backdrop.",
}
(out / "registration.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("REGISTER", json.dumps(report))
