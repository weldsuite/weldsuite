#!/usr/bin/env python3
"""
Composite WeldSuite brand chrome onto a Higgsfield (or other) base image.

Typical weekly-automation flow:
  1. Higgsfield MCP generate_image / generate_video → download to /tmp/base.png
  2. python3 scripts/social/brand_overlay.py --in /tmp/base.png --out …/post.png
  3. Host + register via create_social_media
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from PIL import Image, ImageDraw, ImageEnhance

from brand import (
    BLUE,
    BORDER,
    INK,
    LOGO_HORIZONTAL,
    LOGO_ON_DARK,
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


def fit_cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    tw, th = size
    src = img.convert("RGBA")
    scale = max(tw / src.width, th / src.height)
    nw, nh = int(src.width * scale), int(src.height * scale)
    resized = src.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return resized.crop((left, top, left + tw, top + th))


def overlay(
    base: Image.Image,
    *,
    size_name: str,
    label: str,
    headline: str,
    subhead: str,
    dark_chrome: bool,
    dim: float,
) -> Image.Image:
    w, h = SIZES[size_name]
    canvas = fit_cover(base, (w, h))

    if dim < 1.0:
        canvas = ImageEnhance.Brightness(canvas).enhance(dim)

    # Soft header wash so logo stays legible on busy AI imagery
    wash = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wash)
    for i in range(180):
        alpha = int(140 * (1 - i / 180))
        color = (0, 0, 0, alpha) if dark_chrome else (255, 255, 255, alpha)
        wd.line([(0, i), (w, i)], fill=color)
    canvas = Image.alpha_composite(canvas.convert("RGBA"), wash)

    draw = ImageDraw.Draw(canvas)
    logo = fetch_logo(LOGO_ON_DARK if dark_chrome else LOGO_HORIZONTAL)
    paste_logo(canvas, logo, max_h=48, pad=48)

    font_label = load_font(22)
    y = chip(draw, 48, 120, label, font_label)

    if headline:
        card_top = max(y + 24, int(h * 0.55))
        card = (48, card_top, w - 48, h - 64)
        fill = (20, 20, 20, 210) if dark_chrome else (*SURFACE[:3], 230)
        ink = WHITE if dark_chrome else INK
        muted = (180, 180, 180, 255) if dark_chrome else MUTED
        rounded_rect(draw, card, radius=28, fill=fill, outline=BORDER if not dark_chrome else BLUE, width=2)

        font_h = load_font(44, bold=True)
        font_s = load_font(26)
        pad = 36
        max_text_w = card[2] - card[0] - pad * 2
        ty = card[1] + pad
        for line in wrap_text(headline, font_h, max_text_w, draw):
            draw.text((card[0] + pad, ty), line, font=font_h, fill=ink)
            ty += int(font_h.size * 1.2)
        if subhead:
            ty += 12
            for line in wrap_text(subhead, font_s, max_text_w, draw):
                draw.text((card[0] + pad, ty), line, font=font_s, fill=muted)
                ty += int(font_s.size * 1.35)

    return canvas.convert("RGB")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--in", dest="inp", required=True, type=Path, help="Higgsfield (or other) base image")
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--size", choices=list(SIZES.keys()), default="instagram_feed")
    p.add_argument("--label", default="WeldSuite")
    p.add_argument("--headline", default="")
    p.add_argument("--subhead", default="")
    p.add_argument("--dark-chrome", action="store_true", help="White logo + dark card (busy photos)")
    p.add_argument("--dim", type=float, default=0.92, help="Brightness multiplier before chrome (0–1)")
    args = p.parse_args()

    if not args.inp.is_file():
        sys.stderr.write(f"Input not found: {args.inp}\n")
        raise SystemExit(1)

    base = Image.open(args.inp)
    out = overlay(
        base,
        size_name=args.size,
        label=args.label,
        headline=args.headline,
        subhead=args.subhead,
        dark_chrome=args.dark_chrome,
        dim=args.dim,
    )
    ensure_parent(args.out)
    out.save(args.out, "PNG", optimize=True)
    print(args.out)


if __name__ == "__main__":
    main()
