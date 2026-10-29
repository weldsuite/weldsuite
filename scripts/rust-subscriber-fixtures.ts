/**
 * Parity fixtures for the Rust hub subscribers (`rust/crates/subscribers`,
 * the `weldsuite consume` role, P4 4f of the editions plan).
 *
 * Runs the TypeScript consumers on pglite with the same entity-event batches
 * the Rust tests feed their ports of them, and writes what TypeScript did:
 * the ack/retry of every message, the rows written, the outbound HTTP
 * requests and the realtime publishes. The Rust tests
 * (`rust/crates/subscribers/tests/parity.rs`) seed the same rows into
 * Postgres, run the same batches and compare, so the expectations come from
 * TypeScript.
 *
 *   pnpm exec tsx scripts/rust-subscriber-fixtures.ts           write the fixtures
 *   pnpm exec tsx scripts/rust-subscriber-fixtures.ts --check   exit 1 when one is stale
 *
 * Events are stored as the JSON text a producer sends, so their key order
 * (the order of `changes`, for one) is what the consumers see.
 *
 * Values that differ on every run (generated ids, timestamps, durations) are
 * replaced by placeholders on both sides; a network error's message (which
 * `fetch` words per runtime) becomes `<network error>`.
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgliteDb, pgliteClientOf } from '../packages/core/worker-kit/src/testing/pglite';
import {
  ENTITY_EVENT_SUBSCRIBERS,
  matchEntityEventSubscribers,
  topicMatches,
} from '../packages/core/entity-events/src/subscribers';
import {
  dispatchWebhookDeliveries,
  retryFailedWebhookDeliveries,
} from '../packages/core/entity-events/src/webhook-delivery';
import type { EntityEventMessage } from '../packages/core/entity-events/src/types';
import { writeAuditLogFromEvent } from '../apps/workers/audit-log-worker/src/services/audit-log-writer';
import { processAuditBatch } from '../apps/workers/audit-log-worker/src/services/batch-processor';
import { handleEntityRealtimeBatch } from '../apps/workers/realtime-worker/src/entity-realtime-consumer';
import { groupBatch } from '../apps/workers/app-api/src/queue/search-index-consumer';
import { EMBED_MODEL, indexEntity } from '../apps/workers/app-api/src/services/search/indexer';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'rust', 'crates', 'subscribers', 'tests', 'fixtures');
const check = process.argv.includes('--check');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface QueueMessage<T> {
  id: string;
  timestamp: Date;
  attempts: number;
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** A queue batch whose messages record what the consumer decided. */
function makeBatch<T>(queue: string, bodies: T[]) {
  const outcomes: Json[] = bodies.map(() => null);
  const messages: QueueMessage<T>[] = bodies.map((body, index) => ({
    id: `m${index}`,
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack: () => {
      outcomes[index] ??= 'ack';
    },
    retry: () => {
      outcomes[index] ??= 'retry';
    },
  }));
  const batch = {
    queue,
    messages,
    ackAll: () => messages.forEach((m) => m.ack()),
    retryAll: () => messages.forEach((m) => m.retry()),
  };
  return { batch, outcomes };
}


const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/** Placeholders for the values that change on every run. */
function normalise(value: Json, key = ''): Json {
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise(value[k]!, k);
    return out;
  }
  if (typeof value === 'string') return normaliseString(value, key);
  if (key === 'response_time_ms' && typeof value === 'number') return '<ms>';
  return value;
}

function normaliseString(value: string, key: string): Json {
  if (key === 'id' && /^(aud|sidx)_[0-9a-z]+$/.test(value)) return `<id:${value.split('_')[0]}>`;
  if (key === 'id' && /^whd_[0-9a-f]{16}$/.test(value)) return '<id:whd>';
  if (ISO.test(value)) return '<ts>';
  if (key !== 'embedding' || !value.startsWith('[')) return value;
  const numbers = JSON.parse(value) as number[];
  const hot = numbers.flatMap((n, i) => (n === 1 ? [i] : []));
  return hot.length === 1 && numbers.every((n) => n === 0 || n === 1) ? `<one-hot:${hot[0]}>` : value;
}

/** The deterministic vector both sides embed with: one-hot at an index taken from the text's SHA-256. */
function fakeVector(text: string): number[] {
  const hash = createHash('sha256').update(text).digest('hex');
  const vector = new Array<number>(1024).fill(0);
  vector[Number.parseInt(hash.slice(0, 8), 16) % 1024] = 1;
  return vector;
}

function event(partial: Partial<EntityEventMessage> & { id: string }): EntityEventMessage {
  const entityType = partial.entityType ?? 'customer';
  const action = partial.action ?? 'created';
  return {
    eventType: `${entityType}:${action}`,
    entityType,
    entityId: 'fx_entity',
    action,
    data: {},
    metadata: {
      workspaceId: 'org_fx',
      userId: 'fx_user_1',
      timestamp: '2026-10-29T12:00:00.000Z',
      source: 'web',
    },
    ...partial,
  } as EntityEventMessage;
}

/** The pglite tenant database and two helpers on it. */
interface Ctx {
  db: never;
  exec(statements: string[]): Promise<void>;
  rows(sql: string): Promise<Row[]>;
}

/** Runs `work` with the consumers' console output silenced. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await work();
  } finally {
    Object.assign(console, saved);
  }
}

// ---------------------------------------------------------------------------
// Registry: ENTITY_EVENT_SUBSCRIBERS, topicMatches and the queue settings
// ---------------------------------------------------------------------------

/** A production queue consumer's settings from a worker's wrangler.toml. */
function queueSettings(worker: string, queue: string): Json {
  const toml = readFileSync(path.join(repo, 'apps', 'workers', worker, 'wrangler.toml'), 'utf8');
  const blocks = toml.split(/\[\[env\.production\.queues\.consumers\]\]/).slice(1);
  for (const block of blocks) {
    const body = block.split(/\n\[/)[0]!;
    const field = (name: string) => new RegExp(`^${name}\\s*=\\s*"?([^"\\n]+)"?`, 'm').exec(body)?.[1];
    if (field('queue') !== queue) continue;
    const number = (name: string) => (field(name) === undefined ? null : Number(field(name)));
    return {
      queue,
      maxRetries: number('max_retries'),
      maxBatchSize: number('max_batch_size'),
      maxBatchTimeout: number('max_batch_timeout'),
      maxConcurrency: number('max_concurrency'),
      deadLetterQueue: field('dead_letter_queue') ?? null,
    };
  }
  return null;
}

function registryFixture(): Json {
  const eventTypes = ['customer:created', 'ticket:updated', 'co_machine:deleted', 'customer', ':created', 'customer:'];
  const patterns = ['*', 'customer:*', 'customer:created', 'ticket:*'];
  return {
    subscribers: ENTITY_EVENT_SUBSCRIBERS.map((s) => ({ id: s.id, topics: [...s.topics] })),
    matches: eventTypes.map((eventType) => ({
      eventType,
      subscribers: matchEntityEventSubscribers(eventType).map((s) => s.id),
      patterns: Object.fromEntries(patterns.map((p) => [p, topicMatches([p], eventType)])),
    })),
    queues: {
      audit: queueSettings('audit-log-worker', 'audit-events'),
      analytics: queueSettings('analytics-worker', 'analytics-events'),
      'search-index': queueSettings('app-api', 'search-index'),
      webhooks: queueSettings('integration-webhook-worker', 'entity-webhooks'),
      realtime: queueSettings('realtime-worker', 'entity-realtime'),
      hub: queueSettings('entity-events-worker', 'entity-events'),
    },
  };
}

// ---------------------------------------------------------------------------
// Audit log (audit-log-worker)
// ---------------------------------------------------------------------------

/**
 * `processEntityEvent` with the tenant database resolved to pglite: a
 * workspace that does not resolve throws, a locked one throws 28P01.
 */
async function processOnPglite(db: never, body: EntityEventMessage): Promise<void> {
  if (!body.metadata.workspaceId) return;
  if (body.metadata.workspaceId === 'ws_missing') throw new Error('Workspace not found: ws_missing');
  if (body.metadata.workspaceId === 'ws_locked') {
    throw Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' });
  }
  await writeAuditLogFromEvent(db, body);
}

async function auditFixture({ db, exec, rows }: Ctx): Promise<Json> {
  const auditSeed = [
    `delete from audit_logs where metadata->>'eventId' like 'evt_fx%'`,
    `delete from workspace_members where user_id like 'fx_%'`,
    `insert into workspace_members (id, user_id, name) values ('fxm_1', 'fx_user_1', 'Jane Doe'), ('fxm_2', 'fx_user_2', '')`,
  ];
  await exec(auditSeed);
  const auditEvents: EntityEventMessage[] = [
    event({ id: 'evt_fx_a01', entityId: 'cus_1', data: { id: 'cus_1', name: 'Acme', companyName: 'Acme BV' } }),
    event({
      id: 'evt_fx_a02',
      entityType: 'project_task',
      action: 'updated',
      entityId: 'tsk_1',
      data: { id: 'tsk_1', title: 'Fix login bug', status: 'done' },
      changes: {
        status: { old: 'todo', new: 'done' },
        priority: { old: 1, new: 2 },
        assigneeId: { old: null, new: 'usr_9' },
      },
    }),
    event({
      id: 'evt_fx_a03',
      entityType: 'opportunity',
      action: 'stage_changed',
      entityId: 'opp_1',
      data: { name: 'Zeta renewal', amount: 1200.5 },
      metadata: { workspaceId: 'org_fx', userId: 'fx_user_9', timestamp: '2026-10-29T12:00:00.000Z', source: 'api' },
    }),
    event({
      id: 'evt_fx_a04',
      entityType: 'contact',
      entityId: 'per_1',
      data: { firstName: 'Jane', lastName: 'Doe' },
      metadata: { workspaceId: 'org_fx', userId: '', timestamp: '2026-10-29T12:00:00.000Z', source: 'mobile' },
    }),
    event({
      id: 'evt_fx_a05',
      entityType: 'invoice',
      action: 'paid',
      entityId: 'inv_1',
      data: { invoiceNumber: 1001, total: 99 },
      metadata: { workspaceId: 'org_fx', userId: 'fx_user_2', timestamp: '2026-10-29T12:00:00.000Z' } as never,
    }),
    event({ id: 'evt_fx_a01', entityId: 'cus_1', data: { id: 'cus_1', name: 'Acme again' } }),
    event({
      id: 'evt_fx_a07',
      metadata: { workspaceId: '', userId: 'fx_user_1', timestamp: '2026-10-29T12:00:00.000Z', source: 'web' },
    }),
    event({
      id: 'evt_fx_a08',
      entityType: 'vat_return',
      action: 'updated',
      entityId: 'vat_1',
      data: { periodLabel: 'Q3 2026', status: 'draft' },
      changes: {},
    }),
    event({
      id: 'evt_fx_a09',
      entityType: 'ticket',
      action: 'updated',
      entityId: 'tic_9',
      data: { subject: 'Broken' },
      changes: { status: null } as never,
    }),
    event({ id: 'evt_fx_a10', entityType: 'helpdesk_ticket', entityId: 'tic_1', data: null as never }),
    event({
      id: 'evt_fx_a11',
      entityType: 'meeting_session',
      action: 'some-new_thing',
      entityId: 'ms_1',
      data: { title: '  Ünïcødé ✓ review  ' },
    }),
    event({
      id: 'evt_fx_a12',
      entityType: 'company',
      action: 'updated',
      entityId: 'co_1',
      data: { displayName: '', name: 'Acme Holding', tradingName: 'Acme' },
      // A change without `new`: `to` is left out.
      changes: { tradingName: { old: 'A', new: 'Acme' }, website_url: { old: null } } as never,
    }),
    event({ id: 'evt_fx_a13', metadata: { workspaceId: 'ws_missing', userId: 'fx_user_1', timestamp: 't', source: 'web' } }),
    event({ id: 'evt_fx_a14', metadata: { workspaceId: 'ws_locked', userId: 'fx_user_1', timestamp: 't', source: 'web' } }),
  ];
  const { batch, outcomes } = makeBatch('audit-events', auditEvents);
  const requeued: Array<{ index: number; delaySeconds: number | undefined }> = [];
  const env = {
    AUDIT_EVENTS: {
      send: async (body: EntityEventMessage, options?: { delaySeconds?: number }) => {
        const index = auditEvents.findIndex((e) => e === body || e.id === body.id);
        requeued.push({ index, delaySeconds: options?.delaySeconds });
      },
    },
  };
  await quietly(() => processAuditBatch(batch as never, env as never, (body) => processOnPglite(db, body)));
  for (const { index, delaySeconds } of requeued) outcomes[index] = { defer: delaySeconds ?? 0 };
  return {
    seed: auditSeed,
    events: auditEvents.map((e) => JSON.stringify(e)),
    outcomes,
    rows: await rows(
      `select to_jsonb(a) as row from audit_logs a where metadata->>'eventId' like 'evt_fx%' order by metadata->>'eventId'`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Realtime (realtime-worker)
// ---------------------------------------------------------------------------

async function realtimeFixture(): Promise<Json> {
  const realtimeEvents: EntityEventMessage[] = [
    event({ id: 'evt_fx_r1', entityType: 'ticket', action: 'updated', entityId: 't1', data: { id: 't1', subject: 'Hi', nested: { b: 1, a: [1, 2] } } }),
    event({ id: 'evt_fx_r2', entityType: 'ticket', entityId: 't2', data: { id: 't2' }, accessUserIds: ['usr_2', 'usr_3'] }),
    event({ id: 'evt_fx_r3', entityType: 'chat_message', entityId: 'm1', data: { id: 'm1' }, metadata: { workspaceId: 'ws_fx', userId: '', timestamp: 't', source: 'system' } }),
    event({ id: 'evt_fx_r4', metadata: { workspaceId: '', userId: 'u', timestamp: 't', source: 'web' } }),
    event({ id: 'evt_fx_r5', entityType: 'task', entityId: 'k1', data: ['a', 'b'] as never, accessUserIds: ['usr_4'] }),
    event({ id: 'evt_fx_r6', entityType: 'boom', entityId: 'b1', data: { id: 'b1' } }),
    event({ id: 'evt_fx_r7', entityType: 'note', entityId: 'n1', data: null as never, accessUserIds: [] }),
  ];
  const publishes: Json[] = [];
  const env = {
    WORKSPACE_HUB: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as Record<string, Json>;
          if (body.topic === 'boom') return new Response('hub down', { status: 500 });
          publishes.push({ hubKey: id.name, body });
          return new Response('ok');
        },
      }),
    },
  };
  const { batch, outcomes } = makeBatch('entity-realtime', realtimeEvents);
  await quietly(() => handleEntityRealtimeBatch(batch as never, env as never));
  return { events: realtimeEvents.map((e) => JSON.stringify(e)), outcomes, publishes };
}

// ---------------------------------------------------------------------------
// Outbound webhooks (integration-webhook-worker, webhook-delivery.ts)
// ---------------------------------------------------------------------------

const HOOK_SECRETS: Record<string, string> = { '/ok': 's1', '/fail': 's2', '/ok3': 's3', '/notfound': 's6', '/down': 's7' };

/** The endpoints the seeded webhooks point at, recording what reaches them. */
function hookFetch(requests: Json[]) {
  return async (input: string, init: { headers: Record<string, string>; body: string }) => {
    const url = new URL(input);
    // A refused connection never reaches a server, so it is not a request.
    if (url.pathname === '/down') throw new TypeError('fetch failed');
    const headers = new Headers(init.headers);
    const signature = headers.get('x-weldsuite-signature');
    requests.push({
      path: url.pathname,
      method: 'POST',
      contentType: headers.get('content-type'),
      event: headers.get('x-weldsuite-event'),
      custom: headers.get('x-custom'),
      signatureValid: signature === createHmac('sha256', HOOK_SECRETS[url.pathname]!).update(init.body).digest('hex'),
      body: normalise(JSON.parse(init.body) as Json),
    });
    if (url.pathname === '/ok' || url.pathname === '/ok3') return new Response('thanks', { status: 200 });
    if (url.pathname === '/fail') return new Response('boom', { status: 500 });
    return new Response('nope', { status: 404 });
  };
}

/**
 * `handleEntityWebhookMessage` with the workspace resolved to pglite:
 * `org_…` names the organization; `ws_fx` resolves to `org_fx`.
 */
async function dispatchOnPglite(db: never, messages: QueueMessage<EntityEventMessage>[]): Promise<void> {
  for (const message of messages) {
    const key = message.body.metadata.workspaceId;
    if (key) {
      await dispatchWebhookDeliveries({
        db,
        workspaceId: key.startsWith('org_') ? key : 'org_fx',
        entityType: message.body.entityType,
        action: message.body.action,
        eventId: message.body.id,
        data: (message.body.data ?? {}) as Record<string, unknown>,
      });
    }
    message.ack();
  }
}

function sortRequests(list: Json[]): Json[] {
  return [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function webhookState(rows: Ctx['rows'], requests: Json[]): Promise<Record<string, Json>> {
  const deliveries = await rows(
    `select to_jsonb(d) as row from webhook_deliveries d where webhook_id like 'fxw_%' order by event_id, webhook_id, attempt_number`,
  );
  const webhooks = await rows(
    `select jsonb_build_object('id', id, 'status', status, 'consecutive_failures', consecutive_failures, 'total_deliveries', total_deliveries, 'total_failures', total_failures, 'last_failure_reason', last_failure_reason, 'last_delivered_at', last_delivered_at, 'last_failed_at', last_failed_at, 'updated_at', updated_at) as row from external_webhooks where id like 'fxw_%' order by id`,
  );
  return {
    requests: sortRequests(requests.splice(0)),
    deliveries: deliveries.map(networkPlaceholders),
    webhooks: webhooks.map(networkPlaceholders),
  };
}

const MAKE_DUE = `update webhook_deliveries set next_retry_at = now() - interval '1 minute' where webhook_id like 'fxw_%' and next_retry_at is not null`;

async function webhooksFixture({ db, exec, rows }: Ctx): Promise<Json> {
  const webhookSeed = [
    `delete from webhook_deliveries where webhook_id like 'fxw_%'`,
    `delete from external_webhooks where id like 'fxw_%'`,
    `insert into external_webhooks (id, name, url, events, secret, headers, status, consecutive_failures, total_deliveries, total_failures, created_by, deleted_at) values
      ('fxw_1', 'Main', 'http://hooks.test/ok', '["ticket.created","ticket.updated"]', 's1', '{"X-Custom":"yes"}', 'active', 0, 0, 0, 'u', null),
      ('fxw_2', 'Flaky', 'http://hooks.test/fail', '["ticket.created"]', 's2', null, 'active', 19, 40, 19, 'u', null),
      ('fxw_3', 'Legacy', 'http://hooks.test/ok3', '["customer.created"]', 's3', null, 'active', 0, 0, 0, 'u', null),
      ('fxw_4', 'Paused', 'http://hooks.test/ok', '["ticket.created"]', 's4', null, 'paused', 0, 0, 0, 'u', null),
      ('fxw_5', 'Deleted', 'http://hooks.test/ok', '["ticket.created"]', 's5', null, 'active', 0, 0, 0, 'u', now()),
      ('fxw_6', 'Missing', 'http://hooks.test/notfound', '["ticket.updated"]', 's6', null, 'active', 0, 0, 0, 'u', null),
      ('fxw_7', 'Down', 'http://hooks.test/down', '["deal.created"]', 's7', null, 'active', 2, 2, 2, 'u', null)`,
    `insert into webhook_deliveries (id, webhook_id, event_type, event_id, payload, status, attempt_number, max_retries) values
      ('fxd_1', 'fxw_1', 'ticket.created', 'evt_fx_dup', '{"id":"evt_fx_dup"}', 'delivered', 1, 5)`,
  ];
  await exec(webhookSeed);
  const webhookEvents: EntityEventMessage[] = [
    event({ id: 'evt_fx_w1', entityType: 'ticket', entityId: 't1', data: { id: 't1', subject: 'Help', nested: { b: 1, a: 2 } } }),
    event({ id: 'evt_fx_w2', entityType: 'ticket', action: 'updated', entityId: 't1', data: { id: 't1', subject: 'Help!' } }),
    event({ id: 'evt_fx_w3', entityType: 'company', entityId: 'c1', data: { id: 'c1', name: 'Acme' }, metadata: { workspaceId: 'ws_fx', userId: 'u', timestamp: 't', source: 'web' } }),
    event({ id: 'evt_fx_dup', entityType: 'ticket', entityId: 't9', data: { id: 't9' } }),
    event({ id: 'evt_fx_w5', entityType: 'deal', entityId: 'd1', data: null as never }),
    event({ id: 'evt_fx_w6', entityType: 'ticket', metadata: { workspaceId: '', userId: 'u', timestamp: 't', source: 'web' } }),
    event({ id: 'evt_fx_w7', entityType: 'invoice', action: 'paid', entityId: 'i1', data: { id: 'i1' } }),
  ];
  const requests: Json[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = hookFetch(requests) as never;
  try {
    const { batch, outcomes } = makeBatch('entity-webhooks', webhookEvents);
    await quietly(() => dispatchOnPglite(db, batch.messages));
    const firstPass = await webhookState(rows, requests);
    // The cron sweep, with every pending retry due now.
    await exec([MAKE_DUE]);
    const retried = await quietly(() => retryFailedWebhookDeliveries(db));
    return {
      seed: webhookSeed,
      events: webhookEvents.map((e) => JSON.stringify(e)),
      outcomes,
      ...firstPass,
      retry: { makeDue: MAKE_DUE, result: retried as unknown as Json, ...(await webhookState(rows, requests)) },
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// Semantic search index (app-api search-index consumer)
// ---------------------------------------------------------------------------

type Embedder = { embed(texts: string[]): Promise<number[][]> };

/** One indexing job: ack its messages, or retry them when indexing fails. */
async function indexJob(
  db: never,
  embedder: Embedder,
  job: { entityType: string; entityId: string; messages: QueueMessage<unknown>[] },
): Promise<void> {
  try {
    await indexEntity(db, embedder, job.entityType as never, job.entityId);
    for (const m of job.messages) m.ack();
  } catch {
    for (const m of job.messages) m.retry();
  }
}

/**
 * `handleSearchIndexBatch` with the tenant database resolved to pglite and
 * `ws_gone` not resolving (its jobs are dropped, acked).
 */
async function indexOnPglite(db: never, embedder: Embedder, messages: QueueMessage<EntityEventMessage>[]): Promise<void> {
  const byWorkspace = groupBatch(messages as never);
  for (const [workspaceId, jobs] of byWorkspace) {
    for (const job of jobs.values()) {
      if (workspaceId === 'ws_gone') job.messages.forEach((m) => m.ack());
      else await indexJob(db, embedder, job as never);
    }
  }
}

async function searchFixture({ db, exec, rows }: Ctx): Promise<Json> {
  const paragraph = (n: number) =>
    `Paragraph ${n}: ` + 'The deploy pipeline builds the image, runs the migrations and rolls the pods. '.repeat(6);
  const longText = Array.from({ length: 9 }, (_, i) => paragraph(i + 1)).join('\n\n');
  const searchSeed = [
    `delete from search_index where entity_id like 'fx%'`,
    `delete from custom_field_values where id like 'fx%'`,
    `delete from custom_field_definitions where id like 'fx%'`,
    `delete from custom_object_records where id like 'fx%'`,
    `delete from custom_objects where id like 'fx%'`,
    `delete from knowledge_pages where id like 'fx%'`,
    `delete from knowledge_spaces where id like 'fx%'`,
    `delete from helpdesk_tickets where id like 'fx%'`,
    `delete from helpdesk_articles where id like 'fx%'`,
    `delete from tasks where id like 'fx%'`,
    `delete from projects where id like 'fx%'`,
    `delete from people where id like 'fx%'`,
    `delete from crm_opportunities where id like 'fx%'`,
    `delete from crm_leads where id like 'fx%'`,
    `delete from companies where id like 'fx%'`,
    `insert into knowledge_spaces (id, name, kind, visibility) values ('fx_space_open', 'Engineering', 'team', 'open'), ('fx_space_private', 'Board', 'team', 'private')`,
    `insert into knowledge_pages (id, space_id, title, content_text) values ('fx_kp_1', 'fx_space_open', 'Deploy guide', ${quote(longText)}), ('fx_kp_2', 'fx_space_private', 'Secret plans', 'Not for everyone')`,
    `insert into helpdesk_tickets (id, ticket_number, customer_name, customer_email, subject, description) values ('fx_t1', 'T-100', 'Acme', 'a@acme.test', 'Printer jams', 'It jams  a lot\tdaily.\n\nEvery morning.')`,
    `insert into helpdesk_articles (id, title, slug, content, author_id, excerpt, category_name) values ('fx_a1', 'Reset your password', 'reset', 'Open settings and press reset.', 'u', 'How to reset', 'Accounts')`,
    `insert into projects (id, name, code, description, created_at, updated_at) values ('fx_p1', 'Website', 'WEB', 'The new site', now(), now()), ('fx_p2', 'Broken', null, 'FAIL_EMBED', now(), now())`,
    `insert into tasks (id, title, number, description) values ('fx_task1', '', 42, 'Write the copy')`,
    `insert into people (id, display_name, first_name, last_name, email, title) values ('fx_person1', 'Jane Doe', 'Jane', 'Doe', 'jane@acme.test', 'CTO'), ('fx_person2', 'Nobody', null, null, null, null)`,
    `insert into companies (id, name, display_name, trading_name, email) values ('fx_co1', 'Acme BV', 'Acme BV', 'Acme', 'info@acme.test')`,
    `insert into crm_leads (id, email, first_name, company_name) values ('fx_lead1', 'bob@bobco.test', 'Bob', 'Bobco')`,
    `insert into crm_opportunities (id, name, customer_id, owner_id, customer_name, stage) values ('fx_opp1', 'Big deal', 'fx_co1', 'u', 'Acme', 'proposal')`,
    `insert into custom_objects (id, slug, entity_key, label_singular, label_plural, enable_search) values ('fx_obj1', 'machine', 'co_machine', 'Machine', 'Machines', true), ('fx_obj2', 'widget', 'co_widget', 'Widget', 'Widgets', false)`,
    `insert into custom_object_records (id, object_id, entity_key, title) values ('fx_rec1', 'fx_obj1', 'co_machine', 'CNC-4100'), ('fx_rec2', 'fx_obj2', 'co_widget', 'W-1')`,
    `insert into custom_field_definitions (id, entity_type, name, slug, field_type, sort_order) values ('fx_def_serial', 'co_machine', 'Serial', 'serial', 'text', 2), ('fx_def_tags', 'co_machine', 'Tags', 'tags', 'multi_select', 1), ('fx_def_power', 'co_machine', 'Power', 'power', 'number', 0)`,
    `insert into custom_field_values (id, field_id, entity_type, entity_id, value_text, value_json, value_number) values ('fx_v1', 'fx_def_serial', 'co_machine', 'fx_rec1', 'SN-1', null, null), ('fx_v2', 'fx_def_tags', 'co_machine', 'fx_rec1', null, '["lathe","cnc"]', null), ('fx_v3', 'fx_def_power', 'co_machine', 'fx_rec1', null, null, 7.5)`,
    `insert into search_index (id, entity_type, entity_id, chunk_index, content, content_hash, embedding, embed_model) values ('fx_old', 'contact', 'fx_person2', 0, 'old', 'old', '[${fakeVector('old').join(',')}]', '${EMBED_MODEL}')`,
  ];
  await exec(searchSeed);
  const searchBatches: Array<{ before: string[]; events: EntityEventMessage[] }> = [
    {
      before: [],
      events: [
        event({ id: 'evt_fx_s01', entityType: 'knowledge_page', entityId: 'fx_kp_1' }),
        event({ id: 'evt_fx_s02', entityType: 'knowledge_page', action: 'updated', entityId: 'fx_kp_2' }),
        event({ id: 'evt_fx_s03', entityType: 'ticket', entityId: 'fx_t1' }),
        event({ id: 'evt_fx_s04', entityType: 'ticket', action: 'updated', entityId: 'fx_t1' }),
        event({ id: 'evt_fx_s05', entityType: 'article', entityId: 'fx_a1' }),
        event({ id: 'evt_fx_s06', entityType: 'project', entityId: 'fx_p1' }),
        event({ id: 'evt_fx_s07', entityType: 'task', entityId: 'fx_task1' }),
        event({ id: 'evt_fx_s08', entityType: 'person', entityId: 'fx_person1' }),
        event({ id: 'evt_fx_s09', entityType: 'contact', action: 'updated', entityId: 'fx_person2' }),
        event({ id: 'evt_fx_s10', entityType: 'company', entityId: 'fx_co1' }),
        event({ id: 'evt_fx_s11', entityType: 'lead', entityId: 'fx_lead1' }),
        event({ id: 'evt_fx_s12', entityType: 'opportunity', entityId: 'fx_opp1' }),
        event({ id: 'evt_fx_s13', entityType: 'co_machine', entityId: 'fx_rec1' }),
        event({ id: 'evt_fx_s14', entityType: 'co_widget', entityId: 'fx_rec2' }),
        event({ id: 'evt_fx_s15', entityType: 'invoice', entityId: 'fx_inv1' }),
        event({ id: 'evt_fx_s16', entityType: 'ticket', entityId: '' }),
        event({ id: 'evt_fx_s18', entityType: 'project', action: 'updated', entityId: 'fx_p2' }),
        event({ id: 'evt_fx_s17', entityType: 'ticket', entityId: 'fx_t1', metadata: { workspaceId: 'ws_gone', userId: 'u', timestamp: 't', source: 'web' } }),
      ],
    },
    {
      before: [
        `update knowledge_pages set content_text = 'Short now' where id = 'fx_kp_1'`,
        `update helpdesk_tickets set deleted_at = now() where id = 'fx_t1'`,
      ],
      events: [
        event({ id: 'evt_fx_s21', entityType: 'knowledge_page', action: 'updated', entityId: 'fx_kp_1' }),
        event({ id: 'evt_fx_s22', entityType: 'ticket', action: 'deleted', entityId: 'fx_t1' }),
        event({ id: 'evt_fx_s23', entityType: 'project', action: 'updated', entityId: 'fx_p1' }),
      ],
    },
  ];
  const embedCalls: string[][] = [];
  const embedder: Embedder = {
    async embed(texts: string[]) {
      embedCalls.push(texts);
      if (texts.some((text) => text.includes('FAIL_EMBED'))) throw new Error('embedding service down');
      return texts.map(fakeVector);
    },
  };
  const results: Json[] = [];
  for (const { before, events } of searchBatches) {
    await exec(before);
    embedCalls.length = 0;
    const { batch, outcomes } = makeBatch('search-index', events);
    await quietly(() => indexOnPglite(db, embedder, batch.messages));
    results.push({
      before,
      events: events.map((e) => JSON.stringify(e)),
      outcomes,
      embedCalls: embedCalls.map((call) => [...call]),
      rows: await rows(
        `select to_jsonb(s) as row from search_index s where entity_id like 'fx%' order by entity_type, entity_id, chunk_index`,
      ),
    });
  }
  return { model: EMBED_MODEL, seed: searchSeed, batches: results };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Writes the fixtures, or with `--check` counts the stale ones. */
function writeFixtures(fixtures: Record<string, Json>): number {
  mkdirSync(outDir, { recursive: true });
  let stale = 0;
  for (const [name, value] of Object.entries(fixtures)) {
    const file = path.join(outDir, `${name}.json`);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const current = existsSync(file) ? readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : null;
    if (!check) {
      writeFileSync(file, text);
      console.log(`wrote ${path.relative(repo, file)}`);
    } else if (current !== text) {
      console.error(`stale: ${path.relative(repo, file)}`);
      stale++;
    }
  }
  return stale;
}

async function main(): Promise<void> {
  const { db } = await createPgliteDb();
  const client = pgliteClientOf(db);
  if (!client) throw new Error('no pglite client');
  const ctx: Ctx = {
    db: db as never,
    exec: async (statements) => {
      for (const statement of statements) await client.exec(statement);
    },
    rows: async (sql) => {
      const result = await client.query<{ row: Row }>(sql);
      return result.rows.map((r) => normalise(r.row as Json) as Row);
    },
  };

  const fixtures: Record<string, Json> = {
    registry: registryFixture(),
    audit: await auditFixture(ctx),
    realtime: await realtimeFixture(),
    webhooks: await webhooksFixture(ctx),
    search: await searchFixture(ctx),
  };
  if (writeFixtures(fixtures) > 0) {
    console.error('Run: pnpm rust:subscriber-fixtures');
    process.exit(1);
  }
  process.exit(0);
}

/** `fetch`'s own wording of a network failure differs per runtime. */
function networkPlaceholders(row: Row): Row {
  const out = { ...row };
  for (const key of ['error_message', 'last_failure_reason']) {
    const value = out[key];
    if (typeof value === 'string' && !/^HTTP \d{3}$/.test(value)) out[key] = '<network error>';
  }
  return out;
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
