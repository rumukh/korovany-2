"""Optimize generated masters and record verifiable delivery provenance."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("masters", type=Path)
parser.add_argument("--output", type=Path, default=ROOT / "public" / "portraits")
args = parser.parse_args()
catalog = json.loads((Path(__file__).with_name("catalog.json")).read_text(encoding="utf-8"))
args.output.mkdir(parents=True, exist_ok=True)
entries = []
sheet = Image.new("RGB", (5 * 224, 5 * 252), "#151e1b")
draw = ImageDraw.Draw(sheet)

for index, character in enumerate(catalog["characters"]):
    identity = character["id"]
    source = args.masters / f"{identity}.png"
    receipt = json.loads(source.with_suffix(".json").read_text(encoding="utf-8-sig"))
    prompt = character["subject"] + "\n\n" + catalog["style"]
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if receipt["sha256"] != source_hash or receipt["prompt"].replace("\r\n", "\n") != prompt:
        raise ValueError(f"Master provenance mismatch: {identity}")
    with Image.open(source) as image:
        image.load()
        if image.size != (1024, 1024) or image.format != "PNG":
            raise ValueError(f"Invalid master: {identity}")
        delivery = image.convert("RGB").resize((320, 320), Image.Resampling.LANCZOS)
        destination = args.output / f"{identity}.webp"
        delivery.save(destination, "WEBP", quality=84, method=6)
        with Image.open(destination) as decoded:
            decoded.load()
            if decoded.size != (320, 320) or decoded.format != "WEBP":
                raise ValueError(f"Invalid delivery: {identity}")
        if destination.stat().st_size > 40_000:
            raise ValueError(f"Portrait exceeds 40 KB budget: {identity}")
        x, y = (index % 5) * 224, (index // 5) * 252
        sheet.paste(delivery.resize((208, 208), Image.Resampling.LANCZOS), (x + 8, y + 8))
        draw.text((x + 8, y + 222), identity, fill="#efe6d2")
    entries.append({
        "id": identity,
        "kind": character["kind"],
        "name": character["name"],
        **({"faction": character["faction"]} if "faction" in character else {}),
        "file": f"{identity}.webp",
        "width": 320,
        "height": 320,
        "format": "webp",
        "bytes": destination.stat().st_size,
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "master": {"file": source.name, "width": 1024, "height": 1024, "format": "png", "sha256": source_hash},
        "generatedAt": receipt["completedAt"],
        "prompt": prompt,
        "revisedPrompt": receipt["result"]["revised_prompt"],
    })

total = sum(entry["bytes"] for entry in entries)
if total > 700_000:
    raise ValueError(f"Portrait set exceeds 700 KB budget: {total}")
manifest = {
    "version": 1,
    "model": catalog["model"],
    "provider": catalog["provider"],
    "apiVersion": "2024-02-01",
    "settings": catalog["settings"],
    "attribution": catalog["attribution"],
    "identityPolicy": catalog["identityPolicy"],
    "delivery": {"quality": 84, "resampler": "Pillow LANCZOS", "totalBytes": total},
    "portraits": entries,
}
(args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
sheet.save(args.masters / "contact-sheet.jpg", quality=94)
print(json.dumps({"count": len(entries), "totalBytes": total, "output": str(args.output), "contactSheet": str(args.masters / "contact-sheet.jpg")}))
