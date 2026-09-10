# Cursor Automation: weekly WeldSocial drafts

Cursor Automations cannot be created via API/MCP — activate this in the UI.

## One-time setup

1. Open the Cursor Automations “new agent” page (or `/automate` in a local agent chat).
2. **Trigger:** Scheduled → cron `0 8 * * 1` (Monday 08:00), timezone **Europe/Amsterdam**.
3. **Repository:** `weldsuite/weldsuite` @ `develop` (needed for `scripts/social` + asset hosting).
4. **Tools:** enable **WeldSuite MCP**, **Higgsfield MCP**, and **Memories** (optional: Send to Slack for the digest). Prefer omitting publish/schedule tools if your allowlist is per-tool. **Do not enable Buffer** (or any Buffer connector) on this automation — existing Buffer schedules must stay untouched.
5. **Prompt:** paste the full prompt from [`.cursor/automations/weldsocial-weekly-prompt.md`](../../../.cursor/automations/weldsocial-weekly-prompt.md).
6. Authenticate both MCPs for the automation identity (Private = your OAuth; Team Owned = team service account). Higgsfield uses OAuth to your Higgsfield account (credits apply on MCP generations).
7. In WeldSocial settings, enable **Require approval for posts** (`defaultApprovalRequired`) so the composer’s schedule path uses Submit for Approval.
8. Optional: note Buffer’s existing next-week coverage in Memories so the agent only drafts the **extra** WeldSocial slots.
9. Save → Activate → **Run now** once. Confirm items land in `/social/approvals` (not live). Click Approve on one test post and confirm it moves to `/social/queue` scheduled — Buffer unchanged.

## Visual pipeline

Higgsfield base → `scripts/social/brand_overlay.py` → host on help.weldsuite.org → `create_social_media` → WeldSocial draft.

If Higgsfield is unauthenticated or out of credits, the agent falls back to Pillow-only generators and flags it.

## What changed vs the Claude/Buffer routine

| Before (Buffer) | After (WeldSocial) |
|-----------------|--------------------|
| Buffer drafts + 10 scheduled-post cap | Unlimited WeldSocial drafts |
| Hardcoded Buffer channel IDs risk | `search_social_accounts` each run |
| Buffer ideas overflow | Not needed |
| `saveToDraft: true` | `create_social_post` with `status: "draft"` — never `publish` / `schedule` |
| Host on www.weldsuite.org/social/ | Host on `help.weldsuite.org/images/social/<week>/` via docs public path |
| Human reviews in Buffer | Human reviews at `/social/drafts`, then schedules in product |
| Buffer queue owned the week | Buffer queue stays untouched; WeldSocial only adds non-colliding / delta drafts |

## Supporting files in this PR

- `.cursor/automations/weldsocial-weekly-prompt.md` — paste-ready automation prompt
- `.agents/skills/weldsocial-weekly/SKILL.md` — agent skill
- `scripts/social/` — Higgsfield brand overlay + Pillow fallbacks + optional ElevenLabs
- MCP + external-api `social-media` routes — `create_social_media` to attach hosted URLs
