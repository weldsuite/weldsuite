# Workspace AI Agents (WeldAgent)

Named, permission-scoped AI agents that act **inside the WeldSuite platform**.
They run on **Claude Managed Agents**; a granted agent also gets a sandbox and
web tools there.

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
| Per-bot chat history | `/agents/:id` (`weldagent_conversations` + `agentId`); settings sheet for config |
| Chat with agent picker | WeldAgent drawer (`Cmd/Ctrl+J`) |
| Multi-agent rooms | WeldChat channels with agent members + @mentions |
| API | `/api/weldagent/agents/*`, `/api/weldagent/conversations?agentId=`, `/api/ai/chat` (+ `agentId`), `/api/channels/*` |
| Sandbox + web | Managed Agents built-in tools; `browser_*` via the `agent-runtime` worker |

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

## Sandbox and web tools

Both are grants on the agent (Agent settings → Access):

| Grant | What the agent gets | Runs at |
|---|---|---|
| `computer:use` | bash, read, write, edit, glob, grep in a private sandbox | Anthropic (Managed Agents toolset) |
| `browser:use` | web search + fetch | Anthropic (Managed Agents toolset) |
| `browser:use` | `browser_open`, `browser_act`, `browser_close` for sites without an API | `apps/workers/agent-runtime` (Browser Run) |

- Built-in tool config: `builtinToolAccess` / `agentToolset` in `packages/domains/agent/src/managed-agents.ts`
- Browser Run client: `packages/domains/agent/src/computer-client.ts` (`AGENT_RUNTIME` binding, else `AGENT_RUNTIME_URL` + `INTERNAL_API_SECRET`; `AGENT_COMPUTER_ENABLED=false` turns it off)
- Local: `pnpm --filter agent-runtime dev` (port 8795) for the browser tools

## Permissions

Human RBAC (new object, distinct from helpdesk agents):

- `weldagent:read|create|update|delete|use|manage`

Agent grants are stored on the agent row and enforced at tool registration time.
The chatting user being Owner does **not** widen what the agent can do.

## Runtime

- Executor: `packages/domains/agent/src/executor.ts` (Managed Agents sessions; platform tools run as custom tools in agent-api)
- Tools: `packages/domains/agent/src/tools.ts` (ask_user, setup, skills, memory, routines, people, tickets, tasks, chat, browser)
- Browser Run: `apps/workers/agent-runtime`
- Event dispatch: `registerWeldAgentEventRunner` in `@weldsuite/entity-events` → `dispatchWeldAgentsForEvent`
- Room dispatch: `services/chat/agent-mention-dispatch.ts`
- Activation extracts `eventSubscriptions` from instructions (`subscriptions.ts`)

## Asking the user (`ask_user`)

Every agent has the `ask_user` custom tool: one question with 2-4 options it
writes itself. The platform renders it as a card (number keys pick an option,
"Something else" types a free answer) and the answer goes back as the next user
message. The setup interview asks all its questions this way.

- Schema + stream marker: `@weldsuite/app-api-client/schemas/weldagent-questions`
- Conversation turns: the question is the tool invocation's `args`
  (`app/agents/components/chat/thread.ts` pairs it with the answer)
- Streamed turns (WeldAgent drawer): the executor writes the question into the
  text stream between record separators; `splitQuestionMarkers` lifts it out

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
