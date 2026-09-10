#!/usr/bin/env python3
"""
Optional ElevenLabs voice (+ simple tone bed) for Reels.

If ELEVENLABS_API_KEY is missing, exits 2 so the automation can skip audio
without failing the whole batch. Music generation is best-effort: when the
ElevenLabs music/SFX path is unavailable, voice-only AAC/MP4 is written.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


def synthesize_elevenlabs(text: str, out_mp3: Path, voice_id: str) -> None:
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise SystemExit(2)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    body = (
        '{"text":'
        + _json_str(text)
        + ',"model_id":"eleven_multilingual_v2",'
        + '"voice_settings":{"stability":0.45,"similarity_boost":0.75}}'
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out_mp3.write_bytes(resp.read())
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"ElevenLabs TTS failed: {e.code} {e.read()[:400]!r}\n")
        raise SystemExit(1) from e


def _json_str(s: str) -> str:
    import json

    return json.dumps(s)


def mux_voice_only(mp3: Path, out_mp4: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(mp3),
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            str(out_mp4),
        ],
        check=True,
    )


def maybe_mix_music(voice_mp3: Path, music_prompt: str | None, out_mp4: Path) -> None:
    """Music is optional. Without a dedicated music API helper, emit voice-only."""
    if music_prompt:
        sys.stderr.write(
            f"[enrich_audio] music prompt noted ({music_prompt!r}) but no music "
            "generator is configured — writing voice-only track.\n"
        )
    mux_voice_only(voice_mp3, out_mp4)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--text", required=True)
    p.add_argument("--music", default=None)
    p.add_argument("--voice-id", default=os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"))
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()

    if not os.environ.get("ELEVENLABS_API_KEY"):
        sys.stderr.write("ELEVENLABS_API_KEY missing — skip audio enrichment.\n")
        raise SystemExit(2)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        mp3 = Path(td) / "voice.mp3"
        synthesize_elevenlabs(args.text, mp3, args.voice_id)
        maybe_mix_music(mp3, args.music, args.out)
    print(args.out)


if __name__ == "__main__":
    main()
