"""Register a rear-view painting to the mesh's orthographic back silhouette with a silhouette-driven warp.

python register_rear_warp.py <painting.png> <rear-mask.png> <outDir> [--orientation=painted|mirrored]

Qwen keeps the pose of the grey sculpt it repaints but not always its proportions (a taller figure, longer legs).
A global scale and shift (register_rear.py) then leaves painted boots on the trousers and a tunic hem on the
thighs. This version (1) fits a global anisotropic scale and shift from the silhouettes' bounding boxes, refined
by silhouette IoU, then (2) warps rows with a monotonic dynamic-programming alignment of the two silhouettes'
row profiles (width, centre, run count) and (3) maps each row horizontally piecewise-linearly between matching
silhouette runs (torso, arms, legs). The warp is smoothed so it never tears.

Writes painting-registered.png (mesh frame, painted colours extended past the painted silhouette),
overlay.png, warp.png (displacement field) and registration.json. Both mirror orientations are scored.
--orientation overrides the automatic choice after review (for example when the painted pouch would land on the
hip without the pouch geometry); both scores are still recorded. Without it the output is unchanged.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

painting_path, mask_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
forced = next((arg.split("=", 1)[1] for arg in sys.argv[4:] if arg.startswith("--orientation=")), None)
if forced not in (None, "painted", "mirrored"):
    raise SystemExit(f"unknown orientation {forced}")
out.mkdir(parents=True, exist_ok=True)
paint = np.asarray(Image.open(painting_path).convert("RGB"), dtype=np.float32)
target = np.asarray(Image.open(mask_path).convert("L")) > 127
H, W = target.shape
if paint.shape[:2] != (H, W):
    raise SystemExit(f"painting {paint.shape[:2]} does not match mask {(H, W)}")


def backdrop_model(image, figure):
    """Per-channel quadratic fit of the backdrop over pixels well outside the figure (painted backdrops are graded)."""
    h, w = image.shape[:2]
    outside = ~ndimage.binary_dilation(figure, iterations=12)
    ys, xs = np.nonzero(outside)
    step = max(1, len(ys) // 40000)
    ys, xs = ys[::step], xs[::step]

    def basis(y, x):
        u, v = x / w - 0.5, y / h - 0.5
        return np.stack([np.ones_like(u), u, v, u * u, v * v, u * v], axis=-1)

    coefficients, *_ = np.linalg.lstsq(basis(ys.astype(np.float64), xs.astype(np.float64)), image[ys, xs].astype(np.float64), rcond=None)
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float64)
    return basis(gy, gx) @ coefficients


def foreground(image):
    border = np.concatenate([image[:6].reshape(-1, 3), image[-6:].reshape(-1, 3), image[:, :6].reshape(-1, 3), image[:, -6:].reshape(-1, 3)])
    backdrop = np.median(border, axis=0)
    raw = np.abs(image - backdrop).sum(axis=2) > 30

    def largest(mask):
        labels, count = ndimage.label(mask)
        if count == 0:
            raise SystemExit("no foreground found in painting")
        sizes = ndimage.sum(mask, labels, range(1, count + 1))
        return labels == (int(np.argmax(sizes)) + 1)

    first = ndimage.binary_fill_holes(ndimage.binary_closing(largest(ndimage.binary_opening(raw, iterations=2)), iterations=3))
    model = backdrop_model(image, first)
    # Painted floor shading (shadows and light pools) is the backdrop darkened or brightened, often cooled toward
    # blue-grey; it is unsaturated. Drop it in the lower part of the frame so the feet, not the floor, bound the figure.
    ratio = image / np.maximum(model, 1.0)
    grey = (ratio.max(axis=2) - ratio.min(axis=2)) < 0.08
    shade = (ratio.mean(axis=2) > 0.2) & (ratio.mean(axis=2) < 1.8)
    saturation = (image.max(axis=2) - image.min(axis=2)) / np.maximum(image.max(axis=2), 1.0)
    floor_tone = (saturation < 0.16) & (image.mean(axis=2) > 90)
    # Warm floor gradients stay bright: in the bottom fifth only the dark boots and trousers are figure.
    floor_tone |= image.mean(axis=2) > 0.72 * float(np.median(model[..., :].mean(axis=2)))
    rows = np.arange(image.shape[0])[:, None] > image.shape[0] * 0.8
    fg = largest(ndimage.binary_opening(raw & ~((grey & shade) | floor_tone) & rows | raw & ~rows, iterations=2))
    # Remaining floor slivers are thin horizontal strips beside the boots: a vertical opening removes them.
    low = np.zeros_like(fg)
    low[int(image.shape[0] * 0.8):] = True
    fg = largest((fg & ~low) | (ndimage.binary_opening(fg, structure=np.ones((9, 1), dtype=bool)) & low))
    solid = ndimage.binary_fill_holes(ndimage.binary_closing(fg, iterations=3))
    # Filling holes also fills backdrop enclosed by the figure (the gap between the legs when a floor shadow joins the
    # boots, the space under an arm). Such regions match the backdrop model and are large: they are not paint.
    backdrop_like = np.abs(image - model).sum(axis=2) < 36
    enclosed = solid & backdrop_like
    labels, count = ndimage.label(enclosed)
    if count:
        sizes = ndimage.sum(enclosed, labels, range(1, count + 1))
        large = np.isin(labels, np.flatnonzero(sizes >= 300) + 1)
        solid &= ~ndimage.binary_dilation(large, iterations=1)
        solid = largest(ndimage.binary_opening(solid, iterations=1))
    return solid, backdrop


def iou(a, b):
    return float((a & b).sum() / max(1, (a | b).sum()))


def bbox(mask):
    rows, cols = np.nonzero(mask.any(axis=1))[0], np.nonzero(mask.any(axis=0))[0]
    return rows.min(), rows.max(), cols.min(), cols.max()


def affine_warp(array, sx, sy, tx, ty, resample):
    """Output pixel (x, y) samples input ((x - tx - cx) / sx + cx, (y - ty - cy) / sy + cy) about the target centre."""
    cy, cx = ndimage.center_of_mass(target)
    a, e = 1 / sx, 1 / sy
    c = cx - (cx + tx) * a
    f = cy - (cy + ty) * e
    mode = "L" if array.ndim == 2 else "RGB"
    image = Image.fromarray(array.astype(np.uint8) if array.dtype != bool else (array * 255).astype(np.uint8), mode)
    warped = image.transform((W, H), Image.AFFINE, (a, 0, c, 0, e, f), resample=resample)
    result = np.asarray(warped)
    return result > 127 if array.dtype == bool else result.astype(np.float32)


def global_fit(fg):
    """Bounding-box initial scale/shift, then coarse-to-fine IoU refinement."""
    t0, t1, l0, l1 = bbox(target)
    p0, p1, q0, q1 = bbox(fg)
    sy, sx = (t1 - t0) / max(1, p1 - p0), (l1 - l0) / max(1, q1 - q0)
    cy, cx = ndimage.center_of_mass(target)
    # Map the painted top and horizontal centre onto the mesh's.
    ty = t0 - ((p0 - cy) * sy + cy)
    tx = (l0 + l1) / 2 - (((q0 + q1) / 2 - cx) * sx + cx)
    params = [sx, sy, tx, ty]
    best = (iou(affine_warp(fg, *params, Image.NEAREST), target), *params)
    for step_scale, step_shift in ((0.02, 8), (0.01, 4), (0.005, 2), (0.0025, 1)):
        improved = True
        while improved:
            improved = False
            for index, delta in ((0, step_scale), (0, -step_scale), (1, step_scale), (1, -step_scale),
                                 (2, step_shift), (2, -step_shift), (3, step_shift), (3, -step_shift)):
                trial = list(best[1:])
                trial[index] += delta
                score = iou(affine_warp(fg, *trial, Image.NEAREST), target)
                if score > best[0] + 1e-5:
                    best = (score, *trial)
                    improved = True
    return best


def runs(row):
    """(start, end) of each run of True in a boolean row, end exclusive."""
    padded = np.concatenate([[False], row, [False]])
    change = np.flatnonzero(padded[1:] != padded[:-1])
    return list(zip(change[::2], change[1::2]))


def profile(mask):
    widths = mask.sum(axis=1).astype(np.float64)
    cols = np.arange(W)
    centre = np.where(widths > 0, (mask * cols).sum(axis=1) / np.maximum(widths, 1), np.nan)
    count = np.array([len(runs(r)) for r in mask], dtype=np.float64)
    return widths, centre, count


def align_rows(target_mask, paint_mask, band=90):
    """Monotonic row mapping target row -> painted row by dynamic programming over row-profile differences."""
    tw, tc, tn = profile(target_mask)
    pw, pc, pn = profile(paint_mask)
    rows_t = np.flatnonzero(tw > 0)
    rows_p = np.flatnonzero(pw > 0)
    t0, t1 = rows_t.min(), rows_t.max()
    p0, p1 = rows_p.min(), rows_p.max()
    scale = max(tw.max(), 1)
    ts = np.arange(t0, t1 + 1)
    ps = np.arange(p0, p1 + 1)
    # Nominal linear correspondence; the DP may deviate by at most `band` rows from it.
    nominal = p0 + (ts - t0) * (p1 - p0) / max(1, t1 - t0)
    n, m = len(ts), len(ps)
    inf = 1e18
    cost = np.full((n, m), inf)
    for i, y in enumerate(ts):
        lo = max(0, int(nominal[i] - band - p0))
        hi = min(m, int(nominal[i] + band - p0) + 1)
        yp = ps[lo:hi]
        width_term = np.abs(tw[y] - pw[yp]) / scale
        centre_term = np.nan_to_num(np.abs(tc[y] - pc[yp]) / scale, nan=1.0)
        count_term = 0.08 * np.minimum(np.abs(tn[y] - pn[yp]), 3)
        # Derivative of the width profile marks features (shoulders, hem, boot tops).
        dt = tw[min(y + 3, H - 1)] - tw[max(y - 3, 0)]
        dp = pw[np.minimum(yp + 3, H - 1)] - pw[np.maximum(yp - 3, 0)]
        edge_term = 0.6 * np.abs(dt - dp) / scale
        cost[i, lo:hi] = width_term + 0.5 * centre_term + count_term + edge_term
    # DP: from (i-1, j') to (i, j) with j - j' in {0, 1, 2} (slope 0..2 rows per row).
    acc = np.full((n, m), inf)
    back = np.zeros((n, m), dtype=np.int8)
    acc[0] = cost[0] + np.abs(np.arange(m)) * 0.02
    for i in range(1, n):
        prev = acc[i - 1]
        options = np.stack([prev, np.concatenate([[inf], prev[:-1]]), np.concatenate([[inf, inf], prev[:-2]])])
        penalty = np.array([0.03, 0.0, 0.03])[:, None]
        total = options + penalty
        choice = np.argmin(total, axis=0)
        acc[i] = cost[i] + total[choice, np.arange(m)]
        back[i] = choice
    j = int(np.argmin(acc[-1] + np.abs(np.arange(m) - (m - 1)) * 0.02))
    path = np.empty(n, dtype=np.float64)
    for i in range(n - 1, -1, -1):
        path[i] = ps[j]
        j -= int(back[i, j])
        j = max(j, 0)
    # Smooth the mapping so neighbouring rows never sample far-apart painted rows.
    path = ndimage.gaussian_filter1d(path, 6, mode="nearest")
    mapping = np.interp(np.arange(H), ts, path)
    mapping[:t0] = path[0] - (t0 - np.arange(t0))
    mapping[t1 + 1:] = path[-1] + (np.arange(t1 + 1, H) - t1)
    return mapping


def column_maps(target_mask, paint_mask, row_map, limit=24.0):
    """Per target row, a gentle horizontal correction: each target run is matched to the painted run it overlaps
    most (the global fit already aligns parts roughly); matched run ends define a piecewise-linear x map whose
    displacement from the identity is clamped to `limit` pixels and smoothed across rows, so run-count changes
    (armpits, hands, pouch, crotch) never tear the painting."""
    xs = np.arange(W, dtype=np.float64)
    shift = np.zeros((H, W))
    valid = np.zeros(H, dtype=bool)
    for y in range(H):
        t_runs = runs(target_mask[y])
        if not t_runs:
            continue
        yp = int(round(np.clip(row_map[y], 0, H - 1)))
        p_runs = runs(paint_mask[yp])
        if not p_runs:
            continue
        knots_t, knots_p = [], []
        for a, b in t_runs:
            overlaps = [max(0, min(b, d) - max(a, c)) for c, d in p_runs]
            best = int(np.argmax(overlaps))
            if overlaps[best] <= 0.3 * (b - a):
                continue
            c, d = p_runs[best]
            knots_t += [a, b - 1]
            knots_p += [c, d - 1]
        if len(knots_t) < 2:
            continue
        knots_t, knots_p = np.array(knots_t, dtype=np.float64), np.array(knots_p, dtype=np.float64)
        order = np.argsort(knots_t, kind="stable")
        knots_t, knots_p = knots_t[order], knots_p[order]
        keep = np.concatenate([[True], np.diff(knots_t) > 0])
        knots_t, knots_p = knots_t[keep], knots_p[keep]
        delta = np.clip(knots_p - knots_t, -limit, limit)
        shift[y] = np.interp(xs, knots_t, delta)
        valid[y] = True
    rows = np.flatnonzero(valid)
    for y in range(H):
        if not valid[y] and len(rows):
            shift[y] = shift[rows[np.argmin(np.abs(rows - y))]]
    shift = ndimage.gaussian_filter1d(shift, 8, axis=0, mode="nearest")
    shift = ndimage.gaussian_filter1d(shift, 4, axis=1, mode="nearest")
    return xs[None, :] + shift


def sample(image, map_y, map_x, order):
    if image.ndim == 2:
        return ndimage.map_coordinates(image.astype(np.float32), [map_y, map_x], order=order, mode="nearest")
    return np.dstack([ndimage.map_coordinates(image[..., c], [map_y, map_x], order=order, mode="nearest") for c in range(image.shape[2])])


fg, backdrop = foreground(paint)
# The orientation is decided by appearance, not silhouette: a near-symmetric A-pose scores almost the same IoU
# either way. Edges of the painting (after the global fit) are correlated with the shaded edges of the mesh's
# own back render (rear-clay.png beside the mask): pouches, belts, straps and hems line up only one way round.
clay_path = mask_path.with_name("rear-clay.png")
clay = np.asarray(Image.open(clay_path).convert("L"), dtype=np.float32) if clay_path.exists() else None


def edges(luminance):
    smooth = ndimage.gaussian_filter(luminance, 2.0)
    magnitude = np.hypot(ndimage.sobel(smooth, axis=0), ndimage.sobel(smooth, axis=1))
    inner = ndimage.binary_erosion(target, iterations=6)
    magnitude[~inner] = 0
    return magnitude / max(float(magnitude[inner].std()), 1e-6)


clay_edges = edges(clay) if clay is not None else None
candidates = {}
for mirrored in (False, True):
    f = fg[:, ::-1] if mirrored else fg
    fit = global_fit(f)
    correlation = None
    if clay_edges is not None:
        fitted = affine_warp(paint[:, ::-1] if mirrored else paint, *fit[1:], Image.BILINEAR)
        painted_edges = edges(fitted.mean(axis=2))
        correlation = float((clay_edges * painted_edges).sum() / max(np.sqrt((clay_edges ** 2).sum() * (painted_edges ** 2).sum()), 1e-9))
    candidates[mirrored] = (iou(f, target), fit, correlation)
if clay_edges is not None:
    # Qwen keeps the reference layout unless the evidence clearly says otherwise.
    mirror = candidates[True][2] > candidates[False][2] * 1.04
else:
    mirror = candidates[True][1][0] > candidates[False][1][0] + 0.01
automatic = mirror
if forced:
    mirror = forced == "mirrored"
initial_iou, (global_iou, sx, sy, tx, ty), _ = candidates[mirror]
source = paint[:, ::-1] if mirror else paint
source_fg = fg[:, ::-1] if mirror else fg
affine = affine_warp(source, sx, sy, tx, ty, Image.BICUBIC)
affine_fg = affine_warp(source_fg, sx, sy, tx, ty, Image.NEAREST)
row_map = align_rows(target, affine_fg)
col_map = column_maps(target, affine_fg, row_map)
map_y = np.repeat(row_map[:, None], W, axis=1)
registered = sample(affine, map_y, col_map, 1)
registered_fg = sample(affine_fg.astype(np.float32), map_y, col_map, 1) > 0.5
warp_iou = iou(registered_fg, target)
core = ndimage.binary_erosion(registered_fg, iterations=2)
_, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
filled = registered[iy, ix]
Image.fromarray(np.clip(filled + 0.5, 0, 255).astype(np.uint8), "RGB").save(out / "painting-registered.png")
edge = target ^ ndimage.binary_erosion(target)
overlay = registered.copy()
overlay[edge] = (255, 0, 255)
Image.fromarray(np.clip(overlay, 0, 255).astype(np.uint8), "RGB").save(out / "overlay.png")
dy = row_map - np.arange(H)
dx = col_map - np.arange(W)[None, :]
magnitude = np.hypot(np.repeat(dy[:, None], W, axis=1), dx)
inside = target
visual = np.zeros((H, W, 3), dtype=np.uint8)
visual[..., 0] = np.clip(np.abs(np.repeat(dy[:, None], W, axis=1)) * 6, 0, 255).astype(np.uint8)
visual[..., 1] = np.clip(np.abs(dx) * 6, 0, 255).astype(np.uint8)
visual[~inside] //= 4
Image.fromarray(visual, "RGB").save(out / "warp.png")
outside = target & ~registered_fg
report = {
    "painting": painting_path.name, "method": "global anisotropic affine + DP row alignment + piecewise-linear run mapping",
    "mirrored": bool(mirror), "iouAsGenerated": round(candidates[False][0], 4),
    "iouGlobalUnmirrored": round(candidates[False][1][0], 4), "iouGlobalMirrored": round(candidates[True][1][0], 4),
    "orientationEdgeCorrelation": {"unmirrored": candidates[False][2], "mirrored": candidates[True][2],
                                   "reference": clay_path.name if clay is not None else None},
    "iouGlobal": round(global_iou, 4), "iouFinal": round(warp_iou, 4),
    "scaleX": round(sx, 4), "scaleY": round(sy, 4), "shiftPx": [round(tx, 1), round(ty, 1)],
    "warpBeyondAffinePx": {"meanInside": round(float(magnitude[inside].mean()), 2), "p95Inside": round(float(np.percentile(magnitude[inside], 95)), 2),
                           "maxInside": round(float(magnitude[inside].max()), 2)},
    "meshPixelsWithoutPaint": int(outside.sum()), "meshPixels": int(target.sum()),
    "backdropSrgb": backdrop.round(1).tolist(),
    "note": "Mesh pixels without paint receive the nearest painted colour (edge extension), not the backdrop.",
}
if forced:
    report["orientation"] = {"forced": forced, "automatic": "mirrored" if automatic else "painted"}
(out / "registration.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print("REGISTER", json.dumps(report))
