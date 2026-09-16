# entity-events-worker

Hub orchestrator for WeldSuite entity events (multi-subscriber pub/sub).

**Role:** consume the `entity-events*` hub queue and enqueue copies to matching first-party subscriber queues. No business logic (no DB, HTTP, or Workflow.create).

## Queues (create manually before deploy)

Cloudflare does **not** auto-create these. Run before deploying this worker or any producer with an `ENTITY_EVENTS` binding:

```bash
# Dev
wrangler queues create entity-events-dev
wrangler queues create entity-events-dlq-dev

# Test
wrangler queues create entity-events-test
wrangler queues create entity-events-dlq-test

# Production
wrangler queues create entity-events
wrangler queues create entity-events-dlq
```

Subscriber destinations (existing — do not recreate): `audit-events*`, `analytics-events*`, `search-index*`.

## Ack policy

Ack only when every matching `Queue.send` succeeds. On failure, `message.retry()` → after `max_retries`, DLQ `entity-events-dlq*`. Hub retries re-fan out to all matches; consumers must be idempotent on `message.id` / `evt_*`.

## Phase 2 cutover (audit / analytics / search)

Producers (`app-api`, `external-api`, `mcp-server`, `integration-webhook-worker`) bind **only** `ENTITY_EVENTS`. Legacy `AUDIT_EVENTS` / `ANALYTICS_EVENTS` / `SEARCH_EVENTS` producer bindings are removed. This worker’s `SUB_*` producers are the sole writers into those queues.

**Deploy order (required):**

1. Create hub queues + DLQs (above).
2. Deploy `entity-events-worker` (test, then production).
3. Deploy producer workers with `ENTITY_EVENTS` bindings.

If producers deploy before the hub consumer is live, hub messages backlog until the worker is up (safe). If hub queues are missing, producer `Queue.send` fails and audit/analytics/search go dark until queues exist.
