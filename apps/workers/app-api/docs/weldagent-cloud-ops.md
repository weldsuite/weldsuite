# WeldAgent cloud ops (Grok-parity)

## Local

1. Platform: `pnpm --filter platform dev` (port 3000)
2. app-api local: `cd apps/workers/app-api && pnpm exec wrangler dev --port 8789 --local`
3. agent-runtime (optional computer/browser): see `apps/workers/agent-runtime/README.md`
4. Set the same `INTERNAL_API_SECRET` on app-api + agent-runtime
5. Point `AGENT_RUNTIME_URL` at the runtime (local `http://localhost:8795`, already in wrangler.toml)

## Test / production

| Env | app-api | agent-runtime |
|---|---|---|
| test | `app-api-test.weldsuite.org` | `https://agent-runtime-test.weldsuite.org` |
| production | `app-api.weldsuite.org` | `https://agent-runtime.weldsuite.org` |

Secrets to keep aligned: `INTERNAL_API_SECRET`, `AI_GATEWAY_API_TOKEN` / CF AI Gateway, `AGENT_COMPUTER_ENABLED=true`.

## Features wired for Grok parity

- Skills (`/api/weldagent/skills`, tool `save_skill`)
- Teach sessions → draft skills
- Cron routines (hourly sweep + `/routines/:id/test`)
- Connector events (`POST /connectors/events` for Slack/GitHub match rules)
- Approvals for high-risk tools (+ Auto Review when `autoReviewEnabled`)
- Durable memories (injected into system prompt)
- Templates export/install + share token
- Live view + `/workspace` file listing in Configure

## Migrations

Schema lives in `packages/core/db/src/schema/weldagent-parity.ts` (+ `auto_review_enabled` on agents).
**Do not apply until a tenant migration is generated and approved.**

## Observability

Watch Workers logs for:

- `[app-api/weldagent] complete-turn background finish failed`
- `[WeldAgentRoutineSweep]`
- `[weldagent] failed to load skills/memory prompt blocks`
