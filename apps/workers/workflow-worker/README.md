# workflow-worker

Dedicated Cloudflare Worker that **executes WeldConnect workflows**.

This worker is the runtime home of the WeldConnect automation engine, the
consolidation target for the execution logic that used to live in
`apps/api-worker/src/workflows/execute-workflow/` (that legacy duplicate has
since been removed; `apps/api-worker` is obsolete). It hosts:

- The Cloudflare Workflow `ExecuteWorkflowWorkflow` (`src/index.ts`), the
  durable orchestrator that runs a workflow definition step by step via
  `step.do()` / `step.sleep()` / `step.waitForEvent()`.
- The runtime-agnostic step engine under `src/engine/` that the orchestrator
  delegates to.
- The workflow schedule sweep (`src/cron/schedule-sweep.ts`), a per-minute
  Cron Trigger that scans `workflow_schedules` across every workspace and
  dispatches due ones via this worker's own `EXECUTE_WORKFLOW` self-binding.

app-api, helpdesk-workflow-worker, and entity-events start a run via the
`EXECUTE_WORKFLOW` binding's `create({ params })` (cross-worker `script_name`
reference in test/preview/production; deliberately omitted in local dev, see
`wrangler.toml`).

## Status: implemented, test-driven

The engine was built test-first: every module under `src/engine/` has a
`*.test.ts` spec alongside it, and the implementation was written to make
that spec green. The suite currently has 100+ passing tests (`vitest run`).

```bash
pnpm --filter workflow-worker test          # run the full suite
pnpm --filter workflow-worker test:watch    # TDD loop
pnpm --filter workflow-worker type-check    # tsc --noEmit
```

## Architecture

```
src/
  index.ts                     # CF Workflow entrypoint (durable orchestrator wrapper) + scheduled handler
  db.ts                        # Database type + schema re-export, tenant DB resolution
  lib/id.ts                    # generateId('prefix')
  cron/
    schedule-sweep.ts          # per-minute schedule sweep (cron match, double-fire guard, dispatch)
  engine/
    types.ts                   # WorkflowStep, ActionContext, StepRuntime, TriggerType, ... (contracts)
    errors.ts                  # engine error types
    resolve-inputs.ts          # {{steps.*}} / {{trigger.*}} / {{variables.*}} / {{contact.*}}
    evaluate-condition.ts      # operator evaluation for step.condition
    execute-steps.ts           # runtime-agnostic step orchestrator (the core)
    integrations.ts            # resolveIntegration(): credentials/OAuth for an integration
    stats.ts                   # workflow execution/success/failure counters
    workflow-complete.ts       # workflow_complete chaining (pure matcher + dispatch)
    persistence.ts             # workflow_execution_steps rows + realtime events
    actions/
      index.ts                 # executeAction() + actionHandlers registry
      communication.ts         # send_email, send_notification, slack_message
      data.ts                  # create/update/delete/query_data, transform
      http.ts                  # http_request, webhook
      control.ts               # condition, loop, delay, set_variable, log
      sms.ts                   # send_sms (Telnyx)
      helpdesk.ts               # helpdesk conversation actions (assign, tag, reply, ...)
      interactive.ts           # send_choices / collect_input (waiting-for-input steps)
      ai.ts                     # AI-backed actions (owned separately, see CLAUDE.md)
      providers/                # per-integration adapters (Slack, Notion, GitHub, Airtable, ...)
```

### Why the orchestrator is split from Cloudflare Workflows

`executeWorkflowSteps()` is **runtime-agnostic**, it takes a `StepRuntime`
port (`do` / `sleep` / `waitForEvent`). In production `src/index.ts` adapts the
Cloudflare `WorkflowStep` to that port; in tests a synchronous fake runtime is
injected. This makes the entire step machine (chaining, conditions, retries,
loops, delays, waiting-for-input, error handling) unit-testable without the
Workflows runtime.

## Triggers supported

- `manual`, POST `/api/workflows/:id/test` or `/:id/trigger` (app-api)
- `entity_event`, matched via `@weldsuite/entity-events`' shared trigger
  matcher (app-api, integration-webhook-worker)
- `integration_event`, third-party sync events (Shopify, WooCommerce, etc.)
- `schedule`, this worker's own cron sweep (`src/cron/schedule-sweep.ts`)
- `webhook`, POST `/api/workflows/webhook/:webhookId` (app-api)
- `workflow_complete`, chained dispatch when an upstream workflow finishes
  (`src/engine/workflow-complete.ts`)

## Engine action coverage

Implemented with tests: input resolution, condition evaluation, transform,
step orchestration, `send_email`, `send_notification`, `http_request`,
`webhook`, `create/update/delete/query_data`, `set_variable`, `log`,
`condition`, `loop`, `delay`, `send_sms`, the helpdesk conversation actions,
the interactive (`send_choices` / `collect_input`) actions, a generic
**integration resolver**, `slack_message` + integration-authed HTTP, and
per-provider adapters (Notion, GitHub, Airtable, Asana, Google Sheets/Calendar,
Gmail, Teams, Twilio).

`src/engine/actions/ai.ts` (AI-backed actions) is owned by a separate
workstream, see the repo's `CLAUDE.md`, and is out of scope for changes made
under this README's remit.
