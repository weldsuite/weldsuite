# `@weldsuite/entity-events`

Every create, update, and delete in WeldSuite publishes an **entity event**. That
one call is what keeps audit logging, analytics, semantic search, outbound
customer webhooks, workflow automations, and realtime UI updates in sync. A
mutation route that forgets to publish is invisible to all six.

> **Part 2 of this document (Adding a consumer) describes the target design and
> is not built yet.** It lands in phase 1 of
> [`.claude/entity-events-plan.md`](../../../.claude/entity-events-plan.md).
> Part 1 (Publishing) is accurate today.

---

## Part 1 — Publishing an event

### From a route handler

Publish **after** the write succeeds and **before** you return. The call is
fire-and-forget — it returns `void`, never throws, and does all its work inside
`c.executionCtx.waitUntil(...)`, so it cannot slow down or fail the response.

```ts
import { publishEntityEvent } from '@weldsuite/entity-events';

app.post('/', requirePermission('weldcrm:write'), zValidator('json', schema), async (c) => {
  const created = await createCustomer(c.get('tenantDb'), data);

  publishEntityEvent({
    c,
    entityType: 'customer',   // catalog-typed — a typo is a compile error
    action: 'created',        // catalog-typed for this entity type
    entityId: created.id,
    data: created as unknown as Record<string, unknown>,
  });

  return success(c, created, 201);
});
```

`workspaceId`, `userId`, and the tenant DB are read off the Hono context — you
never pass them.

### Updates: send `changes`

Use `computeChanges()` to diff the existing row against the incoming payload. It
returns `null` when nothing actually changed, which is your signal to skip
publishing entirely — a no-op PUT should not generate an audit entry or fire a
workflow.

```ts
import { publishEntityEvent, computeChanges } from '@weldsuite/entity-events';

const changes = computeChanges(existing, data);
if (changes) {
  publishEntityEvent({
    c,
    entityType: 'custom_field',
    action: 'updated',
    entityId: id,
    data: { id, ...data },
    changes,
  });
}
```

`changes` is what powers derived workflow triggers such as `status_changed` and
`assigned` ([`workflow-dispatch.ts`](src/workflow-dispatch.ts)), so omitting it on
an update silently disables those automations.

Real example: [`custom-fields/index.ts:226`](../../../apps/workers/app-api/src/routes/custom-fields/index.ts#L226).

### Deletes

Publish before or after the soft-delete write, with a minimal payload — consumers
that need the full record should have captured it from the earlier event.

```ts
publishEntityEvent({ c, entityType: 'custom_field', action: 'deleted', entityId: id, data: { id } });
```

### From code with no Hono context

Workflow steps, queue consumers, and webhook handlers use `publishEntityEventRaw`.
Same fan-out, but you pass `env` and `db` explicitly and it **awaits** every sink
rather than deferring to `waitUntil`.

```ts
import { publishEntityEventRaw } from '@weldsuite/entity-events';

await publishEntityEventRaw({
  env,
  db: tenantDb,
  workspaceId,
  userId: 'system',
  entityType: 'order',
  action: 'completed',
  entityId: order.id,
  data: order as unknown as Record<string, unknown>,
  // source defaults to 'system' here, vs 'api' for the context version
});
```

Both functions share one internal `fanOutEntityEvent()`, so the two paths cannot
drift.

### Restricting who sees the realtime event

`accessUserIds` limits the realtime broadcast to specific users. It affects only
the realtime sink — audit, analytics, and search still receive the event in full.

```ts
publishEntityEvent({ c, entityType: 'personal_task', action: 'created', entityId, data, accessUserIds: [assigneeId] });
```

### Entity types and actions

`entityType` and `action` are typed against the catalog in
[`src/events/`](src/events/) — one file per domain (`crm.ts`, `projects.ts`,
`helpdesk.ts`, …), aggregated into `ENTITY_EVENTS` by
[`src/events/index.ts`](src/events/index.ts). A typo fails `tsc`, not production.

To add a new entity type, add it to the right domain file with its allowed
actions. `catalog.test.ts` fails the build if two domains claim the same entity
type.

Payload shapes live in [`src/events/data.ts`](src/events/data.ts) and are
**hand-written on purpose** — they are a wire contract, decoupled from the Drizzle
schema so a column rename does not silently change what consumers receive. Types
without an entry fall back to `Record<string, unknown>`.

### Custom objects (WeldObjects)

User-defined objects use `co_<slug>` entity types that cannot exist in a static
catalog. `publishCustomObjectEvent` / `publishCustomObjectEventRaw`
([`src/custom-objects.ts`](src/custom-objects.ts)) are the one sanctioned place
where a runtime string is cast into the `EntityType` union. Only
`created` / `updated` / `deleted` are accepted.

### Coverage is enforced

[`_event-coverage.test.ts`](../../../apps/workers/app-api/src/routes/_event-coverage.test.ts)
statically parses every route under `app-api/src/routes` and fails the build if a
`POST /`, `PATCH|PUT /:id`, or `DELETE /:id` handler does not call
`publishEntityEvent`. If your route legitimately should not publish, add it to
`EXEMPT_ROUTES` with a one-line reason — do not delete the check.

This guard covers `app-api` only. `external-api` and `mcp-server` publish from
~80 files between them with no equivalent check; extending it is phase 4 of the
plan.

---

## Part 2 — Adding a consumer

Four consumers are registered today — `analytics`, `webhooks`,
`workflow-triggers` and `search-index`. Audit is the one sink still on its own
queue, pending a migration (phase 2 step 1 of
[the plan](../../../.claude/entity-events-plan.md)). Anything new belongs here,
not as another publisher sink.

### The shape

Every mutation publishes one message to the single `entity-events` queue.
`entity-events-worker` consumes it and fans out in-process to consumers from a
declarative registry.

```
publishEntityEvent()
  ├─ ENTITY_EVENTS.send(message)     ← one queue
  ├─ AUDIT_EVENTS.send(message)      ← last hold-out, needs a migration
  └─ REALTIME.fetch(...)             ← stays inline, latency-critical

entity-events → entity-events-worker
                  ├─ analytics
                  ├─ webhooks
                  ├─ workflow-triggers
                  └─ search-index  (forwarded to SEARCH_EVENTS)
```

### Writing one

Consumers live in the dispatcher worker, next to the registry, because they need
its bindings:

```ts
// apps/workers/entity-events-worker/src/consumers/search-index.ts
import { defineConsumer } from '@weldsuite/entity-events/consumers';
import type { Env } from '../env';

export const searchIndexConsumer = defineConsumer<Env>({
  name: 'search-index',
  subscribes: ['customer:*', 'contact:*', 'ticket:created', 'ticket:updated'],
  needsTenantDb: true,

  async handle(events, { db, workspaceId }) {
    // `events` is only the slice of the batch matching `subscribes`,
    // already grouped to this one workspace.
    const unique = new Map(events.map((e) => [`${e.entityType}:${e.entityId}`, e]));
    for (const event of unique.values()) {
      await reindex(db!, workspaceId, event.entityType, event.entityId);
    }
  },
});
```

Then one line in
[`src/consumers/index.ts`](../../../apps/workers/entity-events-worker/src/consumers/index.ts):

```ts
export const CONSUMERS: readonly EntityEventConsumer<Env>[] = [searchIndexConsumer];
```

That is the whole change. No queue to create, no wrangler edit, no new worker, no
producer change.

### Subscription filters

| Pattern | Matches |
|---|---|
| `'customer:created'` | exactly that event |
| `'customer:*'` | every action on customers |
| `'*:deleted'` | deletes on every entity type |
| `'co_*'` | any WeldObjects custom object, any action |
| `'*'` | everything (what `audit` will use) |

Dotted form (`customer.created`) works too; it is normalised to wire form on
registration.

Filters are validated against the catalog at registration, so `custmer:created`
throws at module load — i.e. fails the deploy — instead of quietly matching
nothing. `co_*` entity types are exempt from the catalog check, since workspace
admins define them at runtime.

### Rules

**Handlers must be idempotent on `event.id`.** The dispatcher retries a whole
message when any of its consumers fails, so consumers that already succeeded run
again. `event.id` (`evt_<16 hex>`) is stable across retries — key your dedupe on
it.

**Handlers receive a batch, not one event.** Coalesce where it helps; ten edits to
one record in one batch should cost one re-index, not ten.

**Never trust `data` for anything correctness-critical.** It is a snapshot from
publish time and may be stale by the time you process it. If you need the current
row, re-read it — that is what the search consumer does, so a dropped or
reordered message costs freshness, never correctness.

**Throw to retry, return to ack.** Do not swallow errors to "avoid noise" — that
is how a broken consumer looks healthy for a month.

### When to use a dedicated queue instead

Inline consumers share the dispatcher's isolate, CPU budget, and deploy. Set
`transport: 'queue'` for anything heavy, slow, or independently rate-limited —
the dispatcher then just forwards matching events to that queue and the real work
runs in its own worker.

```ts
defineConsumer({
  name: 'search-index',
  subscribes: ['customer:*'],
  transport: 'queue',
  queueBinding: 'SEARCH_EVENTS',
});
```

`queueBinding` must name a `Queue` binding on the dispatcher's env — that one
does need a `wrangler.toml` entry on `entity-events-worker`. If the binding is
missing the dispatcher throws rather than dropping the slice, so the events
retry and land in the dead-letter queue where the misconfiguration is visible.

Rule of thumb: inline if it is a DB write or a cheap HTTP call, dedicated queue if
it calls a model, does heavy CPU work, or needs its own concurrency ceiling.

### Failure semantics

A message is acked only once **every** consumer that matched it succeeded. If one
of three fails, the message retries and all three run again — hence the
idempotency rule above. After `max_retries` (3) it lands in `entity-events-dlq`.

| Situation | What the dispatcher does |
|---|---|
| Consumer returns | ack (for that consumer) |
| Consumer throws | retry every message it matched |
| No consumer matches the event | ack — nothing to do is not a failure |
| Message has no `workspaceId` / `eventType` | ack + log; a retry cannot add one |
| Tenant DB will not resolve | retry the workspace's whole slice → DLQ |
| `transport: 'queue'` binding missing | retry → DLQ, loudly |

Consumers are isolated from each other via `Promise.allSettled`, so one throwing
never stops the others in the same batch.

---

## Reference

| Export | Purpose |
|---|---|
| `publishEntityEvent` | Fire-and-forget publish from a Hono route |
| `publishEntityEventRaw` | Publish from a Workflow step, queue consumer, or webhook handler |
| `publishCustomObjectEvent(Raw)` | Publish for runtime-defined `co_<slug>` objects |
| `computeChanges` | Diff old row vs update payload; `null` when nothing changed |
| `ENTITY_EVENTS`, `EntityType`, `ActionFor` | The catalog and its derived types |
| `isKnownEntityType`, `isValidSubscription`, `parseEventName` | Runtime catalog validation for user-supplied strings |
| `EntityEventMessage` | The wire format (also at `@weldsuite/entity-events/types`) |
| `defineConsumer`, `validateRegistry` | Register a consumer; catalog-validated at module load |
| `dispatch` | The batch → consumers fan-out (also at `@weldsuite/entity-events/consumers`) |

Import from `@weldsuite/entity-events/types` in consumer workers that only need
the message shape — it is dependency-free and avoids pulling in Drizzle and
`@weldsuite/realtime`.

### Wire format

```ts
{
  id: 'evt_a1b2c3d4e5f6a7b8',
  eventType: 'customer:created',
  entityType: 'customer',
  entityId: 'cus_...',
  action: 'created',
  data: { /* entity payload at publish time */ },
  changes: { status: { old: 'lead', new: 'active' } },  // 'updated' only
  metadata: {
    workspaceId: 'ws_...',
    userId: 'user_...',
    timestamp: '2026-08-03T10:15:00.000Z',
    source: 'api',   // 'web' | 'mobile' | 'api' | 'system'
  },
}
```

### Current state vs the plan

Phases 0 and 1 are done, and four of phase 2's five sinks have moved. A mutation
now costs two queue sends and one service-binding fetch — no tenant-DB reads on
the write path at all, where outbound webhooks and workflow triggers each cost
one per event before.

Audit is the last sink still on its own queue. Moving it needs a unique
`event_id` on `audit_logs`, because the dispatcher re-runs every matched consumer
when any one of them fails and duplicate audit rows are not acceptable. See
[`.claude/entity-events-plan.md`](../../../.claude/entity-events-plan.md) for the
full gap analysis and the remaining phases.
