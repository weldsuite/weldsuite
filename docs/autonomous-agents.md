# Autonomous AI Agents

Autonomous AI agents run proactively in the background without user interaction. The user defines everything in natural language instructions, what the agent does, when it acts, and what the expected outcome is. The agent uses the tools assigned to it to carry out those instructions.

## How It Works

### Overview

```
User creates agent  -->  Writes instructions + assigns tools
                              |
                    User clicks "Activate"
                              |
                    AI analyzes instructions (Claude Haiku)
                              |
                    Extracts event subscriptions
                    e.g. ["contact.created"]
                              |
                    Agent is now listening
                              |
        ┌─────────────────────┼──────────────────────┐
        v                     v                      v
  Platform event fires   Manual "Run now"    (future: cron)
  e.g. contact.created        |
        |                     |
  POST /dispatch checks       |
  eventSubscriptions          |
        |                     |
        └─────────┬───────────┘
                  v
         Trigger.dev task queued
                  |
         AgentExecutor runs loop
         (Claude Opus 4.6 + tools)
                  |
         Result logged + notification sent
```

### Agent Lifecycle

1. **Draft**, Agent is created with a name. No execution happens.
2. **Active**, On activation, AI analyzes the instructions and extracts event subscriptions (e.g. `["contact.created"]`). The agent is now listening for those events.
3. **Paused**, Agent exists but does not execute.

### Self-Configuring Triggers

The user never selects trigger types or events manually. Instead:

1. User writes instructions in natural language: *"For each new customer, research their company size and alert the sales team if they have over 100 employees"*
2. When the agent is activated, the system sends the instructions to **Claude Haiku** with a lightweight prompt
3. Claude Haiku analyzes the instructions and extracts matching platform events: `["contact.created"]`
4. These are stored as `eventSubscriptions` on the agent
5. When platform events fire, the dispatch system checks all active agents and triggers those subscribed to the event

The extracted events are shown on the agent's detail page under "Listening for:" so the user can verify what the AI detected.

**Available events:** `contact.created`, `contact.updated`, `company.created`, `deal.created`, `deal.won`, `deal.lost`, `order.placed`, `order.shipped`, `order.delivered`, `ticket.created`, `ticket.escalated`, `ticket.resolved`, `email.received`, `invoice.created`, `invoice.paid`, `invoice.overdue`, `product.created`, `product.low_stock`, `task.created`, `task.completed`, `project.created`, and more.

If the instructions describe a periodic task (e.g. "every morning"), the AI returns `["scheduled"]`. If no clear trigger is detected, it returns `["manual"]`.

### Execution Flow

When an agent runs:

1. **Budget check**, The system verifies the workspace has remaining daily budget (monthly budget / days in month). If exceeded, the run is deferred.
2. **Tool assembly**, The agent's enabled tools are loaded.
3. **Sub-agent loading**, If the agent is a supervisor, sub-agent definitions are loaded for delegation.
4. **Agent loop**, The `AgentExecutor` (Trigger.dev task) runs an iterative loop:
   - Send the instructions + context to Claude Opus 4.6
   - LLM decides which tool(s) to call
   - Tools execute and return results
   - LLM processes results and decides next action
   - Loop continues until: text-only response (done), max iterations hit, or token budget exhausted
5. **Logging**, The run is recorded in `autonomous_agent_runs` with status, duration, iterations, tool calls, and result summary.
6. **Stats update**, The agent's `totalRuns`, `successfulRuns`, `failedRuns`, and `lastRunAt` are updated.
7. **Notification**, If the agent produced actionable output, a notification is sent via @weldsuite/realtime.

### Supervisor Agents

A supervisor agent orchestrates multiple specialized sub-agents using the Mastra supervisor pattern:

```
Supervisor Agent
├── Research Agent (tools: web_search, get_company)
├── CRM Agent (tools: update_contact, create_activity)
└── Notification Agent (tools: send_notification)
```

The supervisor:
- Receives context
- Decides which sub-agent to delegate to based on their descriptions
- Passes context to the sub-agent
- Receives results back
- May delegate to another sub-agent or produce a final result

Sub-agents have their own scoped tool sets, enforcing least-privilege access.

### Tool Assignment

Each agent only has access to the tools explicitly enabled for it. All available tools:

- **CRM**, search_contacts, get_contact, update_contact, create_contact, search_companies, get_company, create_activity, list_deals, update_deal
- **Commerce**, get_order, list_orders, get_product, update_product, search_products
- **Helpdesk**, search_tickets, get_ticket, create_ticket, assign_ticket, search_knowledge_base, send_message
- **Projects**, list_projects, create_task, update_task, list_tasks
- **Mail**, search_emails, get_email, create_draft, send_email
- **WMS**, check_inventory, get_product_stock
- **General**, web_search, send_notification, create_note

Integration tools (MCP servers, CRM sync) can also be attached with per-tool permission granularity.

## Pricing & Usage Spreading

### Plans

Agents are sold as fixed-price add-ons. Users never see credits or token counts.

| | AI Agents Light | AI Agents Pro |
|---|---|---|
| Agent slots | 5 | 20 |
| Monthly budget | Moderate | High |
| Supervisor agents | No | Yes |

### Usage Spreading

The system automatically distributes usage across the month so agents run consistently:

```
daily_budget = monthly_token_budget / days_in_current_month
```

- Each day, the agent can consume up to `daily_budget` tokens
- If the daily budget is exceeded, remaining runs are deferred to the next day
- Users see "Your agents are running at capacity, upgrade for more" when consistently hitting limits
- No credit counters, no token displays, just "X of Y agents" slot count

## Architecture

### Database Tables

**`autonomous_agents`** (tenant DB)
- Agent definition: name, description, icon, status
- AI config: system prompt (instructions), model (locked to Claude Opus 4.6), temperature, max tokens
- Tool config: enabled tools, integration IDs, integration tool permissions
- Supervisor config: is_supervisor flag, sub-agent IDs
- Guardrails: max iterations, max total tokens
- Stats: total/successful/failed runs, last run timestamp
- Trigger.dev integration: schedule ID

**`autonomous_agent_runs`** (tenant DB)
- Execution record: agent ID, status, trigger data
- Timing: started_at, completed_at, duration_ms
- Metrics: iterations, tokens used, tool call count
- Output: result summary + actions performed, or error

**`workspace_agent_subscriptions`** (master DB)
- Plan tier (light/pro), max agent slots
- Monthly token budget, current month usage
- Stripe subscription item ID
- Period start/end

### API Endpoints

All mounted at `/api/ai/autonomous-agents`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | List agents (filter by status) |
| `POST` | `/` | Create agent (name minimum) |
| `GET` | `/:id` | Get agent with recent runs |
| `PUT` | `/:id` | Update agent configuration |
| `DELETE` | `/:id` | Soft delete agent |
| `POST` | `/:id/activate` | Activate agent (analyzes instructions, extracts events) |
| `POST` | `/:id/pause` | Set status to paused |
| `POST` | `/:id/run` | Manual trigger |
| `GET` | `/:id/runs` | List runs (paginated) |
| `POST` | `/dispatch` | Dispatch a platform event to matching agents |

### Tech Stack

- **LLM**: Claude Opus 4.6 (fixed, not configurable)
- **Agent framework**: Mastra.ai (`@mastra/core`) for agent intelligence and supervisor pattern
- **Task orchestration**: Trigger.dev for scheduling and background execution
- **Agent executor**: `AgentExecutor` class, iterative tool-calling loop with token budgeting
- **Frontend**: React + TanStack Router, inline-editable detail page
- **Database**: Drizzle ORM + Neon PostgreSQL (per-tenant)

### Key Files

| File | Purpose |
|------|---------|
| `packages/core/db/src/schema/autonomous-agents.ts` | Agent table schema (includes `eventSubscriptions`) |
| `packages/core/db/src/schema/autonomous-agent-runs.ts` | Run history schema |
| `apps/api-worker/src/routes/ai/autonomous-agents.ts` | CRUD + activate + dispatch API routes |
| `apps/api-worker/src/services/ai/analyze-agent-instructions.ts` | AI-powered instruction analyzer (extracts event subscriptions) |
| `apps/web/platform/app/agents/page.tsx` | Agent list page |
| `apps/web/platform/app/agents/[id]/page.tsx` | Agent detail/config page (inline edit) |
| `apps/web/platform/app/agents/components/agent-card.tsx` | Agent card component |
| `apps/web/platform/hooks/queries/use-autonomous-agent-queries.ts` | React Query hooks |
| `apps/web/platform/trigger/agents/autonomous-agent-runner.ts` | Trigger.dev task, runs the agent end-to-end |
| `apps/web/platform/trigger/workflows/ai-agent/agent-executor.ts` | Core agent execution loop (reused) |

## Example: Lead Qualifier Agent

**Name**: Lead Qualifier

**Instructions**:
```
When a new contact is created in the CRM:

1. Look up the contact's company using the search_companies tool
2. If no company found, use web_search to research their email domain
3. Determine the company size (employees) from the research
4. If the company has more than 100 employees:
   - Update the contact with a "high-value" tag using update_contact
   - Send a notification to the sales team: "Large company detected, [company name] has ~[X] employees"
5. If the company has fewer than 100 employees:
   - Update the contact with a "standard" tag
```

**Tools enabled**: `get_contact`, `search_companies`, `web_search`, `update_contact`, `send_notification`

**What happens**: Every time a contact is created in WeldCRM, this agent automatically researches the company, determines its size, tags the contact, and alerts sales for large accounts, all without any human involvement.
