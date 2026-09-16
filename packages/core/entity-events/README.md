# `@weldsuite/entity-events`

Shared entity-event catalog, wire types, and **hub-only** publisher for WeldSuite.

## Publish (producers)

Producers call `publishEntityEvent` / `publishEntityEventRaw`. After Phase 7 they
only enqueue one message on the `ENTITY_EVENTS` hub queue. Fan-out to audit,
analytics, search, webhooks, WeldConnect, WeldAgent, and realtime happens in
`entity-events-worker`.

```ts
import { publishEntityEvent } from '@weldsuite/entity-events';

publishEntityEvent({
  c,
  entityType: 'customer',
  action: 'created',
  entityId: customer.id,
  data: customer,
});
```

**Producer env:** bind `ENTITY_EVENTS` only for entity-event fan-out.
Keep unrelated bindings (`REALTIME` for chat, `EXECUTE_WORKFLOW` for manual
runs, etc.) on the worker — they are not part of `EntityEventPublisherEnv`.

## How to add a subscriber

Zero producer wrangler edits. Three steps:

1. **Registry** — add a row in `src/subscribers.ts`:

   ```ts
   { id: 'my-worker', topics: ['*'], queueBinding: 'SUB_MY_WORKER' }
   ```

   Topic patterns: `*` | `entityType:*` | `entityType:action`.

2. **Hub producer** — in `apps/workers/entity-events-worker/wrangler.toml`, add
   `[[queues.producers]]` with `binding = "SUB_MY_WORKER"` → your queue name
   (and test/prod siblings). Extend `EntityEventSubscriberQueueBinding` + hub
   `Env` if you introduce a new binding name.

3. **Consumer** — create the Cloudflare queue (+ DLQ), bind
   `[[queues.consumers]]` on the worker that should process events, and make
   the handler **idempotent on `message.id` / `evt_*`** (hub retries re-fan
   out to all matches).

Ops: queues are not auto-created — see the hub worker README and
`docs/hub-queues-setup.md` (Project Agent Store) for `wrangler queues create`.

## Package layout

| Path | Role |
|------|------|
| `src/publisher.ts` | Hub-only publish API |
| `src/subscribers.ts` | Static registry + `topicMatches` |
| `src/types.ts` | `EntityEventMessage` wire format |
| `src/events/` | Catalog (entity → actions) |
| `src/workflow-dispatch.ts` | WeldConnect matcher (subscriber path) |
| `src/webhook-delivery.ts` | Outbound webhook delivery (subscriber path) |
| `src/agent-dispatch.ts` | WeldAgent runner hook (subscriber path) |
