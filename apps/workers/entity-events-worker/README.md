# entity-events-worker

Hub orchestrator for WeldSuite entity events (multi-subscriber pub/sub).

**Role:** consume the `entity-events*` hub queue and enqueue copies to matching first-party subscriber queues. No business logic (no DB, HTTP, or Workflow.create).

## Queues (create manually before deploy)

Cloudflare does **not** auto-create these. Run before deploying this worker or any producer with an `ENTITY_EVENTS` binding:

```bash
# Hub (Phase 1+)
wrangler queues create entity-events-dev
wrangler queues create entity-events-dlq-dev
wrangler queues create entity-events-test
wrangler queues create entity-events-dlq-test
wrangler queues create entity-events
wrangler queues create entity-events-dlq

# Phase 3 outbound webhooks
wrangler queues create entity-webhooks-dev
wrangler queues create entity-webhooks-dlq-dev
wrangler queues create entity-webhooks-test
wrangler queues create entity-webhooks-dlq-test
wrangler queues create entity-webhooks
wrangler queues create entity-webhooks-dlq

# Phase 4 WeldConnect entity_event triggers
wrangler queues create entity-workflows-dev
wrangler queues create entity-workflows-dlq-dev
wrangler queues create entity-workflows-test
wrangler queues create entity-workflows-dlq-test
wrangler queues create entity-workflows
wrangler queues create entity-workflows-dlq

# Phase 5 WeldAgent eventSubscriptions
wrangler queues create entity-agents-dev
wrangler queues create entity-agents-dlq-dev
wrangler queues create entity-agents-test
wrangler queues create entity-agents-dlq-test
wrangler queues create entity-agents
wrangler queues create entity-agents-dlq
```

Existing subscriber destinations (do not recreate): `audit-events*`, `analytics-events*`, `search-index*`.

## Ack policy

Ack only when every matching `Queue.send` succeeds. On failure, `message.retry()` → after `max_retries`, DLQ `entity-events-dlq*`. Hub retries re-fan out to all matches; consumers must be idempotent on `message.id` / `evt_*`.

## Phase 4 (WeldConnect)

Registry row `{ id: 'weldconnect', queueBinding: 'SUB_WELDCONNECT' }` → `entity-workflows*` → `workflow-worker` queue consumer → `matchAndDispatchWorkflowTriggers` (with CF Workflow instance-id idempotency on `evt_*` + workflowId). Publisher no longer runs entity_event matching inline.

**Deploy order:**

1. Create `entity-workflows*` + DLQs (above).
2. Deploy `entity-events-worker` (with `SUB_WELDCONNECT` producer).
3. Deploy `workflow-worker` (with `entity-workflows*` consumer).

If the hub gains `SUB_WELDCONNECT` before the consumer is live, messages backlog on `entity-workflows*` until the consumer deploys (safe).

## Phase 5 (WeldAgent)

Registry row `{ id: 'weldagent', queueBinding: 'SUB_WELDAGENT' }` → `entity-agents*` → `app-api` queue consumer → `runRegisteredWeldAgentDispatch` / `dispatchWeldAgentsForEvent` (idempotent on `evt_*` + agent id via `trigger_data->>'eventId'`). Publisher no longer runs agent dispatch inline.

**Deploy order:**

1. Create `entity-agents*` + DLQs (above).
2. Deploy `entity-events-worker` (with `SUB_WELDAGENT` producer).
3. Deploy `app-api` (with `entity-agents*` consumer).

If the hub gains `SUB_WELDAGENT` before the consumer is live, messages backlog on `entity-agents*` until the consumer deploys (safe).
