# WeldAgent cloud ops (Grok-parity)

## Local

1. Platform: `pnpm --filter platform dev` (port 3000)
2. API workers local: `pnpm dev:api` (app-api on 8789 forwards the WeldAgent paths to agent-api), or agent-api alone: `pnpm --filter agent-api dev` (port 8814)
3. agent-runtime (optional computer/browser): see `apps/workers/agent-runtime/README.md`
4. Set the same `INTERNAL_API_SECRET` on agent-api (and chat-api) + agent-runtime
5. Point `AGENT_RUNTIME_URL` at the runtime (local `http://localhost:8795`, already in wrangler.toml)

## Test / production

| Env | agent-api | agent-runtime |
|---|---|---|
| test | `agent-api-test.weldsuite.org` | `https://agent-runtime-test.weldsuite.org` |
| production | `agent-api.weldsuite.org` | `https://agent-runtime.weldsuite.org` |

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
