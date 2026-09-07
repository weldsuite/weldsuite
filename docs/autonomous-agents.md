# Workspace AI Agents (WeldAgent)

Named, permission-scoped AI agents that act **inside the WeldSuite platform**,
with an optional **Cloudflare cloud computer** (Sandbox Linux + Browser Run).

## Product model

- Multiple agents per workspace (`weldagent_agents`)
- Each agent has **platform object:action grants** (`people:read`, `tickets:create`, `computer:use`, `browser:use`, …)
- Tools are registered only when the agent's grants cover the tool's `requiredPermissions`
- Chat (interactive) and autonomous runs (manual / entity-event) share one executor in `app-api`
- Metered via the workspace credits wallet (`@weldsuite/ai` + Cloudflare AI Gateway)
- Agents can join **WeldChat rooms** as members (`memberType: 'agent'`, id = `agt_*`)

## Surfaces

| Surface | Path |
|---|---|
| Agents gallery / builder | `/agents`, `/agents/:id` |
| Per-bot chat history | `/agents/:id` → Chat tab (`weldagent_conversations` + `agentId`) |
| Chat with agent picker | WeldAgent drawer (`Cmd/Ctrl+J`) |
| Multi-agent rooms | WeldChat channels with agent members + @mentions |
| API | `/api/weldagent/agents/*`, `/api/weldagent/conversations?agentId=`, `/api/ai/chat` (+ `agentId`), `/api/channels/*` |
| Cloud computer | `agent-runtime` worker + tools `computer_*` / `browser_*` |

## Per-bot chat history (Grok-style)

Each workspace agent has private conversation threads for the current user
(`weldagent_conversations.agent_id`). Listing supports `?agentId=`. Turns are
persisted via `POST …/complete-turn`. No migration — `agent_id` already exists.

## Multi-agent rooms (WeldChat)

Agents are first-class channel members. Humans invite them (create dialog or invite-agent),
@mention them as `<@agt_…>`, and they reply in-channel with `authorType: 'agent'`.

Room policy lives on `chat_channels.metadata` (no migration):

| Key | Values | Default |
|---|---|---|
| `agentReplyPolicy` | `mentions` \| `always` \| `none` | `mentions` |
| `agentMaxHops` | 1–5 | `2` |

Behaviour:

- **mentions** — only @mentioned agents reply
- **always** — every active agent member replies to human messages; agent→agent only via @mention
- **none** — agents stay in the roster but never auto-reply
- Hop limit stops agent↔agent ping-pong after `agentMaxHops` mention hops

Runtime: `postChatMessage` → `dispatchAgentMentions` → `runAgentOnce` → `postAgentChatMessage`.

Agent tools for rooms: `message_agent`, `create_agent_group_chat`.

## Cloud computer (Cloudflare-only)

One **Linux sandbox per workspace** (shared by that workspace’s bots) plus
**Browser Run** sessions keyed per agent.

| Piece | Where |
|---|---|
| Brain / tool loop | `app-api` `executor.ts` |
| Computer + browser API | `apps/workers/agent-runtime` |
| Client | `computer-client.ts` → `AGENT_RUNTIME_URL` + `INTERNAL_API_SECRET` |
| Grants | `computer:use`, `browser:use` (assign on the agent) |
| UI | Configure → Cloud computer panel |

Tools:

- `computer_exec`, `computer_read_file`, `computer_write_file`, `computer_list_files`, `computer_run_code`
- `browser_open`, `browser_act`, `browser_close`

Ops:

- Local: run Docker + `pnpm --filter agent-runtime dev` (port 8795)
- Env: `AGENT_RUNTIME_URL`, `AGENT_COMPUTER_ENABLED`, matching `INTERNAL_API_SECRET`
- Not a full GUI desktop — headless Chrome + Linux container (Grok-like capabilities without Hetzner)

## Permissions

Human RBAC (new object, distinct from helpdesk agents):

- `weldagent:read|create|update|delete|use|manage`

Agent grants are stored on the agent row and enforced at tool registration time.
The chatting user being Owner does **not** widen what the agent can do.

## Runtime

- Executor: `apps/workers/app-api/src/services/weldagent/executor.ts` (`generateText` / `streamText` + `stopWhen: stepCountIs(n)`)
- Tools: `…/services/weldagent/tools.ts` (people, tickets, tasks, chat, computer, browser)
- Computer: `apps/workers/agent-runtime` (Sandbox + Browser Run)
- Event dispatch: `registerWeldAgentEventRunner` in `@weldsuite/entity-events` → `dispatchWeldAgentsForEvent`
- Room dispatch: `services/chat/agent-mention-dispatch.ts`
- Activation extracts `eventSubscriptions` from instructions (`subscriptions.ts`)

## Out of scope (for now)

- Per-agent Stripe packages (use workspace credits)
- Full MCP tool parity
- Supervisor orchestration outside WeldChat (no separate agent bus)
- Persistent GUI desktop / Hetzner VMs
- Local machine control (laptop bridge)

## Schema

Tenant tables: `weldagent_agents`, `weldagent_agent_runs`; optional `weldagent_conversations.agent_id`.
Chat membership: `chat_channel_members.memberType = 'agent'` with `userId = weldagent_agents.id`.
Migration: `0186_weldagent_workspace_agents.sql`.
