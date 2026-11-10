/**
 * /api/audit-log-streams against a real tenant schema (pglite): validation,
 * the URL rules, the write-only token, the limit of 5, status transitions,
 * entity events that carry no token, URL or error text, permissions and the
 * test endpoint.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { decryptField } from '@weldsuite/db/lib/crypto';
import { auditLogStreamsRoutes } from './index';

const KEY = 'ab'.repeat(32);
const TOKEN = 'hec-token-very-secret';
const MOUNT = '/api/audit-log-streams';

let db: Database;
const sent: Array<{ entityType: string; action: string; entityId: string; data: Record<string, unknown> }> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: KEY,
  ENTITY_EVENTS: { send: async (m: (typeof sent)[number]) => void sent.push(m) },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  sent.length = 0;
  await db.delete(schema.auditLogStreams);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Result {
  status: number;
  body: { data?: any; error?: { code: string; message: string; details?: any }; pagination?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(MOUNT, auditLogStreamsRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['general:read', 'general:update'])), tenantDb: db, userId: 'user_admin' },
    env: env as never,
  });
  const res = await request(`${MOUNT}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, text };
}

const valid = { name: 'Splunk prod', type: 'splunk_hec', url: 'https://splunk.example.com:8088/services/collector/event', token: TOKEN };

/** What a failed delivery left on a stream: it can quote the destination. */
const LAST_ERROR = 'HTTP 403: collector-said-no for tenant acme';

/**
 * An event says which stream and nothing else. The audit log keeps event data
 * and shows it to every member with general:read, who may not see a stream's
 * URL, settings or last error.
 */
function expectReducedEvent(
  event: (typeof sent)[number],
  data: { name: string; type: string; status: string; hasToken: boolean },
): void {
  expect(Object.keys(event.data).sort()).toEqual(['hasToken', 'id', 'name', 'status', 'type']);
  expect(event.data).toMatchObject(data);
  const dump = JSON.stringify(event);
  for (const hidden of [
    TOKEN,
    'tokenEncrypted',
    'token_encrypted',
    'splunk.example.com',
    'services/collector',
    'https://',
    '"url"',
    '"settings"',
    'secret-index',
    '"lastError"',
    LAST_ERROR,
    'collector-said-no',
    'cursorCreatedAt',
    'deliveredCount',
    'consecutiveFailures',
  ]) {
    expect(dump, hidden).not.toContain(hidden);
  }
}

/** A stream as a failed delivery leaves it. */
async function failOnce(id: string): Promise<void> {
  await db
    .update(schema.auditLogStreams)
    .set({ lastError: LAST_ERROR, consecutiveFailures: 3, lastAttemptAt: new Date() })
    .where(eq(schema.auditLogStreams.id, id));
}

async function create(overrides: Record<string, unknown> = {}) {
  const res = await call('', { method: 'POST', body: { ...valid, ...overrides } });
  expect(res.status, res.text).toBe(201);
  return res.body.data as { id: string };
}

describe('POST /', () => {
  it('creates a stream starting now, stores the token encrypted and never returns it', async () => {
    const before = Date.now();
    const res = await call('', { method: 'POST', body: { ...valid, settings: { index: 'sec', source: 'weld' } } });
    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data).toMatchObject({
      name: 'Splunk prod',
      type: 'splunk_hec',
      hasToken: true,
      status: 'active',
      consecutiveFailures: 0,
      deliveredCount: 0,
      lastError: null,
      settings: { index: 'sec', source: 'weld' },
      createdById: 'user_admin',
    });
    expect(Date.parse(data.cursorCreatedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(data.cursorCreatedAt)).toBe(Date.parse(data.createdAt));
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toContain('tokenEncrypted');
    expect(res.text).not.toContain('token_encrypted');

    const [row] = await db.select().from(schema.auditLogStreams).where(eq(schema.auditLogStreams.id, data.id));
    expect(row!.tokenEncrypted).not.toBe(TOKEN);
    expect(await decryptField(row!.tokenEncrypted!, { v1: KEY })).toBe(TOKEN);
  });

  it('works without a token', async () => {
    const res = await call('', { method: 'POST', body: { name: 'Open collector', type: 'http', url: 'https://c.example.com/in' } });
    expect(res.status).toBe(201);
    expect(res.body.data.hasToken).toBe(false);
  });

  it('refuses a URL that is not https, has credentials or points at a private network', async () => {
    for (const url of [
      'http://splunk.example.com/x',
      'https://user:pw@splunk.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://169.254.169.254/latest',
      'https://[::1]/x',
      'https://db.internal/x',
      'https://printer.local/x',
      'https://foo.localhost/x',
      'not a url',
    ]) {
      const res = await call('', { method: 'POST', body: { ...valid, url } });
      expect(res.status, url).toBe(400);
      expect(res.body.error?.details, url).toEqual({ field: 'url' });
    }
    expect(await db.select().from(schema.auditLogStreams)).toHaveLength(0);
  });

  it('validates the body', async () => {
    for (const body of [{}, { ...valid, name: '' }, { ...valid, type: 'syslog' }, { ...valid, settings: { format: 'xml' } }, { ...valid, settings: { authHeader: 'bad header' } }]) {
      expect((await call('', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('allows five streams and answers 409 for the sixth', async () => {
    for (let i = 0; i < 5; i++) await create({ name: `s${i}` });
    const res = await call('', { method: 'POST', body: valid });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');
    expect(await db.select().from(schema.auditLogStreams)).toHaveLength(5);
  });

  it('publishes an audit_log_stream created event without the token, the URL or the settings', async () => {
    const { id } = await create({ settings: { index: 'secret-index' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    // In conformance mode the binding saw the TypeScript run's event, a row with an id of its own.
    const createdId = conformanceTarget() ? expect.stringMatching(/^als_/) : id;
    expect(sent[0]).toMatchObject({ entityType: 'audit_log_stream', action: 'created', entityId: createdId });
    const dump = JSON.stringify(sent[0]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('tokenEncrypted');
    expect(sent[0]!.data.hasToken).toBe(true);
    expectReducedEvent(sent[0]!, { name: 'Splunk prod', type: 'splunk_hec', status: 'active', hasToken: true });
  });
});

describe('GET /', () => {
  it('lists the streams with hasToken and no token, oldest first', async () => {
    await create({ name: 'first' });
    await create({ name: 'second', token: null });
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { name: string; hasToken: boolean }) => [s.name, s.hasToken])).toEqual([
      ['first', true],
      ['second', false],
    ]);
    expect(res.body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toContain('tokenEncrypted');
  });

  it('is closed to general:read, since a collector URL can carry a secret', async () => {
    expect((await call('', { perms: ['general:read'] })).status).toBe(403);
    expect((await call('', { perms: ['general:update'] })).status).toBe(200);
  });
});

describe('PATCH /:id', () => {
  it('changes fields, keeps the token when omitted, replaces it, removes it with null', async () => {
    const { id } = await create();
    const stored = async () => (await db.select().from(schema.auditLogStreams).where(eq(schema.auditLogStreams.id, id)))[0]!;
    const original = (await stored()).tokenEncrypted;

    let res = await call(`/${id}`, { method: 'PATCH', body: { name: 'Renamed', url: 'https://other.example.com/in', settings: { host: 'h1' } } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', url: 'https://other.example.com/in', settings: { host: 'h1' }, hasToken: true });
    expect((await stored()).tokenEncrypted).toBe(original);

    res = await call(`/${id}`, { method: 'PATCH', body: { token: 'new-token-value' } });
    expect(res.text).not.toContain('new-token-value');
    expect(await decryptField((await stored()).tokenEncrypted!, { v1: KEY })).toBe('new-token-value');

    res = await call(`/${id}`, { method: 'PATCH', body: { token: null } });
    expect(res.body.data.hasToken).toBe(false);
    expect((await stored()).tokenEncrypted).toBeNull();
  });

  it('refuses an unsafe URL and an unknown stream', async () => {
    const { id } = await create();
    const bad = await call(`/${id}`, { method: 'PATCH', body: { url: 'https://192.168.0.1/x' } });
    expect(bad.status).toBe(400);
    expect((await call('/als_nope', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
  });

  it('pauses, and resuming clears the failure count and the last error', async () => {
    const { id } = await create();
    let res = await call(`/${id}`, { method: 'PATCH', body: { status: 'paused' } });
    expect(res.body.data.status).toBe('paused');

    await db
      .update(schema.auditLogStreams)
      .set({ status: 'disabled', consecutiveFailures: 20, lastError: 'HTTP 500' })
      .where(eq(schema.auditLogStreams.id, id));
    res = await call(`/${id}`, { method: 'PATCH', body: { status: 'active' } });
    expect(res.body.data).toMatchObject({ status: 'active', consecutiveFailures: 0, lastError: null });
  });

  it('cannot be set to disabled by a member', async () => {
    const { id } = await create();
    expect((await call(`/${id}`, { method: 'PATCH', body: { status: 'disabled' } })).status).toBe(400);
  });

  it('publishes an updated event without the token, the URL or the last error', async () => {
    const { id } = await create({ settings: { index: 'secret-index' } });
    await failOnce(id);
    sent.length = 0;
    const res = await call(`/${id}`, { method: 'PATCH', body: { name: 'x', token: 'zzz-secret-zzz', status: 'paused' } });
    // The answer still has it all, for the administrator who asked.
    expect(res.body.data).toMatchObject({ lastError: LAST_ERROR, url: valid.url, settings: { index: 'secret-index' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ entityType: 'audit_log_stream', action: 'updated', entityId: id });
    expect(JSON.stringify(sent[0])).not.toContain('zzz-secret-zzz');
    expectReducedEvent(sent[0]!, { name: 'x', type: 'splunk_hec', status: 'paused', hasToken: true });
  });
});

describe('DELETE /:id', () => {
  it('removes the stream with a 204 and publishes a deleted event without the token, the URL or the last error', async () => {
    const { id } = await create({ settings: { index: 'secret-index' }, token: null });
    await failOnce(id);
    sent.length = 0;
    const res = await call(`/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await db.select().from(schema.auditLogStreams)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0]).toMatchObject({ entityType: 'audit_log_stream', action: 'deleted', entityId: id });
    expect(JSON.stringify(sent[0])).not.toContain(TOKEN);
    expectReducedEvent(sent[0]!, { name: 'Splunk prod', type: 'splunk_hec', status: 'active', hasToken: false });
    expect((await call(`/${id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('permissions', () => {
  it('needs general:update for the list, every write and the test', async () => {
    const { id } = await create();
    const readOnly = ['general:read'];
    expect((await call('', { perms: readOnly })).status).toBe(403);
    expect((await call('', { method: 'POST', body: valid, perms: readOnly })).status).toBe(403);
    expect((await call(`/${id}`, { method: 'PATCH', body: { name: 'x' }, perms: readOnly })).status).toBe(403);
    expect((await call(`/${id}`, { method: 'DELETE', perms: readOnly })).status).toBe(403);
    expect((await call(`/${id}/test`, { method: 'POST', perms: readOnly })).status).toBe(403);
    expect((await call('', { perms: [] })).status).toBe(403);
  });
});

describe('POST /:id/test', () => {
  it('sends one test event with the stored token and answers ok, leaving the stream untouched', async () => {
    const { id } = await create();
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('{"text":"Success","code":0}', { status: 200 });
    });

    const res = await call(`/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, status: 200, error: null });
    expect(typeof res.body.data.durationMs).toBe('number');
    // In conformance mode the stub answers both backends, TypeScript's request first.
    expect(calls).toHaveLength(conformanceTarget() ? 2 : 1);
    expect(calls[0]!.headers.Authorization).toBe(`Splunk ${TOKEN}`);
    const envelope = JSON.parse(calls[0]!.body) as { event: { action: string; entityType: string; workspaceId: string } };
    expect(envelope.event).toMatchObject({ action: 'test', entityType: 'audit_log_stream', workspaceId: 'ws_test_default' });

    const [row] = await db.select().from(schema.auditLogStreams).where(eq(schema.auditLogStreams.id, id));
    expect(row).toMatchObject({ deliveredCount: 0, lastDeliveredAt: null, lastAttemptAt: null, cursorId: null, consecutiveFailures: 0 });
  });

  it('answers 200 with ok false, the status and an excerpt when the destination refuses', async () => {
    const { id } = await create();
    vi.stubGlobal('fetch', async () => new Response(`Invalid token ${TOKEN}`, { status: 401 }));
    const res = await call(`/${id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, status: 401, error: 'HTTP 401: Invalid token ***' });
    expect(res.text).not.toContain(TOKEN);
  });

  it('answers 200 with ok false and a null status when the destination cannot be reached', async () => {
    const { id } = await create();
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await call(`/${id}/test`, { method: 'POST' });
    expect(res.body.data).toMatchObject({ ok: false, status: null, error: 'Request failed: ECONNREFUSED' });
  });

  it('answers 404 for an unknown stream', async () => {
    expect((await call('/als_nope/test', { method: 'POST' })).status).toBe(404);
  });
});
