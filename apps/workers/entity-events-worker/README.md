# entity-events-worker

Hub orchestrator for WeldSuite entity events (Phase 1 of the multi-subscriber pub/sub plan).

**Role:** consume the `entity-events*` hub queue and enqueue copies to matching first-party subscriber queues. No business logic (no DB, HTTP, or Workflow.create).

## Queues

Create before deploy / local use:

```bash
wrangler queues create entity-events-dev
wrangler queues create entity-events-dlq-dev
wrangler queues create entity-events-test
wrangler queues create entity-events-dlq-test
wrangler queues create entity-events
wrangler queues create entity-events-dlq
```

Subscriber destinations (existing): `audit-events*`, `analytics-events*`, `search-index*`.

## Ack policy

Ack only when every matching `Queue.send` succeeds. On failure, `message.retry()` → after `max_retries`, DLQ `entity-events-dlq*`. Hub retries re-fan out to all matches; consumers must be idempotent on `message.id` (Phase 2).

## Phase 1 vs Phase 2

- Phase 1: registry + this worker + publisher dual-write **code path** (`ENTITY_EVENTS` on `EntityEventPublisherEnv`).
- Phase 2: producer wrangler bindings for `ENTITY_EVENTS`, subscriber idempotency, then cutover off legacy sinks.
