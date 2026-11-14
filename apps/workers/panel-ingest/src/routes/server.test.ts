import { keyKvKey, quotaKvKey, seenKvKey } from '@weldsuite/panel-domain/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, PROJECT_ID, WORKSPACE_ID, call, makeEnv, resetIsolateState } from '../testing/fakes';

const SECRET = `wps_${'0123456789abcdef'.repeat(2)}`;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function withKey() {
  const testEnv = makeEnv();
  testEnv.kv.store.set(
    keyKvKey(await sha256Hex(SECRET)),
    JSON.stringify({ v: 1, keyId: 'pnk_1', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
  );
  return testEnv;
}

const serverEvent = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt-00000001',
  name: 'Order placed',
  ts: iso(NOW - 1000),
  distinct_id: 'user-1',
  ...overrides,
});

const body = (events: unknown[], extra: Record<string, unknown> = {}) => ({ lib: 'server', lib_version: '0.1.0', events, ...extra });

const send = (
  testEnv: Awaited<ReturnType<typeof withKey>>,
  path: '/v1/track' | '/v1/import',
  payload: unknown,
  headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` },
) => call(testEnv, { path, body: payload, headers: { 'Content-Type': 'application/json', Origin: '', ...headers } });

describe.each(['/v1/track', '/v1/import'] as const)('POST %s', (path) => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('writes the events and answers how many it accepted', async () => {
    const testEnv = await withKey();
    const res = await send(
      testEnv,
      path,
      body([
        serverEvent({ props: { total: 12.5, coupon: null } }),
        serverEvent({
          event_id: 'evt-00000002',
          url: 'https://shop.example.com/thanks?utm_source=mail&token=secret',
          title: 'Thanks',
          user_id: 'user-1',
          anon_id: 'a-1',
          distinct_id: 'user-1',
        }),
      ]),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(testEnv.stream.sent[0]).toMatchObject({
      event_id: 'evt-00000001',
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      name: 'Order placed',
      distinct_id: 'user-1',
      anon_id: 'user-1',
      user_id: null,
      session_id: null,
      cookieless: false,
      url: '',
      host: '',
      path: '',
      lib: 'server',
      lib_version: '0.1.0',
      properties: '{"total":12.5,"coupon":null}',
      ts: iso(NOW - 1000),
    });
    expect(testEnv.stream.sent[1]).toMatchObject({
      url: 'https://shop.example.com/thanks?utm_source=mail',
      host: 'shop.example.com',
      path: '/thanks',
      utm_source: 'mail',
      title: 'Thanks',
      user_id: 'user-1',
      anon_id: 'a-1',
    });
  });

  it('adds no geo, user agent or visitor hash: the request is the customer server', async () => {
    const testEnv = await withKey();
    await send(testEnv, path, body([serverEvent()]));

    expect(testEnv.stream.sent[0]).toMatchObject({ country: null, region: null, city: null, device_type: null, browser: null, os: null, viewport_w: null });
    expect(JSON.stringify(testEnv.stream.sent)).not.toContain('203.0.113.7');
  });

  it('counts the events, stamps the install check and leaves recordings alone', async () => {
    const testEnv = await withKey();
    await send(testEnv, path, body([serverEvent(), serverEvent({ event_id: 'evt-00000002' })]));

    const usage = await testEnv.usage.get(WORKSPACE_ID).month('2026-10');
    expect(usage.events).toBe(2);
    expect(usage.recordings).toBe(0);
    expect(testEnv.kv.store.get(seenKvKey(PROJECT_ID))).toMatch(/^2026-10-27T/);
  });

  it('applies people operations, writing the profile row', async () => {
    const testEnv = await withKey();
    const res = await send(
      testEnv,
      path,
      body([serverEvent()], {
        people: [
          { op: 'set', user_id: 'user-1', ts: iso(NOW), props: { $email: 'Ada@Example.com', plan: 'pro' } },
          { op: 'increment', user_id: 'user-1', ts: iso(NOW), props: { orders: 1 } },
          { op: 'bogus' },
        ],
      }),
    );

    expect(res.status).toBe(200);
    expect(await testEnv.projects.get(PROJECT_ID).getPerson('user-1')).toMatchObject({ email: 'ada@example.com', properties: { plan: 'pro', orders: 1 } });
    expect(testEnv.people.sent).toHaveLength(1);
    expect(testEnv.projects.jurisdictions).toContain('eu');
  });

  it('links the anonymous id to the user in the project object for an $identify event', async () => {
    const testEnv = await withKey();
    const res = await send(
      testEnv,
      path,
      body([
        serverEvent({ name: '$identify', event_id: 'evt-identify-1', distinct_id: 'user-1', user_id: 'user-1', anon_id: 'a-browser' }),
        serverEvent({ name: '$identify', event_id: 'evt-identify-2', distinct_id: 'user-2', user_id: 'user-2' }),
      ]),
    );

    expect(res.status).toBe(200);
    expect(testEnv.identities.sent).toEqual([
      { workspace_id: expect.any(String), project_id: PROJECT_ID, anon_id: 'a-browser', user_id: 'user-1', ts: expect.any(String) },
    ]);
    expect(await testEnv.projects.get(PROJECT_ID).getPerson('a-browser')).toMatchObject({ userId: 'user-1' });
    expect(testEnv.projects.jurisdictions).toContain('eu');
  });

  it('needs a readable event even when people operations come along', async () => {
    const testEnv = await withKey();
    const res = await send(testEnv, path, body([{ nope: true }], { people: [] }));
    expect(res.status).toBe(400);
  });

  it('counts unreadable events as dropped and keeps the rest', async () => {
    const testEnv = await withKey();
    const res = await send(testEnv, path, body([serverEvent(), serverEvent({ event_id: 'evt-00000002', distinct_id: undefined })]));

    expect(await res.json()).toEqual({ accepted: 1, dropped: 1 });
    expect(testEnv.stream.sent).toHaveLength(1);
  });

  it('never takes a time in the future: a minute of skew is moved back to now, more is dropped', async () => {
    const testEnv = await withKey();
    const res = await send(
      testEnv,
      path,
      body([
        serverEvent({ ts: iso(NOW + 30 * 1000) }),
        serverEvent({ event_id: 'evt-00000002', ts: iso(NOW + 5 * 60 * 1000) }),
      ]),
    );

    expect(await res.json()).toEqual({ accepted: 1, dropped: 1 });
    expect(testEnv.stream.sent[0]!.ts).toBe(iso(NOW));
  });

  it('answers 200 with everything dropped when the workspace is events_blocked', async () => {
    const testEnv = await withKey();
    testEnv.kv.store.set(quotaKvKey(WORKSPACE_ID), 'events_blocked');
    const res = await send(testEnv, path, body([serverEvent()]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, dropped: 1 });
    expect(testEnv.stream.sent).toEqual([]);
  });

  it('answers 200 with everything dropped for the key of a paused project, and takes a resumed one again', async () => {
    const testEnv = await withKey();
    const hash = await sha256Hex(SECRET);
    const record = (status: 'active' | 'paused') =>
      JSON.stringify({ v: 1, keyId: 'pnk_1', workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, status });

    testEnv.kv.store.set(keyKvKey(hash), record('paused'));
    const paused = await send(testEnv, path, body([serverEvent()]));
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ accepted: 0, dropped: 1 });
    expect(testEnv.stream.sent).toEqual([]);

    testEnv.kv.store.set(keyKvKey(hash), record('active'));
    const resumed = await send(testEnv, path, body([serverEvent()]));
    expect(await resumed.json()).toEqual({ accepted: 1, dropped: 0 });
  });

  it('answers 503 when the stream refuses the rows, so the caller can retry', async () => {
    const testEnv = await withKey();
    testEnv.stream.send.mockRejectedValue(new Error('stream down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await send(testEnv, path, body([serverEvent()]));

    expect(res.status).toBe(503);
    expect((await testEnv.usage.get(WORKSPACE_ID).month('2026-10')).events).toBe(0);
    error.mockRestore();
  });

  describe('authentication', () => {
    it.each([
      ['no Authorization header', {}],
      ['a Basic scheme', { Authorization: `Basic ${SECRET}` }],
      ['a project token instead of a secret key', { Authorization: `Bearer wpk_${'a'.repeat(32)}` }],
      ['a malformed key', { Authorization: 'Bearer wps_short' }],
      ['an unknown key', { Authorization: `Bearer wps_${'f'.repeat(32)}` }],
    ])('answers 401 for %s', async (_label, headers) => {
      const testEnv = await withKey();
      const res = await send(testEnv, path, body([serverEvent()]), headers);

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
      expect(testEnv.stream.sent).toEqual([]);
    });

    it('answers 401 for a revoked key (its KV record is gone)', async () => {
      const testEnv = await withKey();
      testEnv.kv.store.delete(keyKvKey(await sha256Hex(SECRET)));
      expect((await send(testEnv, path, body([serverEvent()]))).status).toBe(401);
    });

    it('looks the key up by its hash, never by the secret', async () => {
      const testEnv = await withKey();
      await send(testEnv, path, body([serverEvent()]));

      const asked = vi.mocked(testEnv.kv.get as unknown as (key: string) => Promise<string | null>).mock.calls.map((c) => c[0]);
      expect(asked.some((key) => key.includes(SECRET))).toBe(false);
      expect(asked).toContain(keyKvKey(await sha256Hex(SECRET)));
    });

    it('answers 401 before reading a body that would be refused', async () => {
      const res = await send(await withKey(), path, '{not json', {});
      expect(res.status).toBe(401);
    });
  });

  describe('refusing what is malformed', () => {
    it('answers 400 for a body that is not JSON', async () => {
      const res = await send(await withKey(), path, '{not json');
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_body' } });
    });

    it('answers 400 for a web envelope, an empty batch and a batch of unreadable events', async () => {
      const testEnv = await withKey();
      expect((await send(testEnv, path, { ...body([serverEvent()]), lib: 'web' })).status).toBe(400);
      expect((await send(testEnv, path, body([]))).status).toBe(400);
      expect((await send(testEnv, path, body([{ nope: 1 }]))).status).toBe(400);
    });
  });
});

describe('POST /v1/track limits', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const many = (count: number, ts = iso(NOW - 1000)) =>
    Array.from({ length: count }, (_, i) => serverEvent({ event_id: `evt-${String(i).padStart(8, '0')}`, ts }));

  it('takes 100 events and refuses 101', async () => {
    const testEnv = await withKey();
    expect((await send(testEnv, '/v1/track', body(many(100)))).status).toBe(200);
    expect(testEnv.stream.sent).toHaveLength(100);
    expect((await send(testEnv, '/v1/track', body(many(101)))).status).toBe(400);
  });

  it('takes events from the last 7 days and drops older ones', async () => {
    const testEnv = await withKey();
    const res = await send(
      testEnv,
      '/v1/track',
      body([serverEvent({ ts: iso(NOW - 6 * DAY) }), serverEvent({ event_id: 'evt-00000002', ts: iso(NOW - 8 * DAY) })]),
    );

    expect(await res.json()).toEqual({ accepted: 1, dropped: 1 });
  });

  it('answers 413 over a MiB', async () => {
    const res = await send(await withKey(), '/v1/track', body([serverEvent({ props: { big: 'x'.repeat(1024) } })]), {
      Authorization: `Bearer ${SECRET}`,
      'Content-Length': String(2 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });
});

describe('POST /v1/import limits', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('takes 1000 events and refuses 1001', async () => {
    const testEnv = await withKey();
    const many = (count: number) => Array.from({ length: count }, (_, i) => serverEvent({ event_id: `evt-${String(i).padStart(8, '0')}` }));

    expect((await send(testEnv, '/v1/import', body(many(1000)))).status).toBe(200);
    expect(testEnv.stream.sent).toHaveLength(1000);
    expect((await send(testEnv, '/v1/import', body(many(1001)))).status).toBe(400);
  });

  it('takes events up to five years old and drops older ones, keeping their time', async () => {
    const testEnv = await withKey();
    const old = NOW - 4 * 365 * DAY;
    const res = await send(
      testEnv,
      '/v1/import',
      body([serverEvent({ ts: iso(old) }), serverEvent({ event_id: 'evt-00000002', ts: iso(NOW - 6 * 365 * DAY) })]),
    );

    expect(await res.json()).toEqual({ accepted: 1, dropped: 1 });
    expect(testEnv.stream.sent[0]!.ts).toBe(iso(old));
  });
});

describe('server routes and the browser routes', () => {
  it('are not reachable with GET', async () => {
    expect((await call(await withKey(), { method: 'GET', path: '/v1/track' })).status).toBe(404);
  });
});
