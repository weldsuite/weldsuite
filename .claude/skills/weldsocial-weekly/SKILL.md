---
name: weldsocial-weekly
description: >-
  Weekly WeldSuite social content routine for Cursor Automations / cloud agents.
  Plans next week's posts, generates base creatives with Higgsfield MCP, stamps
  brand chrome via scripts/social/brand_overlay.py, hosts assets, and submits
  WeldSocial posts for human approval with scheduledAt set so Approve
  auto-schedules delivery. Never publishes. Use for the Monday social
  automation or Buffer → WeldSocial migration.
---

# WeldSocial weekly approval queue

Twin of `.cursor/automations/weldsocial-weekly-prompt.md`.

## Goal

Submit next week's posts for **human approval** with an intended `scheduledAt`.
Approve in `/social/approvals` → delivery is auto-scheduled. Never publish/schedule yourself.

## Forbidden tools

- `publish_social_post`
- `schedule_social_post`
- `approve_social_approval` (humans approve in the UI)
- **Any Buffer tool / API / CLI**

## Required MCP tools

| Tool | Use |
|------|-----|
| Higgsfield generate tools | Base stills/Reels |
| `search_social_accounts` | Live channel IDs |
| `search_social_posts` / `search_social_approvals` | Idempotency |
| `create_social_media` | Register hosted URLs |
| `create_social_post` | `status: pending_approval` + `scheduledAt` + timezone |
| `create_social_approval` | Open the Approvals queue item |

## Flow

1. Higgsfield → `brand_overlay.py` → host → `create_social_media`
2. `create_social_post` (`pending_approval`, `scheduledAt`, accounts, media)
3. `create_social_approval` `{ postId }`
4. Stop. Human Approves → PostPeer schedule fires at `scheduledAt`.

## Buffer coexistence

Additive only. Never touch Buffer. Avoid colliding channel+time slots.

## Done criteria

Table: title | post id | approval id | platform | scheduledAt | media source.
Confirm zero publish/schedule/approve/Buffer calls. Point humans at `/social/approvals`.
