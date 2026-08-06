# Entity events — consolidation plan

Status: phases 0 and 1 shipped; phase 2 (migrating the sinks) is next.
Owner: Gert. Written 2026-08-06.

Goal: one mutation → one queue message → many consumers, where adding a consumer
is a single file plus a single registry line, with no wrangler edits and no new
queue.

---

## 1. Where we were (pre-phase-0 baseline)

> Kept as written, as the record of what phases 0 and 1 were fixing. For the
> current state see the phase markers in section 3 and
> [`packages/core/entity-events/README.md`](../packages/core/entity-events/README.md).

`publishEntityEvent()` ([publisher.ts:119](../packages/core/entity-events/src/publisher.ts#L119))
is one hardcoded `fanOutEntityEvent()` that pushes the same message into seven
sinks, each guarded by its own `if (env.X)` block:

| # | Sink | Transport | Consumer today |
|---|---|---|---|
| 1 | `AUDIT_EVENTS` | queue `audit-events` | audit-log-worker |
| 2 | `WORKFLOW_EVENTS` | queue `workflow-events` | **none** |
| 3 | `ANALYTICS_EVENTS` | queue `analytics-events` | analytics-worker |
| 4 | `SEARCH_EVENTS` | queue `search-index` | app-api's own `queue()` |
| 5 | `REALTIME` | service binding fetch | realtime-worker DOs |
| 6 | outbound webhooks | **inline tenant-DB read + HTTP** | — |
| 7 | workflow triggers | **inline tenant-DB read** + `EXECUTE_WORKFLOW.create()` | workflow-worker |

Producers: `app-api`, `external-api`, `integration-webhook-worker`, `mcp-server`
(sinks 1–3), `app-api` alone (sink 4), plus `helpdesk-widget-api` on its own
separate `entity-events` queue.

### Problems

1. **`workflow-events` is a black hole.** Four workers declare producers for it
   across eight wrangler blocks; no `[[queues.consumers]]` exists anywhere. Every
   message sent since it was added has been written and never read. Workflow
   triggers actually fire through sink 7, which is inline and synchronous.
   `helpdesk-widget-api`'s `entity-events` queue is a second black hole.
2. **Two sinks query the tenant DB on every mutation.** Sinks 6 and 7 each open a
   tenant-DB read inside `waitUntil` per event — `external_webhooks` and
   `workflows` respectively. That is per-write DB load and failure surface with
   no retry and no dead-letter path.
3. **Adding a consumer touches ~7 files.** Publisher env interface, a new
   hardcoded `if` block in the fan-out, `[[queues.producers]]` in four producer
   wranglers × dev and prod, then a brand-new worker with a hand-rolled `queue()`
   handler. The drift this invites is already visible: `mcp-server` has its
   producer bindings only under `[env.production]`, so all three sinks are
   silently `undefined` in local dev.
4. **No shared consumer runtime.** The three real consumers each hand-roll a
   batch loop with different ack/retry semantics. `audit-log-worker` and
   `analytics-worker` set neither `max_retries` nor `dead_letter_queue`, so a
   poison message is deleted by Cloudflare with nothing but a `console.error`.
   Only `search-index` has a DLQ.
5. **No runtime validation.** `EntityEventMessage` is a compile-time interface
   only; no consumer checks the shape of `message.body`.
6. **`helpdesk-widget-api` reimplements the publisher**
   ([lib/entity-events.ts](../apps/workers/helpdesk-widget-api/src/lib/entity-events.ts))
   with a narrower `EntityAction` union and only two sinks. Widget-originated
   mutations never reach audit, search, outbound webhooks, or workflow triggers.
7. **Docs contradict the code.** `publisher.ts`'s own docblock says
   `WORKFLOW_EVENTS` feeds helpdesk-workflow-worker (it does not); CLAUDE.md
   lists "AI agents" as a sink (no such sink exists); `events/helpdesk.ts` and
   `events/crm.ts` cite an `agent-dispatch` module that is not in the repo;
   `docs/autonomous-agents.md` documents a system built on the deleted
   `apps/api-worker`.

---

## 2. Target architecture

```
route handler
  └─ publishEntityEvent({ c, entityType, action, entityId, data })
       ├─ ENTITY_EVENTS.send(message)     ← ONE queue, one call
       └─ REALTIME.fetch(...)             ← stays inline, see note below

entity-events  (max_batch_size 25, max_batch_timeout 1s, DLQ entity-events-dlq)
  └─ entity-events-worker  — the dispatcher
       ├─ group batch by workspaceId, resolve each tenant DB once
       └─ for each registered consumer whose filter matches:
             audit      → write audit_logs
             analytics  → write analytics rows
             webhooks   → dispatchWebhookDeliveries
             workflows  → matchAndDispatchWorkflowTriggers → EXECUTE_WORKFLOW
             search     → forward to SEARCH_EVENTS  (transport: 'queue')
```

**Realtime stays inline in the publisher.** It is the one sink whose latency is
directly visible in the UI, and a 1s batch timeout would make the app feel laggy.
It is a service-binding fetch, not a queue, so it costs nothing on the write
path. This is a deliberate exception, not an oversight.

**Everything else moves behind the queue**, including the two sinks that are
inline today. With `max_batch_timeout = 1` the added latency is ~1s. The 7–9s
figure in
[helpdesk-widget-api/src/lib/entity-events.ts:110](../apps/workers/helpdesk-widget-api/src/lib/entity-events.ts#L110)
reflects a default 30s batch timeout, not an inherent property of Queues.

### The registry

```ts
// packages/core/entity-events/src/consumers/types.ts
export interface EntityEventConsumer {
  /** Stable id — appears in logs, metrics, and DLQ records. Never rename. */
  name: string;
  /** Catalog-validated at registration: ['customer:*', 'ticket:created'] or '*'. */
  subscribes: readonly string[] | '*';
  /** 'inline' runs in the dispatcher isolate. 'queue' forwards to a dedicated queue. */
  transport?: 'inline' | 'queue';
  /** Required when transport === 'queue'. */
  queueBinding?: string;
  /** When true the dispatcher resolves and caches the tenant DB per workspace. */
  needsTenantDb?: boolean;
  handle(events: EntityEventMessage[], ctx: ConsumerContext): Promise<void>;
}

export interface ConsumerContext {
  env: DispatcherEnv;
  workspaceId: string;
  /** Present only when needsTenantDb is set. */
  db?: TenantDb;
}
```

Handlers take a **batch slice**, not a single event, so consumers can coalesce.
The dispatcher hands each consumer only the events in the batch that matched its
filter, already grouped by workspace. `search-index` already does exactly this
coalescing by hand
([search-index-consumer.ts:40](../apps/workers/app-api/src/queue/search-index-consumer.ts#L40));
the registry makes that the default shape rather than a bespoke one.

Filters reuse the existing catalog — `isValidSubscription` and `parseEventName`
already exist at
[events/index.ts:143](../packages/core/entity-events/src/events/index.ts#L143)
and are currently only used by the workflow-trigger editor. Registration
validates every subscription against them at module load, so a typo'd
`custmer:created` fails fast instead of silently matching nothing.

### Failure semantics

Consumers **must be idempotent on `event.id`**. That id already exists
(`evt_<16 hex>`, [publisher.ts:56](../packages/core/entity-events/src/publisher.ts#L56)),
it just isn't persisted anywhere today.

The dispatcher runs every matched consumer in isolation via `Promise.allSettled`.
A message is acked only when all its matched consumers succeeded; if any threw,
the message is retried and the already-successful consumers run again — hence the
idempotency requirement. After `max_retries` the message lands in
`entity-events-dlq`, which phase 4 turns into an inspectable table rather than a
hole.

This is deliberately the simple option. Per-consumer retry queues would avoid the
re-run, at the cost of N extra queues and a lot of bookkeeping — not worth it
until a consumer proves it cannot be made idempotent.

---

## 3. Migration phases

Each phase is independently shippable and independently revertable.

### Phase 0 — quick wins (no new architecture) — ✅ DONE 2026-08-06

- ✅ Added `max_retries = 3` + `dead_letter_queue` to `audit-log-worker` and
  `analytics-worker` consumer blocks, dev and prod.
- ✅ Deleted the `WORKFLOW_EVENTS` producer bindings from `app-api`,
  `external-api`, `integration-webhook-worker`, `mcp-server` (7 blocks), the
  sink from `fanOutEntityEvent`, and the binding from all four workers' `Env`
  types. Nothing read it.
- ✅ Deleted the orphan `ENTITY_EVENTS` producer from `helpdesk-widget-api`,
  freeing the `entity-events` queue name for phase 1. This also fixed a live
  bug: the widget publisher early-returned when that unbound queue was missing,
  so analytics and realtime were being skipped too.
- ✅ Removed the unbacked `ENTITY_EVENTS` binding from
  `helpdesk-workflow-worker`'s `Env` type — its wrangler.toml never had a queue
  block.
- ✅ Added the missing top-level (dev) `[[queues.producers]]` block to
  `mcp-server`.
- ✅ Fixed the `publisher.ts` docblock and the CLAUDE.md sink list.

**Before deploying, create the four new DLQs:**

```bash
wrangler queues create audit-events-dlq
wrangler queues create audit-events-dlq-dev
wrangler queues create analytics-events-dlq
wrangler queues create analytics-events-dlq-dev
```

The old `workflow-events` / `workflow-events-dev` / `entity-events` /
`entity-events-dev` queues can be deleted once any backlog in them is confirmed
worthless — nothing has ever read them.

### Phase 1 — build the dispatcher, zero behaviour change — ✅ DONE 2026-08-06

- ✅ New `packages/core/entity-events/src/consumers/`: `types.ts`, `registry.ts`
  (registration + catalog validation), `match.ts` (filter matching),
  `dispatch.ts` (batch grouping, tenant-DB caching, per-consumer isolation).
  Exported as `@weldsuite/entity-events/consumers`. 26 tests.
- ✅ New `apps/workers/entity-events-worker/` — a thin worker whose `queue()` is
  `dispatch(batch, …)` and nothing else, plus the registry in `src/consumers/`.
- ✅ Consumer block: `max_batch_size = 25`, `max_batch_timeout = 1`,
  `max_retries = 3`, `dead_letter_queue = entity-events-dlq`.
- ✅ Added the `ENTITY_EVENTS` producer binding to all four producer workers,
  dev and prod, and to their `Env` types.
- ✅ Publisher sends to `ENTITY_EVENTS` **in addition to** every existing sink,
  with the registry **empty**. Pure shadow traffic.

Two deviations from the design above, both deliberate:

- **Consumers live in the worker, not the package.** `defineConsumer` /
  `dispatch` are the package; the consumers themselves and the `CONSUMERS` array
  sit in `apps/workers/entity-events-worker/src/consumers/`, because a consumer
  needs the dispatcher's bindings. The package stays free of worker specifics —
  `dispatch()` takes `resolveTenantDb` as a callback rather than importing Neon
  and KV, which is also what makes it testable without a database.
- **`EntityEventConsumer` is a discriminated union**, not one interface with
  everything optional. `transport: 'queue'` requires `queueBinding` and has no
  `handle`; inline consumers require `handle`. Misuse fails to compile instead of
  at 3am.

**Before deploying, create the queues:**

```bash
wrangler queues create entity-events
wrangler queues create entity-events-dlq
wrangler queues create entity-events-dev
wrangler queues create entity-events-dlq-dev
```

**Then watch, before phase 2.** The dispatcher logs
`no consumers registered — acking N message(s)` per batch. Compare that volume
against audit-log-worker's, confirm the workspace spread looks sane, and check
`entity-events-dlq` is empty. Nothing depends on this queue yet, so it is free
to be wrong here.

### Phase 2 — migrate sinks — ✅ DONE 2026-08-06

1. ✅ **audit** — consumer inserts the whole slice in one statement, resolves
   actor names once per batch instead of once per event, and lets failures
   propagate so the batch retries (the old writer swallowed them and acked, so
   a failed insert silently lost the row). Idempotent via a new unique
   `audit_logs.event_id`; migration `0178_great_gamma_corps.sql`.
   `audit-log-worker` retired.
2. ✅ **analytics** — consumer writes the whole matched slice to the pipeline in
   one `send()` instead of one call per message. `analytics-worker` retired.
3. ✅ **webhooks** — `dispatchWebhookDeliveries` moved off the write path. First
   hot-path tenant-DB read eliminated.
4. ✅ **workflow triggers** — `matchAndDispatchWorkflowTriggers` moved off the
   write path. Second hot-path read eliminated.
5. ✅ **search** — registered as `transport: 'queue'`, forwarding to the existing
   `SEARCH_EVENTS` queue. app-api keeps the embedder, its concurrency ceiling
   and its DLQ; it just no longer produces to its own queue.

**The publisher is down to two sinks: `ENTITY_EVENTS` and `REALTIME`** — the
target architecture in section 2. Adding a consumer from here is one file plus
one registry line: no publisher change, no wrangler change, no new queue, no new
worker.

Also folded in along the way:

- `helpdesk-widget-api` now produces to `ENTITY_EVENTS` instead of the
  analytics queue, so widget events reach the registry like everything else.
  It still has its own publisher — that is phase 3 — so widget mutations still
  miss audit.
- `matchAndDispatchWorkflowTriggers` gained an optional `eventId`. When set,
  each dispatched run gets a deterministic Workflow instance id, so a replayed
  batch cannot start the same automation twice; Cloudflare rejects the
  duplicate id and that rejection is treated as success. It also now collects
  per-workflow failures and throws once at the end rather than swallowing them,
  so a queue caller retries instead of silently losing a trigger.
- `EventSource` gained `'widget'`, which widget events have always carried on
  the wire.

**Deploy order matters.** The tenant migration
(`0178_great_gamma_corps.sql`, adds `audit_logs.event_id`) must be applied
**before** entity-events-worker deploys — the audit consumer writes that column,
so a worker running against un-migrated tenants fails every batch into the DLQ.
The repo's own pipeline already does Migrations → Workers Deploy in that order;
just don't hand-deploy the worker ahead of it.

Note the index build is `CREATE UNIQUE INDEX`, not `CONCURRENTLY` — Drizzle runs
each migration in a transaction, which forbids the concurrent form. It takes a
write lock on `audit_logs` for the length of one seq scan per tenant. Audit
writes are queued, so the lock costs retries rather than user-facing errors, but
on a very large tenant it is worth running at a quiet hour.

**Watch after deploying:** workflow-trigger latency. Triggers used to fire in
the mutation's own invocation and now wait for the batch window, so roughly a
second end to end. If some automation needs better, move that one consumer back
inline — the rest of the design does not depend on it.

### Phase 3 — fold in helpdesk-widget-api

Delete `apps/workers/helpdesk-widget-api/src/lib/entity-events.ts`, bind
`ENTITY_EVENTS`, call the shared publisher. Widget mutations start reaching
audit, search, webhooks, and workflow triggers for the first time — expect a
step change in audit-log volume and verify the widget's anonymous/end-user
`userId` is something the audit writer handles.

### Phase 4 — hardening

- Zod validation of `EntityEventMessage` at the dispatcher boundary. Invalid
  messages ack and go to the DLQ table rather than retrying forever.
- DLQ consumer → `entity_event_failures` table (event id, consumer name, error,
  attempt count, raw body) + a replay endpoint.
- Per-consumer counters and duration logging, keyed on `consumer.name`.
- Extend `_event-coverage.test.ts`
  ([app-api/src/routes/_event-coverage.test.ts:238](../apps/workers/app-api/src/routes/_event-coverage.test.ts#L238))
  to also cover `external-api` and `mcp-server`, which have 41 and 40 publishing
  files and no coverage guard at all.

### Phase 5 — catalog cleanup

- Resolve the duplicate helpdesk aliases (`ticket` / `helpdesk_ticket` /
  `desk_ticket` and the conversation equivalents) once their publishers are gone.
- Delete the `agent-dispatch` and `workflow-event-consumer` references from
  `events/helpdesk.ts` and `events/crm.ts` — neither module exists.
- Delete or rewrite `docs/autonomous-agents.md`; it documents the deleted
  `apps/api-worker` and its frontend hooks are hardcoded to return `[]`.
- Decide whether the `won` / `lost` / `paid` / `resolved` / `escalated` derived
  actions are real. Only the `deriveEventTypes` subset at
  [workflow-dispatch.ts:98](../packages/core/entity-events/src/workflow-dispatch.ts#L98)
  is implemented.

---

## 4. What this buys

- Adding a consumer: one file + one registry line. No queue, no wrangler edit, no
  new worker, no producer changes.
- Two tenant-DB reads removed from every single mutation's write path.
- One retry and dead-letter policy instead of three inconsistent ones, with
  nothing silently deleted.
- One place to see every consumer of a mutation, instead of reconstructing it
  from `publisher.ts` plus sixteen wrangler files.
- Two dead queues and one duplicate publisher deleted.

## 5. Known risks

- **Blast radius.** All inline consumers share one isolate and one deploy. A
  consumer that hangs eats the dispatcher's CPU budget. Mitigated by per-consumer
  `Promise.allSettled` isolation and by the `transport: 'queue'` escape hatch for
  anything heavy — but it is a real trade against the per-queue-per-worker model.
- **Workflow-trigger latency** goes from ~0 to ~1s (phase 2 step 4). If any
  automation is latency-sensitive enough that this matters, that sink stays
  inline and the plan absorbs it.
- **Idempotency is now a contract**, not an implementation detail. Phase 2 step 1
  needs a schema change to enforce it for audit.
