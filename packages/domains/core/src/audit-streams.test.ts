/**
 * Audit log stream delivery against a real tenant schema (pglite): wire
 * formats, the cursor (same-millisecond rows, microsecond fractions, batch
 * edges), failure / backoff / recovery, auto-disable, and isolation between
 * streams.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { encryptField } from '@weldsuite/db/lib/crypto';
import {
  AUDIT_STREAM_BATCH_SIZE,
  auditStreamBackoffMs,
  buildAuditStreamEvent,
  buildAuditStreamRequest,
  flushAuditLogStreams,
  sendAuditLogStreamTest,
  type AuditStreamEvent,
  type AuditStreamsDb,
} from './audit-streams';

const KEY = 'a'.repeat(64);
const keyring = { v2: KEY };
const TOKEN = 'tok-super-secret-123';

let db: Database;
const flushDb = () => db as unknown as AuditStreamsDb;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await db.delete(schema.auditLogStreams);
  await db.delete(schema.auditLogs);
});

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = '2026-11-01 10:00:00';
const CREATED = new Date('2026-11-01T09:00:00.000Z');

/** Insert audit rows with a text timestamp so microseconds survive. */
async function insertRow(id: string, createdAt: string, extra: { action?: string; metadata?: Record<string, unknown> } = {}): Promise<void> {
  await db.execute(sql`
    insert into audit_logs (id, created_at, entity_type, entity_id, action, description, performed_by, performed_by_name, ip_address, metadata, data)
    values (${id}, ${createdAt}::timestamp, 'customer', 'cus_1', ${extra.action ?? 'updated'}, 'Customer updated', 'user_1', 'Ann', '10.1.1.1',
            ${JSON.stringify(extra.metadata ?? { source: 'user', workspaceId: 'ws_1', eventId: 'ev_1', secretMeta: 'm' })}::jsonb,
            ${JSON.stringify({ snapshot: 'must-not-be-sent' })}::jsonb)
  `);
}

async function addStream(
  id: string,
  overrides: Partial<typeof schema.auditLogStreams.$inferInsert> = {},
  token: string | null = TOKEN,
): Promise<void> {
  await db.insert(schema.auditLogStreams).values({
    id,
    name: id,
    type: 'http',
    url: `https://${id}.example.com/ingest`,
    tokenEncrypted: token ? await encryptField(token, keyring) : null,
    status: 'active',
    cursorCreatedAt: CREATED,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  });
}

async function streamRow(id: string) {
  const [row] = await db.select().from(schema.auditLogStreams).where(eq(schema.auditLogStreams.id, id));
  return row!;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(respond: (url: string, call: number) => Response | Promise<Response> = () => new Response('ok', { status: 200 })) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') };
    calls.push(call);
    return respond(call.url, calls.length);
  }) as typeof fetch;
  return { calls, fetch: fakeFetch };
}

/** Ids of the events in a recorded `http` json body. */
function idsOf(call: Call): string[] {
  return (JSON.parse(call.body) as { events: AuditStreamEvent[] }).events.map((e) => e.id);
}

// ── builders ────────────────────────────────────────────────────────────────

const row = {
  id: 'audit_1',
  createdAt: new Date('2026-11-01T10:00:00.123Z'),
  entityType: 'customer',
  entityId: 'cus_1',
  action: 'updated',
  description: 'Customer updated',
  changes: { name: { from: 'A', to: 'B' } },
  performedBy: 'user_1',
  performedByName: 'Ann',
  ipAddress: '10.1.1.1',
  metadata: { source: 'user', workspaceId: 'ws_1', other: 'x' },
};

describe('wire formats', () => {
  it('builds an event without the data snapshot or other metadata', () => {
    expect(buildAuditStreamEvent({ ...row, metadata: { ...row.metadata, data: 'x' } })).toEqual({
      id: 'audit_1',
      timestamp: '2026-11-01T10:00:00.123Z',
      workspaceId: 'ws_1',
      action: 'updated',
      entityType: 'customer',
      entityId: 'cus_1',
      description: 'Customer updated',
      actor: { id: 'user_1', name: 'Ann' },
      source: 'user',
      changes: { name: { from: 'A', to: 'B' } },
      ipAddress: '10.1.1.1',
    });
  });

  it('Splunk HEC: Splunk token header, one envelope per line, defaults and index', () => {
    const events = [buildAuditStreamEvent(row), buildAuditStreamEvent({ ...row, id: 'audit_2' })];
    const req = buildAuditStreamRequest({ type: 'splunk_hec', url: 'https://s.example.com', settings: null }, TOKEN, events);
    expect(req.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Splunk ${TOKEN}` });
    const lines = req.body.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ time: 1793527200.123, host: 'weldsuite', source: 'weldsuite:audit', sourcetype: '_json', event: events[0] });
    expect('index' in lines[0]!).toBe(false);

    const custom = buildAuditStreamRequest(
      { type: 'splunk_hec', url: 'https://s.example.com', settings: { index: 'sec', host: 'h', source: 's', sourcetype: 'st' } },
      TOKEN,
      events.slice(0, 1),
    );
    expect(JSON.parse(custom.body)).toMatchObject({ index: 'sec', host: 'h', source: 's', sourcetype: 'st' });
  });

  it('http: json document, the token under the default or the chosen header, as given', () => {
    const events = [buildAuditStreamEvent(row)];
    const plain = buildAuditStreamRequest({ type: 'http', url: 'https://c.example.com', settings: null }, 'Bearer abc', events);
    expect(plain.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer abc' });
    expect(JSON.parse(plain.body)).toEqual({ events: JSON.parse(JSON.stringify(events)) });

    const datadog = buildAuditStreamRequest({ type: 'http', url: 'https://c.example.com', settings: { authHeader: 'DD-API-KEY' } }, 'barekey', events);
    expect(datadog.headers).toEqual({ 'Content-Type': 'application/json', 'DD-API-KEY': 'barekey' });

    const noToken = buildAuditStreamRequest({ type: 'http', url: 'https://c.example.com', settings: null }, null, events);
    expect(noToken.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('http ndjson: one event per line', () => {
    const events = [buildAuditStreamEvent(row), buildAuditStreamEvent({ ...row, id: 'audit_2' })];
    const req = buildAuditStreamRequest({ type: 'http', url: 'https://c.example.com', settings: { format: 'ndjson' } }, null, events);
    expect(req.headers['Content-Type']).toBe('application/x-ndjson');
    expect(req.body.split('\n').map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(['audit_1', 'audit_2']);
  });

  it('backoff is min(60 s * 2^failures, 1 h)', () => {
    expect(auditStreamBackoffMs(1)).toBe(120_000);
    expect(auditStreamBackoffMs(3)).toBe(480_000);
    expect(auditStreamBackoffMs(6)).toBe(3_600_000);
    expect(auditStreamBackoffMs(50)).toBe(3_600_000);
  });
});

// ── delivery ────────────────────────────────────────────────────────────────

describe('flushAuditLogStreams', () => {
  it('does nothing and sends nothing without streams', async () => {
    await insertRow('a1', '2026-11-01 10:00:00.100');
    const { calls, fetch } = recorder();
    expect(await flushAuditLogStreams(flushDb(), { keyring, fetch })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('sends rows after the cursor in order, advances it and counts them', async () => {
    await insertRow('old', '2026-11-01 08:00:00.000'); // before the stream existed
    await insertRow('a1', `${T0}.100`);
    await insertRow('a2', `${T0}.200`);
    await addStream('s1');
    const { calls, fetch } = recorder();
    const now = new Date('2026-11-01T10:05:00.000Z');

    const [result] = await flushAuditLogStreams(flushDb(), { keyring, fetch, now });
    expect(result).toMatchObject({ streamId: 's1', outcome: 'delivered', delivered: 2 });
    expect(calls).toHaveLength(1);
    expect(idsOf(calls[0]!)).toEqual(['a1', 'a2']);
    expect(calls[0]!.headers.Authorization).toBe(TOKEN);
    expect(calls[0]!.url).toBe('https://s1.example.com/ingest');

    const s = await streamRow('s1');
    expect(s).toMatchObject({ cursorId: 'a2', deliveredCount: 2, consecutiveFailures: 0, lastError: null });
    expect(s.cursorCreatedAt?.toISOString()).toBe('2026-11-01T10:00:00.200Z');
    expect(s.lastDeliveredAt?.toISOString()).toBe(now.toISOString());

    // Nothing new: no second request.
    await flushAuditLogStreams(flushDb(), { keyring, fetch, now });
    expect(calls).toHaveLength(1);

    // A new row is the only thing sent next.
    await insertRow('a3', `${T0}.300`);
    await flushAuditLogStreams(flushDb(), { keyring, fetch, now });
    expect(calls).toHaveLength(2);
    expect(idsOf(calls[1]!)).toEqual(['a3']);
  });

  it('never sends the data snapshot or metadata beyond source', async () => {
    await insertRow('a1', `${T0}.100`);
    await addStream('s1');
    const { calls, fetch } = recorder();
    await flushAuditLogStreams(flushDb(), { keyring, fetch });
    expect(calls[0]!.body).not.toContain('must-not-be-sent');
    expect(calls[0]!.body).not.toContain('secretMeta');
    expect(calls[0]!.body).toContain('"workspaceId":"ws_1"');
  });

  it('sends Splunk HEC bodies', async () => {
    await insertRow('a1', `${T0}.500`);
    await addStream('sp', { type: 'splunk_hec', settings: { index: 'sec' } });
    const { calls, fetch } = recorder();
    await flushAuditLogStreams(flushDb(), { keyring, fetch });
    expect(calls[0]!.headers.Authorization).toBe(`Splunk ${TOKEN}`);
    const envelope = JSON.parse(calls[0]!.body) as { time: number; index: string; sourcetype: string; event: { id: string } };
    expect(envelope).toMatchObject({ time: 1793527200.5, index: 'sec', sourcetype: '_json', event: { id: 'a1' } });
  });

  it('a stream created now does not see older rows, a paused one is left alone', async () => {
    await insertRow('a1', `${T0}.100`);
    await addStream('fresh', { cursorCreatedAt: new Date('2026-11-01T10:00:30.000Z'), createdAt: new Date('2026-11-01T10:00:30.000Z') });
    await addStream('paused', { status: 'paused' });
    const { calls, fetch } = recorder();
    await flushAuditLogStreams(flushDb(), { keyring, fetch });
    expect(calls).toHaveLength(0);
  });

  describe('cursor precision', () => {
    it('does not resend rows inside the same millisecond, with microsecond fractions', async () => {
      // Same millisecond (.123), different microseconds, ids not in time order.
      await insertRow('r_c', `${T0}.123900`);
      await insertRow('r_a', `${T0}.123100`);
      await insertRow('r_b', `${T0}.123456`);
      await insertRow('r_next', `${T0}.124001`);
      await addStream('s1');
      const { calls, fetch } = recorder();

      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(calls).toHaveLength(1);
      // Ordered by millisecond, then id.
      expect(idsOf(calls[0]!)).toEqual(['r_a', 'r_b', 'r_c', 'r_next']);

      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(calls).toHaveLength(1);
      expect((await streamRow('s1')).deliveredCount).toBe(4);
    });

    it('picks up a row that lands in the cursor millisecond later with a higher id', async () => {
      await insertRow('r_a', `${T0}.123100`);
      await addStream('s1');
      const { calls, fetch } = recorder();
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      await insertRow('r_z', `${T0}.123990`);
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(calls.map(idsOf)).toEqual([['r_a'], ['r_z']]);
    });

    it('walks a batch edge inside one millisecond without loss or repeat', async () => {
      const total = AUDIT_STREAM_BATCH_SIZE * 2 + 50;
      await db.execute(sql`
        insert into audit_logs (id, created_at, entity_type, entity_id, action, description)
        select 'm_' || lpad(g::text, 4, '0'), ${`${T0}.250000`}::timestamp + (g || ' microseconds')::interval,
               'customer', 'cus_1', 'updated', 'x'
        from generate_series(1, ${total}) g
      `);
      await addStream('s1');
      const { calls, fetch } = recorder();
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      const seen = calls.flatMap(idsOf);
      expect(calls.map((c) => idsOf(c).length)).toEqual([200, 200, 50]);
      expect(new Set(seen).size).toBe(total);
      expect(seen).toEqual([...seen].sort());
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(calls).toHaveLength(3);
    });
  });

  it('sends at most 5 requests per stream per flush and carries on next time', async () => {
    await db.execute(sql`
      insert into audit_logs (id, created_at, entity_type, entity_id, action, description)
      select 'b_' || lpad(g::text, 5, '0'), ${`${T0}.000000`}::timestamp + (g * 10 || ' milliseconds')::interval,
             'customer', 'cus_1', 'updated', 'x'
      from generate_series(1, 1100) g
    `);
    await addStream('s1');
    const { calls, fetch } = recorder();
    const [first] = await flushAuditLogStreams(flushDb(), { keyring, fetch });
    expect(calls).toHaveLength(5);
    expect(first!.delivered).toBe(1000);
    const [second] = await flushAuditLogStreams(flushDb(), { keyring, fetch });
    expect(second!.delivered).toBe(100);
    expect(calls).toHaveLength(6);
    expect(new Set(calls.flatMap(idsOf)).size).toBe(1100);
  });

  describe('failure handling', () => {
    it('records the failure, waits out the backoff, then recovers and resends the same rows', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1');
      let healthy = false;
      const { calls, fetch } = recorder(() =>
        healthy ? new Response('ok', { status: 200 }) : new Response(`denied for ${TOKEN}\n  try again`, { status: 403 }),
      );
      const t1 = new Date('2026-11-01T10:10:00.000Z');

      const [failed] = await flushAuditLogStreams(flushDb(), { keyring, fetch, now: t1 });
      expect(failed).toMatchObject({ outcome: 'failed', delivered: 0 });
      let s = await streamRow('s1');
      expect(s).toMatchObject({ consecutiveFailures: 1, status: 'active', deliveredCount: 0 });
      expect(s.lastError).toBe('HTTP 403: denied for *** try again');
      expect(s.lastError).not.toContain(TOKEN);
      expect(s.lastAttemptAt?.toISOString()).toBe(t1.toISOString());
      expect(s.cursorId).toBeNull();

      // Inside the 120 s backoff: not even tried.
      const [waiting] = await flushAuditLogStreams(flushDb(), { keyring, fetch, now: new Date(t1.getTime() + 119_000) });
      expect(waiting!.outcome).toBe('backoff');
      expect(calls).toHaveLength(1);

      // After it, and the destination is back.
      healthy = true;
      const t2 = new Date(t1.getTime() + 121_000);
      const [ok] = await flushAuditLogStreams(flushDb(), { keyring, fetch, now: t2 });
      expect(ok).toMatchObject({ outcome: 'delivered', delivered: 1 });
      expect(idsOf(calls[1]!)).toEqual(['a1']);
      s = await streamRow('s1');
      expect(s).toMatchObject({ consecutiveFailures: 0, lastError: null, deliveredCount: 1, cursorId: 'a1' });
      expect(s.lastDeliveredAt?.toISOString()).toBe(t2.toISOString());
    });

    it('grows the wait with each failure', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1', { consecutiveFailures: 3, lastAttemptAt: new Date('2026-11-01T10:10:00.000Z') });
      const { calls, fetch } = recorder(() => new Response('no', { status: 500 }));
      // 3 failures -> 480 s.
      await flushAuditLogStreams(flushDb(), { keyring, fetch, now: new Date('2026-11-01T10:17:00.000Z') });
      expect(calls).toHaveLength(0);
      await flushAuditLogStreams(flushDb(), { keyring, fetch, now: new Date('2026-11-01T10:18:01.000Z') });
      expect(calls).toHaveLength(1);
      expect((await streamRow('s1')).consecutiveFailures).toBe(4);
    });

    it('switches the stream off at the 20th consecutive failure', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1', { consecutiveFailures: 19, lastAttemptAt: new Date('2026-11-01T08:00:00.000Z') });
      const { calls, fetch } = recorder(() => new Response('no', { status: 502 }));
      await flushAuditLogStreams(flushDb(), { keyring, fetch, now: new Date('2026-11-01T10:30:00.000Z') });
      expect(await streamRow('s1')).toMatchObject({ status: 'disabled', consecutiveFailures: 20 });
      await flushAuditLogStreams(flushDb(), { keyring, fetch, now: new Date('2026-11-02T10:30:00.000Z') });
      expect(calls).toHaveLength(1);
    });

    it('a failing stream does not hold back a healthy one', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('bad');
      await addStream('good');
      const { calls, fetch } = recorder((url) => (url.includes('bad') ? new Response('no', { status: 500 }) : new Response('ok')));
      const results = await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(results.map((r) => [r.streamId, r.outcome]).sort()).toEqual([
        ['bad', 'failed'],
        ['good', 'delivered'],
      ]);
      expect(calls).toHaveLength(2);
      expect((await streamRow('good')).deliveredCount).toBe(1);
      expect((await streamRow('bad')).consecutiveFailures).toBe(1);
    });

    it('a request that throws or times out is a failure, not an exception', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1');
      const boom = (async () => {
        throw Object.assign(new Error(`connect failed for ${TOKEN}`), { name: 'Error' });
      }) as typeof fetch;
      await expect(flushAuditLogStreams(flushDb(), { keyring, fetch: boom })).resolves.toHaveLength(1);
      const s = await streamRow('s1');
      expect(s.lastError).toBe('Request failed: connect failed for ***');

      const slow = (async () => {
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
      }) as typeof fetch;
      await db.update(schema.auditLogStreams).set({ lastAttemptAt: null });
      await flushAuditLogStreams(flushDb(), { keyring, fetch: slow });
      expect((await streamRow('s1')).lastError).toBe('Timed out after 10 s');
    });

    it('treats a redirect as a failure and does not follow it', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1');
      let redirectSeen: string | undefined;
      const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        redirectSeen = init?.redirect;
        return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com' } });
      }) as typeof globalThis.fetch;
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(redirectSeen).toBe('manual');
      expect((await streamRow('s1')).lastError).toBe('HTTP 302');
    });

    it('fails a stream whose URL points at a private address, unless private networks are allowed', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1', { url: 'https://10.0.0.5/ingest' });
      const { calls, fetch } = recorder();
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(calls).toHaveLength(0);
      expect((await streamRow('s1')).lastError).toBe('The URL points at a private or local address');

      await db.update(schema.auditLogStreams).set({ lastAttemptAt: null });
      await flushAuditLogStreams(flushDb(), { keyring, fetch, allowPrivateNetworks: true });
      expect(calls).toHaveLength(1);
    });

    it('fails, without leaking, when the stored token cannot be decrypted', async () => {
      await insertRow('a1', `${T0}.100`);
      await addStream('s1', { tokenEncrypted: 'v2:00:00' });
      const { calls, fetch } = recorder();
      await flushAuditLogStreams(flushDb(), { keyring, fetch });
      expect(calls).toHaveLength(0);
      expect((await streamRow('s1')).lastError).toBe('The stored token cannot be decrypted; enter it again');
    });

    it('never throws when the database does', async () => {
      const broken = { select: () => { throw new Error('db down'); } } as unknown as AuditStreamsDb;
      await expect(flushAuditLogStreams(broken, { keyring })).resolves.toEqual([]);
    });
  });
});

// ── test event ──────────────────────────────────────────────────────────────

describe('sendAuditLogStreamTest', () => {
  it('sends one synthetic event, answers ok and touches no cursor', async () => {
    await addStream('s1');
    const stream = await streamRow('s1');
    const { calls, fetch } = recorder();
    const result = await sendAuditLogStreamTest(stream, { keyring, fetch, now: new Date('2026-11-01T11:00:00.000Z') });
    expect(result).toMatchObject({ ok: true, status: 200, error: null });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const events = (JSON.parse(calls[0]!.body) as { events: AuditStreamEvent[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'test', entityType: 'audit_log_stream', timestamp: '2026-11-01T11:00:00.000Z' });
    expect(calls[0]!.headers.Authorization).toBe(TOKEN);
    expect(await streamRow('s1')).toMatchObject({ deliveredCount: 0, lastDeliveredAt: null, cursorId: null });
  });

  it('reports a refusal with its status and an excerpt free of the token', async () => {
    await addStream('s1', { type: 'splunk_hec' });
    const stream = await streamRow('s1');
    const { fetch } = recorder(() => new Response(`{"text":"Invalid token ${TOKEN}","code":4}`, { status: 401 }));
    const result = await sendAuditLogStreamTest(stream, { keyring, fetch });
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.error).toBe('HTTP 401: {"text":"Invalid token ***","code":4}');
  });

  it('answers a network failure with a null status and refuses a private URL', async () => {
    await addStream('s1');
    const stream = await streamRow('s1');
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await sendAuditLogStreamTest(stream, { keyring, fetch: down })).toMatchObject({ ok: false, status: null, error: 'Request failed: ECONNREFUSED' });
    const priv = await sendAuditLogStreamTest({ ...stream, url: 'https://127.0.0.1/x' }, { keyring, fetch: recorder().fetch });
    expect(priv).toMatchObject({ ok: false, status: null, error: 'The URL points at a private or local address' });
  });
});
