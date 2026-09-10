---
name: weldsocial-weekly
description: >-
  Weekly WeldSuite social content routine for Cursor Automations / cloud agents.
  Plans next week's posts, generates base creatives with Higgsfield MCP, stamps
  brand chrome via scripts/social/brand_overlay.py, hosts assets under docs
  public/images/social, and creates WeldSocial drafts via MCP (never publishes).
  Use when running the Monday social automation, drafting WeldSocial posts, or
  migrating Buffer → WeldSocial weekly content.
---

# WeldSocial weekly drafts

This skill is the agent-facing twin of `.cursor/automations/weldsocial-weekly-prompt.md`.
Follow the same rules when this skill is invoked.

## Goal

Produce next week's social posts as **WeldSocial drafts** for human review.
Never publish or schedule delivery.

## Forbidden tools

- `publish_social_post`
- `schedule_social_post`
- `cancel_social_post` (unless cleaning up a mistake you just made)
- **Any Buffer tool / API / CLI** — never touch the existing Buffer queue (no cancel, edit, reschedule, delete, or migrate)

## Buffer coexistence

WeldSocial drafts are additive while Buffer still has posts scheduled. Read Memories for what Buffer already covers next week. Only create the cadence *delta* (or non-colliding channel+time slots). Do not duplicate captions/assets already queued in Buffer.

## Required MCP tools

| Tool / server | Use |
|---------------|-----|
| Higgsfield (`generate_image` / `generate_video` / wait tools) | Base stills & Reel motion — discover live schema; do not invent names |
| `search_social_accounts` | Live channel IDs (`linkedin` / `twitter` / `instagram`) |
| `search_social_posts` | Idempotency — skip if `week-YYYY-Www` drafts exist |
| `create_social_media` | Register hosted image/video URLs → `mediaIds` |
| `create_social_post` | Draft only (`status: "draft"`) |
| `create_social_campaign` | Optional weekly campaign bucket |
| `search_social_campaigns` | Find/reuse this week's campaign |

## Visual pipeline

1. **Higgsfield** base image/video (no fake logos/wordmarks in the AI render).
2. **`brand_overlay.py`** — WeldSuite logo + chip (+ optional headline card).
3. Host under `apps/web/docs/public/images/social/<YYYY-Www>/`.
4. `create_social_media` → `create_social_post` draft.

Fallback if Higgsfield is unavailable: `generate_post_image.py` / `generate_reel.py`, and note `higgsfield_skipped` in the report.

```bash
pip install -r scripts/social/requirements.txt
python3 scripts/social/brand_overlay.py \
  --in /tmp/hf-base.png \
  --size instagram_feed \
  --label "Educational" \
  --headline "One suite. One login." \
  --out apps/web/docs/public/images/social/2026-W37/kill-sprawl.png
```

## Cadence (Europe/Amsterdam)

- LinkedIn 4 (Tue–Thu 08:00–10:00)
- X 5 (weekdays 09:00 & 13:00)
- Instagram 3+ (Mon/Wed/Fri 11:00; ≥1 Reel)

Mix: 40% educational / 30% perspective / 20% proof / 10% personality.
CTA every ~4th post alternating register vs contact-sales, with UTMs.

## Brand kit

- Logos: `https://www.weldsuite.org/images/logos/weldsuite-{suite-icon,horizontal-full,logo-full}.png`
- Host public URL: `https://help.weldsuite.org/images/social/<YYYY-Www>/<file>`

Commit **only** the social asset path before relying on public URLs. Verify HTTP 200.

## Draft payload essentials

```json
{
  "title": "2026-W37 LI Tue — kill sprawl tip",
  "content": "…",
  "postType": "post",
  "status": "draft",
  "targetAccountIds": ["sac_…"],
  "mediaIds": ["smed_…"],
  "timezone": "Europe/Amsterdam",
  "tags": ["week-2026-W37", "educational", "linkedin"],
  "internalNotes": "Intended: Tue 08:30 Europe/Amsterdam\nAssets: https://help.weldsuite.org/…\nSource: higgsfield+overlay"
}
```

## Done criteria

Markdown table: title | post id | platform | intended time | media source (higgsfield/fallback) | notes.
Confirm zero publish/schedule calls. Point humans at `/social/drafts`.
