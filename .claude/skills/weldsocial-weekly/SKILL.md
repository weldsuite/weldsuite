---
name: weldsocial-weekly
description: >-
  Weekly WeldSuite social content routine for Cursor Automations / cloud agents.
  Plans next week's posts, generates brand visuals via scripts/social, hosts
  assets under docs public/images/social, and creates WeldSocial drafts via MCP
  (never publishes). Use when running the Monday social automation, drafting
  WeldSocial posts, or migrating Buffer → WeldSocial weekly content.
---

# WeldSocial weekly drafts

This skill is the agent-facing twin of `.cursor/automations/weldsocial-weekly-prompt.md`.
That file is what humans paste into https://cursor.com/automations — follow the
same rules here when this skill is invoked.

## Goal

Produce next week's social posts as **WeldSocial drafts** for human review.
Never publish or schedule delivery.

## Forbidden tools

- `publish_social_post`
- `schedule_social_post`
- `cancel_social_post` (unless cleaning up a mistake you just made)

## Required MCP tools

| Tool | Use |
|------|-----|
| `search_social_accounts` | Live channel IDs (`linkedin` / `twitter` / `instagram`) |
| `search_social_posts` | Idempotency — skip if `week-YYYY-Www` drafts exist |
| `create_social_media` | Register hosted image/video URLs → `mediaIds` |
| `create_social_post` | Draft only (`status: "draft"`) |
| `create_social_campaign` | Optional weekly campaign bucket |
| `search_social_campaigns` | Find/reuse this week's campaign |

## Cadence (Europe/Amsterdam)

- LinkedIn 4 (Tue–Thu 08:00–10:00)
- X 5 (weekdays 09:00 & 13:00)
- Instagram 3+ (Mon/Wed/Fri 11:00; ≥1 Reel)

Mix: 40% educational / 30% perspective / 20% proof / 10% personality.
CTA every ~4th post alternating register vs contact-sales, with UTMs.

## Brand + scripts

- Logos: `https://www.weldsuite.org/images/logos/weldsuite-{suite-icon,horizontal-full,logo-full}.png`
- Generators: `scripts/social/` (`generate_post_image.py`, `generate_reel.py`, `enrich_audio.py`)
- Host path: `apps/web/docs/public/images/social/<YYYY-Www>/`
- Public URL: `https://help.weldsuite.org/images/social/<YYYY-Www>/<file>`

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
  "internalNotes": "Intended: Tue 08:30 Europe/Amsterdam\nAssets: https://help.weldsuite.org/…"
}
```

## Done criteria

Markdown table: title | post id | platform | intended time | media | notes.
Confirm zero publish/schedule calls. Point humans at `/social/drafts`.
