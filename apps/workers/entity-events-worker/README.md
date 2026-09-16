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

# Phase 3 outbound webhooks (new)
wrangler queues create entity-webhooks-dev
wrangler queues create entity-webhooks-dlq-dev
wrangler queues create entity-webhooks-test
wrangler queues create entity-webhooks-dlq-test
wrangler queues create entity-webhooks
wrangler queues create entity-webhooks-dlq
```

Existing subscriber destinations (do not recreate): `audit-events*`, `analytics-events*`, `search-index*`.

## Ack policy

Ack only when every matching `Queue.send` succeeds. On failure, `message.retry()` → after `max_retries`, DLQ `entity-events-dlq*`. Hub retries re-fan out to all matches; consumers must be idempotent on `message.id` / `evt_*`.

## Phase 3 (webhooks)

Registry row `{ id: 'webhooks', queueBinding: 'SUB_WEBHOOKS' }` → `entity-webhooks*` → `integration-webhook-worker` queue consumer → `dispatchWebhookDeliveries`. Publisher no longer runs outbound webhooks inline.

**Deploy order:**

1. Create `entity-webhooks*` + DLQs (above).
2. Deploy `entity-events-worker` (with `SUB_WEBHOOKS` producer).
3. Deploy `integration-webhook-worker` (with `entity-webhooks*` consumer).

If the hub gains `SUB_WEBHOOKS` before the consumer is live, messages backlog on `entity-webhooks*` until the consumer deploys (safe). If queues are missing, hub fan-out fails and the hub message retries/DLQs.
