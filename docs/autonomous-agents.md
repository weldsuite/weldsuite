# Workspace AI Agents (WeldAgent)

Named, permission-scoped AI agents that act **inside the WeldSuite platform** — not
virtual desktops or computer-use bots.

## Product model

- Multiple agents per workspace (`weldagent_agents`)
- Each agent has **platform object:action grants** (`people:read`, `tickets:create`, …)
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

## Permissions

Human RBAC (new object, distinct from helpdesk `agents`):

- `weldagent:read|create|update|delete|use|manage`

Agent grants are stored on the agent row and enforced at tool registration time.
The chatting user being Owner does **not** widen what the agent can do.

## Runtime

- Executor: `apps/workers/app-api/src/services/weldagent/executor.ts` (`generateText` / `streamText` + `stopWhen: stepCountIs(n)`)
- Tools: `…/services/weldagent/tools.ts` (people, tickets, tasks, chat room tools)
- Event dispatch: `registerWeldAgentEventRunner` in `@weldsuite/entity-events` → `dispatchWeldAgentsForEvent`
- Room dispatch: `services/chat/agent-mention-dispatch.ts`
- Activation extracts `eventSubscriptions` from instructions (`subscriptions.ts`)

## Out of scope (v1)

- Computer-use / browsing / “own PC”
- Per-agent Stripe packages (use workspace credits)
- Full MCP tool parity
- Supervisor orchestration outside WeldChat (no separate agent bus)

## Schema

Tenant tables: `weldagent_agents`, `weldagent_agent_runs`; optional `weldagent_conversations.agent_id`.
Chat membership: `chat_channel_members.memberType = 'agent'` with `userId = weldagent_agents.id`.
Migration: `0186_weldagent_workspace_agents.sql`.
