#!/usr/bin/env python3
"""Generate a silent vertical Reel (MP4) from an on-brand still + optional ken-burns."""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from generate_post_image import render


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--headline", required=True)
    p.add_argument("--subhead", default="")
    p.add_argument("--label", default="WeldSuite")
    p.add_argument("--seconds", type=float, default=12.0)
    p.add_argument("--dark", action="store_true")
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        still = Path(td) / "still.png"
        render(
            headline=args.headline,
            subhead=args.subhead,
            label=args.label,
            size_name="reel",
            dark=args.dark,
            out=still,
        )
        # Mild zoom for motion; silent audio omitted (enrich_audio muxes later).
        vf = (
            f"scale=1080:1920,zoompan=z='min(zoom+0.0008,1.08)':"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(args.seconds * 30)}:"
            f"s=1080x1920:fps=30"
        )
        cmd = [
            "ffmpeg",
            "-y",
            "-loop",
            "1",
            "-i",
            str(still),
            "-vf",
            vf,
            "-t",
            str(args.seconds),
            "-pix_fmt",
            "yuv420p",
            "-an",
            str(args.out),
        ]
        subprocess.run(cmd, check=True)
    print(args.out)


if __name__ == "__main__":
    main()
