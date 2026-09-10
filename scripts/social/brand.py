"""Shared WeldSuite social brand constants + Pillow helpers."""

from __future__ import annotations

import io
import urllib.request
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont

# Brand colors
WHITE = (255, 255, 255, 255)
INK = (10, 10, 10, 255)
INK_SOFT = (17, 24, 39, 255)
SURFACE = (245, 245, 245, 255)
BORDER = (229, 229, 229, 255)
MUTED = (115, 115, 115, 255)
BLUE = (54, 115, 237, 255)
BLUE_LIGHT = (84, 146, 255, 255)

LOGO_ICON = "https://www.weldsuite.org/images/logos/weldsuite-suite-icon.png"
LOGO_HORIZONTAL = "https://www.weldsuite.org/images/logos/weldsuite-horizontal-full.png"
LOGO_ON_DARK = "https://www.weldsuite.org/images/logos/weldsuite-logo-full.png"

SIZES = {
    "instagram_feed": (1080, 1350),
    "reel": (1080, 1920),
    "square": (1080, 1080),
    "linkedin_landscape": (1200, 627),
}


def _font_candidates() -> Iterable[str]:
    yield from (
        "/usr/share/fonts/truetype/inter/Inter-Regular.ttf",
        "/usr/share/fonts/truetype/inter/InterVariable.ttf",
        "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    )


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = list(_font_candidates())
    if bold:
        names = [
            n.replace("Regular", "Bold").replace("Variable", "Bold")
            for n in names
        ] + names
    for path in names:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def fetch_logo(url: str) -> Image.Image:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "WeldSuiteSocialBot/1.0 (+https://www.weldsuite.org)",
            "Accept": "image/png,image/*;q=0.8,*/*;q=0.5",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        return Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception:
        # Local fallbacks in the monorepo when CDN blocks the sandbox.
        candidates = [
            Path("/workspace/apps/web/platform/public/assets/images/weldsuite/logo-horizontal-light.png"),
            Path("/workspace/apps/web/platform/public/assets/images/weldsuite/logo-light.png"),
            Path(__file__).resolve().parents[2]
            / "apps/web/platform/public/assets/images/weldsuite/logo-horizontal-light.png",
        ]
        for path in candidates:
            if path.is_file():
                return Image.open(path).convert("RGBA")
        raise



def rounded_rect(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    radius: int,
    fill,
    outline=None,
    width: int = 1,
) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def paste_logo(canvas: Image.Image, logo: Image.Image, max_h: int, pad: int = 64) -> None:
    ratio = max_h / logo.height
    w = int(logo.width * ratio)
    h = int(logo.height * ratio)
    logo_r = logo.resize((w, h), Image.Resampling.LANCZOS)
    canvas.paste(logo_r, (pad, pad), logo_r)


def chip(draw: ImageDraw.ImageDraw, x: int, y: int, label: str, font) -> int:
    """Left-aligned dot + label chip. Returns next y."""
    r = 8
    draw.ellipse((x, y + 8, x + r * 2, y + 8 + r * 2), fill=BLUE)
    draw.text((x + r * 2 + 16, y), label, font=font, fill=MUTED)
    bbox = draw.textbbox((0, 0), label, font=font)
    return y + max(bbox[3] - bbox[1], r * 2) + 24


def wrap_text(text: str, font, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def downscale(img: Image.Image, size: tuple[int, int], scale: int = 2) -> Image.Image:
    big = img.resize((size[0] * scale, size[1] * scale), Image.Resampling.LANCZOS)
    # Caller already drew at target size on a supersampled canvas usually;
    # if img is already target size, just return it.
    if img.size == size:
        return img
    return img.resize(size, Image.Resampling.LANCZOS)


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
