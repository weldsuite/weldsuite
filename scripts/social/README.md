# scripts/social

Brand-kit helpers for the weekly WeldSocial Cursor automation.

**Preferred path:** Higgsfield MCP base → `brand_overlay.py` → host → WeldSocial draft.  
**Fallback:** Pillow-only `generate_post_image.py` / `generate_reel.py` if Higgsfield is unavailable.

```bash
pip install -r scripts/social/requirements.txt

# After Higgsfield downloads a base still to /tmp/hf-base.png:
python3 scripts/social/brand_overlay.py \
  --in /tmp/hf-base.png \
  --size instagram_feed \
  --label "Educational" \
  --headline "One suite. One login." \
  --subhead "Kill tool sprawl without killing your stack." \
  --out apps/web/docs/public/images/social/2026-W37/kill-sprawl.png

# Pillow-only fallback still (1080×1350 Instagram feed by default)
python3 scripts/social/generate_post_image.py \
  --headline "One suite. One login." \
  --subhead "Kill tool sprawl without killing your stack." \
  --label "Educational" \
  --size instagram_feed \
  --out apps/web/docs/public/images/social/2026-W37/kill-sprawl-fallback.png

# Silent vertical Reel from brand still (mux audio later)
python3 scripts/social/generate_reel.py \
  --headline "Stop paying for five tools" \
  --subhead "WeldSuite consolidates the stack" \
  --out apps/web/docs/public/images/social/2026-W37/reel-silent.mp4

# Optional voiceover (exit 2 if ELEVENLABS_API_KEY missing)
python3 scripts/social/enrich_audio.py \
  --text "Stop paying for five tools that barely talk to each other." \
  --music "upbeat minimal corporate synth, confident" \
  --out /tmp/audio.mp4

ffmpeg -y -i apps/web/docs/public/images/social/2026-W37/reel-silent.mp4 \
  -i /tmp/audio.mp4 -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest \
  apps/web/docs/public/images/social/2026-W37/reel.mp4
```

After commit + docs deploy, assets are public at:

`https://help.weldsuite.org/images/social/<YYYY-Www>/<file>`

Register each URL with WeldSocial MCP `create_social_media`, then attach `mediaIds` on `create_social_post` drafts.

This automation must **not** touch Buffer — leave any already-scheduled Buffer posts alone.
