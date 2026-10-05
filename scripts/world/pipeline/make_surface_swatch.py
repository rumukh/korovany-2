"""Tileable layout swatches for local surface-texture generation (Qwen Image Edit Plus 2511, Scene mode).

A swatch is a flat diagram of a surface at its true physical scale: base colour noise plus layers of simple shapes
(blobs, ellipses, strokes, rows of boards or shingles, stone cells, dashes) whose sizes are given in metres. The edit
model turns the diagram into a photograph while keeping each shape's position and size, which fixes the texture's
feature scale and keeps it tileable (every shape wraps around the edges). Deterministic from the recipe's seed.
Offline authoring only; nothing here runs in the game.

    python make_surface_swatch.py <recipe.json> <out.png>
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1328
SUPER = 2


def hex_rgb(colour: str) -> tuple[int, int, int]:
    return tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))


def value_noise(size: int, cells: int, rng: np.random.Generator) -> np.ndarray:
    lattice = rng.random((cells, cells))
    coords = np.arange(size) * cells / size
    i0 = np.floor(coords).astype(int) % cells
    i1 = (i0 + 1) % cells
    t = coords - np.floor(coords)
    t = t * t * (3 - 2 * t)
    top = lattice[i0][:, i0] * (1 - t)[None, :] + lattice[i0][:, i1] * t[None, :]
    bottom = lattice[i1][:, i0] * (1 - t)[None, :] + lattice[i1][:, i1] * t[None, :]
    return top * (1 - t)[:, None] + bottom * t[:, None]


def fbm(size: int, cells: int, octaves: int, rng: np.random.Generator) -> np.ndarray:
    total, amplitude, norm = np.zeros((size, size)), 1.0, 0.0
    for _ in range(octaves):
        total += value_noise(size, cells, rng) * amplitude
        norm += amplitude
        amplitude *= 0.5
        cells *= 2
    return total / norm


def ramp(field: np.ndarray, colours: list[str]) -> np.ndarray:
    stops = np.linspace(0, 1, len(colours))
    rgb = np.array([hex_rgb(c) for c in colours], dtype=np.float32)
    low, high = np.percentile(field, [2, 98])
    field = np.clip((field - low) / max(high - low, 1e-6), 0, 1)
    return np.stack([np.interp(field, stops, rgb[:, channel]) for channel in range(3)], axis=-1)


class Canvas:
    """A supersampled canvas whose shapes wrap around the edges, so the swatch tiles exactly."""

    def __init__(self, base: np.ndarray, metres: float):
        self.size = SIZE * SUPER
        self.scale = self.size / metres
        self.image = Image.fromarray(np.uint8(np.clip(base, 0, 255))).resize((self.size, self.size), Image.Resampling.BICUBIC)
        self.draw = ImageDraw.Draw(self.image)

    def wrapped(self, x: float, z: float, reach: float):
        offsets = [0.0]
        for value in (x, z):
            pass
        for dx in (-self.size, 0, self.size):
            for dz in (-self.size, 0, self.size):
                if -reach <= x + dx <= self.size + reach and -reach <= z + dz <= self.size + reach:
                    yield x + dx, z + dz

    def polygon(self, points: list[tuple[float, float]], colour: tuple[int, int, int]) -> None:
        xs = [p[0] for p in points]
        zs = [p[1] for p in points]
        cx, cz = sum(xs) / len(xs), sum(zs) / len(zs)
        reach = max(max(xs) - min(xs), max(zs) - min(zs))
        for wx, wz in self.wrapped(cx, cz, reach):
            self.draw.polygon([(x - cx + wx, z - cz + wz) for x, z in points], fill=colour)

    def line(self, a: tuple[float, float], b: tuple[float, float], width: float, colour: tuple[int, int, int]) -> None:
        cx, cz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        reach = math.hypot(b[0] - a[0], b[1] - a[1])
        for wx, wz in self.wrapped(cx, cz, reach):
            self.draw.line([(a[0] - cx + wx, a[1] - cz + wz), (b[0] - cx + wx, b[1] - cz + wz)], fill=colour,
                           width=max(1, round(width)))


def jitter(colour: str, rng: np.random.Generator, amount: float) -> tuple[int, int, int]:
    r, g, b = hex_rgb(colour)
    k = 1 + rng.uniform(-amount, amount)
    return tuple(int(np.clip(v * k, 0, 255)) for v in (r, g, b))


def blob(canvas: Canvas, rng: np.random.Generator, x: float, z: float, radius: float, colour, lumpy: float = 0.35) -> None:
    sides = 18
    phase = rng.uniform(0, math.tau, 3)
    points = []
    for i in range(sides):
        angle = i / sides * math.tau
        wobble = 1 + lumpy * (0.5 * math.sin(angle * 2 + phase[0]) + 0.3 * math.sin(angle * 3 + phase[1])
                              + 0.2 * math.sin(angle * 5 + phase[2]))
        points.append((x + math.cos(angle) * radius * wobble, z + math.sin(angle) * radius * wobble))
    canvas.polygon(points, colour)


def ellipse(canvas: Canvas, x: float, z: float, length: float, width: float, angle: float, colour) -> None:
    points = []
    for i in range(14):
        t = i / 14 * math.tau
        u, v = math.cos(t) * length / 2, math.sin(t) * width / 2
        points.append((x + u * math.cos(angle) - v * math.sin(angle), z + u * math.sin(angle) + v * math.cos(angle)))
    canvas.polygon(points, colour)


def layer(canvas: Canvas, spec: dict, rng: np.random.Generator, metres: float) -> None:
    kind, s = spec["kind"], canvas.scale
    colours = spec["colours"]
    area = metres * metres
    count = int(round(spec.get("perSquareMetre", 0) * area))
    if kind == "blobs":
        for _ in range(count):
            radius = rng.uniform(*spec["radius"]) * s
            blob(canvas, rng, rng.uniform(0, canvas.size), rng.uniform(0, canvas.size), radius,
                 jitter(rng.choice(colours), rng, 0.12), spec.get("lumpy", 0.35))
    elif kind == "ellipses":
        for _ in range(count):
            length = rng.uniform(*spec["length"]) * s
            width = length * rng.uniform(*spec["aspect"])
            ellipse(canvas, rng.uniform(0, canvas.size), rng.uniform(0, canvas.size), length, width,
                    rng.uniform(0, math.tau), jitter(rng.choice(colours), rng, 0.15))
    elif kind == "strokes":
        orientation = spec.get("orientation")
        for _ in range(count):
            length = rng.uniform(*spec["length"]) * s
            angle = rng.uniform(0, math.tau) if orientation is None else math.radians(orientation) + rng.normal(0, math.radians(spec.get("spread", 8)))
            x, z = rng.uniform(0, canvas.size), rng.uniform(0, canvas.size)
            dx, dz = math.cos(angle) * length / 2, math.sin(angle) * length / 2
            canvas.line((x - dx, z - dz), (x + dx, z + dz), spec["width"] * s, jitter(rng.choice(colours), rng, 0.15))
    elif kind == "rows":
        # Boards, shakes or thatch courses: rows of rectangles with gaps; `vertical` turns rows into columns.
        row, gap = spec["row"] * s, spec["gap"] * s
        rows = max(1, round(canvas.size / row))
        row = canvas.size / rows
        for r in range(rows):
            offset = rng.uniform(0, canvas.size) if spec.get("stagger", True) else 0
            position = 0.0
            while position < canvas.size:
                length = rng.uniform(*spec["length"]) * s
                colour = jitter(rng.choice(colours), rng, 0.14)
                a, b = position + offset, position + offset + length - gap
                top, bottom = r * row + gap / 2, (r + 1) * row - gap / 2
                if spec.get("vertical"):
                    canvas.polygon([(top, a), (bottom, a), (bottom, b), (top, b)], colour)
                else:
                    canvas.polygon([(a, top), (b, top), (b, bottom), (a, bottom)], colour)
                position += length
    elif kind == "stones":
        # Irregular fieldstones on a jittered grid, each a lumpy polygon; the mortar is the base colour between them.
        # `fill` (radius as a fraction of the cell, default 0.36-0.47) above 0.5 makes neighbours overlap like scales.
        cell = spec["cell"] * s
        cells = max(2, round(canvas.size / cell))
        cell = canvas.size / cells
        fill = spec.get("fill", (0.36, 0.47))
        for i in range(cells):
            for j in range(cells):
                x = (i + 0.5 + rng.uniform(-0.25, 0.25)) * cell
                z = (j + 0.5 + rng.uniform(-0.25, 0.25)) * cell
                radius = cell * rng.uniform(*fill)
                blob(canvas, rng, x, z, radius, jitter(rng.choice(colours), rng, 0.15), 0.18)
    elif kind == "courses":
        # Rubble laid in rough courses: rows of random height (rescaled to fill the tile exactly, so it tiles), stones
        # of random width packed along each row with thin joints, each stone a lumpy ellipse filling its slot; the
        # mortar is the base colour in the joints. `squareness` above 2 makes each stone a superellipse of that exponent
        # (blockier stones and less mortar in the slot corners); without it the layout is the original ellipses.
        heights, widths, joint = spec["height"], spec["width"], spec["joint"] * s
        squareness = spec.get("squareness")
        sides = 24 if squareness else 14
        rows = []
        while sum(rows) < canvas.size:
            rows.append(rng.uniform(*heights) * s)
        rows = [row * canvas.size / sum(rows) for row in rows]
        z = 0.0
        for row in rows:
            x = rng.uniform(0, canvas.size)
            end = x + canvas.size
            while x < end - 1:
                width = rng.uniform(*widths) * s
                if end - x < width * 1.5:
                    width = end - x
                cx, cz = x + width / 2, z + row / 2 + rng.uniform(-0.06, 0.06) * row
                points = []
                for k in range(sides):
                    angle = math.tau * k / sides
                    wobble = 1 + rng.uniform(-0.12, 0.06)
                    c, n = math.cos(angle), math.sin(angle)
                    if squareness:
                        c = math.copysign(abs(c) ** (2 / squareness), c)
                        n = math.copysign(abs(n) ** (2 / squareness), n)
                    points.append((cx + c * (width / 2 - joint) * wobble, cz + n * (row / 2 - joint) * wobble))
                canvas.polygon(points, jitter(rng.choice(colours), rng, 0.15))
                x += width
            z += row
    else:
        raise ValueError(f"unknown layer kind {kind}")


def main() -> None:
    recipe = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    swatch = recipe["swatch"]
    metres = float(recipe["physicalSizeMetres"])
    rng = np.random.default_rng(int(swatch["seed"]))
    cells = max(2, round(metres / swatch.get("noiseMetres", 1.0)))
    base = ramp(fbm(SIZE, cells, 5, rng), swatch["colours"])
    canvas = Canvas(base, metres)
    for spec in swatch.get("layers", []):
        layer(canvas, spec, rng, metres)
    image = canvas.image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    if swatch.get("soften"):
        image = image.filter(ImageFilter.GaussianBlur(float(swatch["soften"])))
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    print(json.dumps({"swatch": str(out), "size": SIZE, "pixelsPerMetre": SIZE / metres}))


if __name__ == "__main__":
    main()
