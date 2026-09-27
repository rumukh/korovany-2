"""Composite render_rear.py RGBA renders over the concept backdrop and write the exact silhouette mask.

python composite_rear.py <outDir>
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

out = Path(sys.argv[1])
camera = json.loads((out / "rear-camera.json").read_text(encoding="utf-8"))
backdrop = np.array(camera["backdropSrgb"], dtype=np.float32)
for stem in ("rear-clay", "rear-albedo"):
    rgba = np.asarray(Image.open(out / f"{stem}-rgba.png").convert("RGBA"), dtype=np.float32)
    alpha = rgba[..., 3:4] / 255.0
    composite = rgba[..., :3] * alpha + backdrop * (1 - alpha)
    Image.fromarray(np.clip(composite + 0.5, 0, 255).astype(np.uint8), "RGB").save(out / f"{stem}.png")
    if stem == "rear-clay":
        mask = alpha[..., 0] > 0.5
        Image.fromarray((mask * 255).astype(np.uint8), "L").save(out / "rear-mask.png")
        camera["maskPixels"] = int(mask.sum())
(out / "rear-camera.json").write_text(json.dumps(camera, indent=2), encoding="utf-8")
print("COMPOSITE", camera["maskPixels"])
