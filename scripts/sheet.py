"""Turns a spritesheet into the looping picture for one of her scenes.

    python scripts/sheet.py <sheet.png> <scene> [--cols 4] [--rows 4] [--ms 110]

Frames are read left to right, top to bottom, scaled to the size of her still
scenes, and written to assets/scenes/<scene>.anim.webp. The scene must then be
named in ANIMATED_SCENES in src/companion/lines.ts. Needs Pillow.
"""

import argparse
from pathlib import Path

from PIL import Image

SCENE_SIZE = (600, 400)

parser = argparse.ArgumentParser()
parser.add_argument("sheet")
parser.add_argument("scene")
parser.add_argument("--cols", type=int, default=4)
parser.add_argument("--rows", type=int, default=4)
parser.add_argument("--ms", type=int, default=110, help="how long each frame is held")
parser.add_argument("--quality", type=int, default=82)
args = parser.parse_args()

sheet = Image.open(args.sheet).convert("RGB")
width, height = sheet.width // args.cols, sheet.height // args.rows

frames = [
    sheet.crop((col * width, row * height, (col + 1) * width, (row + 1) * height)).resize(SCENE_SIZE, Image.LANCZOS)
    for row in range(args.rows)
    for col in range(args.cols)
]

out = Path(__file__).resolve().parent.parent / "assets" / "scenes" / f"{args.scene}.anim.webp"
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=args.ms,
    loop=0,
    quality=args.quality,
    method=6,
)
print(f"{out}: {len(frames)} frames, {out.stat().st_size // 1024} KB")
