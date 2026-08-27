# Workspace AI Agents (WeldAgent)

Named, permission-scoped AI agents that act **inside the WeldSuite platform** — not
virtual desktops or computer-use bots.

## Product model

- Multiple agents per workspace (`weldagent_agents`)
- Each agent has **platform object:action grants** (`people:read`, `tickets:create`, …)
- Tools are registered only when the agent's grants cover the tool's `requiredPermissions`
- Chat (interactive) and autonomous runs (manual / entity-event) share one executor in `app-api`
- Metered via the workspace credits wallet (`@weldsuite/ai` + Cloudflare AI Gateway)

## Surfaces

| Surface | Path |
|---|---|
| Agents gallery / builder | `/agents`, `/agents/:id` |
| Chat with agent picker | WeldAgent drawer (`Cmd/Ctrl+J`) |
| API | `/api/weldagent/agents/*`, `/api/ai/chat` (+ `agentId`) |

## Permissions

Human RBAC (new object, distinct from helpdesk `agents`):

- `weldagent:read|create|update|delete|use|manage`

Agent grants are stored on the agent row and enforced at tool registration time.
The chatting user being Owner does **not** widen what the agent can do.

## Runtime

- Executor: `apps/workers/app-api/src/services/weldagent/executor.ts` (`generateText` / `streamText` + `stopWhen: stepCountIs(n)`)
- Tools: `…/services/weldagent/tools.ts` (people, tickets, tasks v1)
- Event dispatch: `registerWeldAgentEventRunner` in `@weldsuite/entity-events` → `dispatchWeldAgentsForEvent`
- Activation extracts `eventSubscriptions` from instructions (`subscriptions.ts`)

## Out of scope (v1)

- Supervisor / sub-agent orchestration
- Computer-use / browsing / “own PC”
- Per-agent Stripe packages (use workspace credits)
- Full MCP tool parity

## Schema

Tenant tables: `weldagent_agents`, `weldagent_agent_runs`; optional `weldagent_conversations.agent_id`.
Migration: `0186_weldagent_workspace_agents.sql`.
