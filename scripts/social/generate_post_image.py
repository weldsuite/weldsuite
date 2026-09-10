#!/usr/bin/env python3
"""Generate an on-brand WeldSuite social still image."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from PIL import Image, ImageDraw

from brand import (
    BLUE,
    BLUE_LIGHT,
    BORDER,
    INK,
    LOGO_HORIZONTAL,
    MUTED,
    SIZES,
    SURFACE,
    WHITE,
    chip,
    ensure_parent,
    fetch_logo,
    load_font,
    paste_logo,
    rounded_rect,
    wrap_text,
)


def render(
    headline: str,
    subhead: str,
    label: str,
    size_name: str,
    dark: bool,
    out: Path,
) -> None:
    w, h = SIZES[size_name]
    scale = 2
    W, H = w * scale, h * scale
    bg = (10, 10, 10, 255) if dark else WHITE
    ink = WHITE if dark else INK
    surface = (28, 28, 28, 255) if dark else SURFACE
    border = (55, 55, 55, 255) if dark else BORDER

    canvas = Image.new("RGBA", (W, H), bg)
    draw = ImageDraw.Draw(canvas)

    # Soft accent gradient bar at top
    for i in range(12 * scale):
        t = i / (12 * scale)
        r = int(BLUE[0] * (1 - t) + BLUE_LIGHT[0] * t)
        g = int(BLUE[1] * (1 - t) + BLUE_LIGHT[1] * t)
        b = int(BLUE[2] * (1 - t) + BLUE_LIGHT[2] * t)
        draw.line([(0, i), (W, i)], fill=(r, g, b, 255))

    logo_url = LOGO_HORIZONTAL  # blue+navy works on light; on dark use white logo URL
    if dark:
        from brand import LOGO_ON_DARK

        logo_url = LOGO_ON_DARK
    logo = fetch_logo(logo_url)
    paste_logo(canvas, logo, max_h=56 * scale, pad=64 * scale)

    font_label = load_font(28 * scale)
    font_h = load_font(64 * scale, bold=True)
    font_s = load_font(34 * scale)

    y = 160 * scale
    y = chip(draw, 64 * scale, y, label, font_label)

    # Content card
    card = (64 * scale, y, W - 64 * scale, H - 120 * scale)
    rounded_rect(draw, card, radius=32 * scale, fill=surface, outline=border, width=2 * scale)

    pad = 48 * scale
    max_text_w = card[2] - card[0] - pad * 2
    ty = card[1] + pad
    for line in wrap_text(headline, font_h, max_text_w, draw):
        draw.text((card[0] + pad, ty), line, font=font_h, fill=ink)
        ty += int(font_h.size * 1.2)
    ty += 24 * scale
    for line in wrap_text(subhead, font_s, max_text_w, draw):
        draw.text((card[0] + pad, ty), line, font=font_s, fill=MUTED if not dark else (180, 180, 180, 255))
        ty += int(font_s.size * 1.35)

    final = canvas.resize((w, h), Image.Resampling.LANCZOS)
    ensure_parent(out)
    final.convert("RGB").save(out, "PNG", optimize=True)
    print(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--headline", required=True)
    p.add_argument("--subhead", default="")
    p.add_argument("--label", default="WeldSuite")
    p.add_argument(
        "--size",
        choices=list(SIZES.keys()),
        default="instagram_feed",
    )
    p.add_argument("--dark", action="store_true")
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    render(args.headline, args.subhead, args.label, args.size, args.dark, args.out)


if __name__ == "__main__":
    main()
