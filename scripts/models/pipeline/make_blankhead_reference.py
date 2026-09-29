"""Composite the hero body reference: approved soldier concept 4101 with its head replaced by the blank
mannequin head, so two-reference hero concepts take anatomy and style from the soldier and identity only
from the portrait.

Usage: python make_blankhead_reference.py <soldier-seed4101.png> <hero-stance-mannequin.png> <out.png>
Both inputs are original project assets (928x1664). CPU only; no model job is involved. With the recorded
inputs this reproduces hero-body-soldier4101-blankhead-928x1664.png byte for byte
(sha256 958ef9a3030581a9677fd35094f998a571f2b5cd92b6a0378b47e5a217881bc9).
"""
import hashlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ERASE_RECT = (290, 60, 670, 318)
ERASE_ELLIPSE = (330, 250, 610, 380)
RESTORE_FROM_ROW = 345
NECK_GAP = (slice(345, 380), slice(380, 560))  # rows, columns that stay erased below the restore line
HEAD_CROP = (370, 140, 560, 362)
HEAD_SCALE = 1.17
HEAD_CENTRE_X = 470
HEAD_TOP = 128
HEAD_THRESHOLD = 40
HEAD_FADE_ROWS = 24


def mask_array(mask, radius):
    return np.asarray(mask.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)[..., None] / 255.0


def main(soldier_path, mannequin_path, out_path):
    soldier = Image.open(soldier_path).convert("RGB")
    mannequin = Image.open(mannequin_path).convert("RGB")
    width, height = soldier.size
    original = np.asarray(soldier).astype(np.float32)
    corners = np.concatenate([original[:40, :40].reshape(-1, 3), original[:40, -40:].reshape(-1, 3)])
    backdrop = np.median(corners, axis=0)

    erase = Image.new("L", soldier.size, 0)
    draw = ImageDraw.Draw(erase)
    draw.rectangle(ERASE_RECT, fill=255)
    draw.ellipse(ERASE_ELLIPSE, fill=255)
    erase = mask_array(erase, 6)
    out = original * (1.0 - erase) + backdrop * erase

    restore = np.zeros((height, width), np.uint8)
    restore[RESTORE_FROM_ROW:] = 255
    restore[NECK_GAP] = 0
    restore = mask_array(Image.fromarray(restore), 5)
    out = out * (1.0 - restore) + original * restore

    crop = mannequin.crop(HEAD_CROP)
    head = crop.resize((int(crop.width * HEAD_SCALE), int(crop.height * HEAD_SCALE)), Image.LANCZOS)
    head_pixels = np.asarray(head).astype(np.float32)
    mannequin_backdrop = np.asarray(mannequin).astype(np.float32)[5, 5]
    difference = np.abs(head_pixels - mannequin_backdrop).sum(axis=2)
    alpha = Image.fromarray(np.where(difference > HEAD_THRESHOLD, 255, 0).astype(np.uint8))
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.5))
    alpha = np.asarray(alpha).astype(np.float32) / 255.0
    fade = np.ones(head.height, dtype=np.float32)
    fade[-HEAD_FADE_ROWS:] = np.linspace(1.0, 0.0, HEAD_FADE_ROWS)
    alpha = (alpha * fade[:, None])[..., None]

    x0 = HEAD_CENTRE_X - head.width // 2
    y0 = HEAD_TOP
    region = out[y0:y0 + head.height, x0:x0 + head.width]
    out[y0:y0 + head.height, x0:x0 + head.width] = region * (1.0 - alpha) + head_pixels * alpha

    Image.fromarray(out.astype(np.uint8)).save(out_path)
    print(hashlib.sha256(open(out_path, "rb").read()).hexdigest())


if __name__ == "__main__":
    main(*sys.argv[1:4])
