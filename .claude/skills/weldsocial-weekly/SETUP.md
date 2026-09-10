# Cursor Automation: weekly WeldSocial drafts

Cursor Automations cannot be created via API/MCP — activate this in the UI.

## One-time setup

1. Open [cursor.com/automations/new](https://cursor.com/automations/new) (or `/automate` in a local agent chat).
2. **Trigger:** Scheduled → cron `0 8 * * 1` (Monday 08:00), timezone **Europe/Amsterdam**.
3. **Repository:** `weldsuite/weldsuite` @ `develop` (needed for `scripts/social` + asset hosting).
4. **Tools:** enable **WeldSuite MCP** + **Memories** (optional: Send to Slack for the digest). Prefer omitting publish/schedule tools if your allowlist is per-tool.
5. **Prompt:** paste the full prompt from [`.cursor/automations/weldsocial-weekly-prompt.md`](../../../.cursor/automations/weldsocial-weekly-prompt.md).
6. Authenticate WeldSuite MCP for the automation identity (Private = your OAuth; Team Owned = team service account).
7. Save → Activate → **Run now** once to verify drafts land in `/social/drafts`.

## What changed vs the Claude/Buffer routine

| Before (Buffer) | After (WeldSocial) |
|-----------------|--------------------|
| Buffer drafts + 10 scheduled-post cap | Unlimited WeldSocial drafts |
| Hardcoded Buffer channel IDs risk | `search_social_accounts` each run |
| Buffer ideas overflow | Not needed |
| `saveToDraft: true` | `create_social_post` with `status: "draft"` — never `publish` / `schedule` |
| Host on www.weldsuite.org/social/ | Host on `help.weldsuite.org/images/social/<week>/` via docs public path |
| Human reviews in Buffer | Human reviews at `/social/drafts`, then schedules in product |

## Supporting files in this PR

- `.cursor/automations/weldsocial-weekly-prompt.md` — paste-ready automation prompt
- `.agents/skills/weldsocial-weekly/SKILL.md` — agent skill
- `scripts/social/` — brand image / reel / optional ElevenLabs helpers
- MCP + external-api `social-media` routes — `create_social_media` to attach hosted URLs
