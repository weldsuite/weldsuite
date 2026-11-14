import { gzipSync } from 'node:zlib';
import { quotaKvKey, snapshotRequestKvKey } from '@weldsuite/panel-domain/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOW,
  PROJECT_ID,
  TOKEN,
  WORKSPACE_ID,
  call,
  makeEnv,
  projectRecord,
  resetIsolateState,
} from '../testing/fakes';

const SESSION = 's-0123456789';
const START = NOW - 5000;
const END = NOW - 1000;
const CHUNK = new Uint8Array(gzipSync(JSON.stringify([{ type: 2, data: {}, timestamp: START }])));

function chunkPath(overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = { t: TOKEN, s: SESSION, q: '0', a: String(START), b: String(END), f: '1', ...overrides };
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `/r?${query}`;
}

const post = (testEnv: ReturnType<typeof makeEnv>, path: string, body: unknown = CHUNK, headers: Record<string, string> = {}) =>
  call(testEnv, { path, body, headers: { 'Content-Type': 'text/plain', ...headers } });

describe('POST /r', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('stores the chunk in the replays bucket and indexes it', async () => {
    const testEnv = makeEnv();
    const res = await post(testEnv, chunkPath());

    expect(res.status).toBe(204);
    const key = `30d/${WORKSPACE_ID}/${PROJECT_ID}/2026-10-27/${SESSION}/0.json.gz`;
    expect([...testEnv.replays.objects.keys()]).toEqual([key]);
    expect(testEnv.replays.objects.get(key)!.bytes).toEqual(CHUNK);
    expect(testEnv.replayChunks.sent).toEqual([
      {
        workspace_id: WORKSPACE_ID,
        project_id: PROJECT_ID,
        session_id: SESSION,
        seq: 0,
        ts_start: new Date(START).toISOString(),
        ts_end: new Date(END).toISOString(),
        bytes: CHUNK.byteLength,
        has_full_snapshot: true,
        r2_key: key,
      },
    ]);
  });

  it('answers before the writes finish', async () => {
    const testEnv = makeEnv();
    let release: () => void = () => {};
    vi.mocked(testEnv.replays.put).mockImplementation((() => new Promise((resolve) => (release = () => resolve(null)))) as never);
    const waited: Promise<unknown>[] = [];
    const request = new Request(`https://pnl.test${chunkPath()}`, { method: 'POST', body: CHUNK, headers: { Origin: 'https://shop.example.com' } });
    const { app } = await import('../index');

    const res = await app.fetch(request, testEnv.env, { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext);

    expect(res.status).toBe(204);
    expect(testEnv.replayChunks.sent).toEqual([]);
    release();
    await Promise.all(waited);
    expect(testEnv.replayChunks.sent).toHaveLength(1);
  });

  it('counts a recording once, when the first chunk arrives', async () => {
    const testEnv = makeEnv();
    await post(testEnv, chunkPath({ q: '0' }));
    await post(testEnv, chunkPath({ q: '1', f: '0' }));
    await post(testEnv, chunkPath({ q: '2', f: '0' }));

    const usage = await testEnv.usage.get(WORKSPACE_ID).month('2026-10');
    expect(usage.recordings).toBe(1);
    expect(usage.recordingDays).toEqual({ '2026-10-27': 1 });
    expect(usage.events).toBe(0);
    expect(testEnv.replayChunks.sent.map((row) => [row.seq, row.has_full_snapshot])).toEqual([[0, true], [1, false], [2, false]]);
  });

  it('uses the 90 day tier the project record names, and 30 days otherwise', async () => {
    const testEnv = makeEnv(projectRecord({ replayTier: '90d' }));
    await post(testEnv, chunkPath());
    expect([...testEnv.replays.objects.keys()][0]).toMatch(/^90d\//);
  });

  it('puts a chunk under the day it starts', async () => {
    const testEnv = makeEnv();
    await post(testEnv, chunkPath({ q: '3', a: String(NOW - 20 * 60 * 60 * 1000), b: String(NOW - 19 * 60 * 60 * 1000), f: '0' }));
    expect([...testEnv.replays.objects.keys()][0]).toContain('/2026-10-26/');
  });

  it('keeps client times inside a believable window', async () => {
    const testEnv = makeEnv();
    await post(testEnv, chunkPath({ a: String(NOW - 90 * 24 * 60 * 60 * 1000), b: String(NOW + 60 * 60 * 1000) }));

    const [row] = testEnv.replayChunks.sent;
    expect(Date.parse(row!.ts_start)).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
    expect(Date.parse(row!.ts_end)).toBe(NOW + 60 * 1000);
  });

  describe('refusing what is malformed', () => {
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ['a missing token', { t: undefined }],
      ['a bad session id', { s: 'no spaces allowed' }],
      ['a missing session', { s: undefined }],
      ['a negative seq', { q: '-1' }],
      ['a seq past the limit', { q: '100001' }],
      ['a fractional seq', { q: '1.5' }],
      ['a bad start', { a: 'yesterday' }],
      ['an end before the start', { a: String(END), b: String(START) }],
      ['a bad snapshot flag', { f: '2' }],
    ];

    it.each(cases)('answers 400 for %s', async (_label, overrides) => {
      const testEnv = makeEnv();
      const res = await post(testEnv, chunkPath(overrides));

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
      expect(testEnv.replays.objects.size).toBe(0);
    });

    it('answers 400 for a body that is not gzip', async () => {
      const res = await post(makeEnv(), chunkPath(), '[{"type":2}]'.padEnd(40, ' '));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_body' } });
    });

    it('answers 400 for an empty body', async () => {
      expect((await post(makeEnv(), chunkPath(), new Uint8Array(0))).status).toBe(400);
    });

    it('answers 413 over one MiB, whatever the Content-Length says', async () => {
      const testEnv = makeEnv();
      const big = new Uint8Array(1024 * 1024 + 1);
      big[0] = 0x1f;
      big[1] = 0x8b;

      expect((await post(testEnv, chunkPath(), big)).status).toBe(413);
      expect((await post(testEnv, chunkPath(), CHUNK, { 'Content-Length': '2000000' })).status).toBe(413);
      expect(testEnv.replays.objects.size).toBe(0);
    });

    it('answers 404 for an unknown project', async () => {
      const res = await post(makeEnv(null), chunkPath());
      expect(res.status).toBe(404);
    });
  });

  describe('dropping with a 204', () => {
    const dropped = async (testEnv: ReturnType<typeof makeEnv>, headers: Record<string, string> = {}) => {
      const res = await post(testEnv, chunkPath(), CHUNK, headers);
      return {
        status: res.status,
        stored: testEnv.replays.objects.size,
        sent: testEnv.replayChunks.sent,
        recordings: (await testEnv.usage.get(WORKSPACE_ID).month('2026-10')).recordings,
      };
    };
    const NOTHING = { status: 204, stored: 0, sent: [], recordings: 0 };

    it('for a paused project', async () => expect(await dropped(makeEnv(projectRecord({ status: 'paused' })))).toEqual(NOTHING));
    it('for a site that is not an allowed domain', async () =>
      expect(await dropped(makeEnv(projectRecord({ allowedDomains: ['example.com'] })), { Origin: 'https://evil.test' })).toEqual(NOTHING));
    it('for a bot', async () => expect(await dropped(makeEnv(), { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).toEqual(NOTHING));
    it('for a filtered address', async () =>
      expect(await dropped(makeEnv(projectRecord({ settings: { ...projectRecord().settings, ipFilters: ['203.0.113.0/24'] } })))).toEqual(NOTHING));
    it('when recordings are off for the project', async () =>
      expect(await dropped(makeEnv(projectRecord({ settings: { ...projectRecord().settings, recordingSampleRate: 0 } })))).toEqual(NOTHING));

    it.each(['replay_blocked', 'events_blocked'])('when the workspace is %s', async (state) => {
      const testEnv = makeEnv();
      testEnv.kv.store.set(quotaKvKey(WORKSPACE_ID), state);
      expect(await dropped(testEnv)).toEqual(NOTHING);
    });

    it('does not drop when the origin is an allowed subdomain', async () => {
      const testEnv = makeEnv(projectRecord({ allowedDomains: ['example.com'] }));
      await post(testEnv, chunkPath(), CHUNK, { Origin: 'https://shop.example.com' });
      expect(testEnv.replays.objects.size).toBe(1);
    });
  });

  describe('when a binding is missing', () => {
    it('answers 204 with one warning when the bucket is not bound', async () => {
      const testEnv = makeEnv();
      delete (testEnv.env as { PANEL_REPLAYS?: unknown }).PANEL_REPLAYS;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect((await post(testEnv, chunkPath())).status).toBe(204);
      expect((await post(testEnv, chunkPath({ q: '1' }))).status).toBe(204);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(testEnv.replayChunks.sent).toEqual([]);
      warn.mockRestore();
    });

    it('still stores the chunk, with one warning, when the index stream is not bound', async () => {
      const testEnv = makeEnv();
      delete (testEnv.env as { PANEL_REPLAY_CHUNKS?: unknown }).PANEL_REPLAY_CHUNKS;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect((await post(testEnv, chunkPath())).status).toBe(204);

      expect(testEnv.replays.objects.size).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('counts nothing when the bucket refuses the chunk', async () => {
      const testEnv = makeEnv();
      vi.mocked(testEnv.replays.put).mockRejectedValue(new Error('r2 down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect((await post(testEnv, chunkPath())).status).toBe(204);

      expect(testEnv.replayChunks.sent).toEqual([]);
      expect((await testEnv.usage.get(WORKSPACE_ID).month('2026-10')).recordings).toBe(0);
      error.mockRestore();
    });
  });

  it('answers 429 over the per-IP limit, before reading anything', async () => {
    const testEnv = makeEnv(projectRecord(), { limits: { replays: 1 } });
    expect((await post(testEnv, chunkPath())).status).toBe(204);

    const res = await post(testEnv, chunkPath({ q: '1' }));

    expect(res.status).toBe(429);
    expect(testEnv.replays.objects.size).toBe(1);
  });

  it('answers a CORS preflight like /e does', async () => {
    const res = await call(makeEnv(), { method: 'OPTIONS', path: '/r', headers: { Origin: 'https://shop.example.com', 'Access-Control-Request-Method': 'POST' } });
    expect(res.status).toBe(204);
  });
});

describe('POST /snap', () => {
  const REQUEST = { pageGroupId: 'pnh_products', urlPattern: '/products/*', deviceClass: 'mobile' };
  const snapPath = (overrides: Record<string, string | undefined> = {}) => {
    const params: Record<string, string | undefined> = { t: TOKEN, g: 'pnh_products', d: 'mobile', ...overrides };
    return `/snap?${Object.entries(params)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')}`;
  };
  const asked = () => {
    const testEnv = makeEnv();
    testEnv.kv.store.set(snapshotRequestKvKey(PROJECT_ID), JSON.stringify(REQUEST));
    return testEnv;
  };

  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('stores the snapshot the project asked for and takes the request down', async () => {
    const testEnv = asked();
    const res = await post(testEnv, snapPath());

    expect(res.status).toBe(204);
    const key = `snapshots/${WORKSPACE_ID}/${PROJECT_ID}/pnh_products/mobile.json.gz`;
    expect([...testEnv.replays.objects.keys()]).toEqual([key]);
    expect(testEnv.replays.objects.get(key)!.bytes).toEqual(CHUNK);
    expect(testEnv.kv.store.has(snapshotRequestKvKey(PROJECT_ID))).toBe(false);
  });

  it('does not count a recording or index a chunk', async () => {
    const testEnv = asked();
    await post(testEnv, snapPath());
    expect(testEnv.replayChunks.sent).toEqual([]);
    expect((await testEnv.usage.get(WORKSPACE_ID).month('2026-10')).recordings).toBe(0);
  });

  it.each([
    ['another page group', { g: 'pnh_other' }],
    ['another device class', { d: 'desktop' }],
  ])('ignores a snapshot of %s than the one asked for', async (_label, overrides) => {
    const testEnv = asked();
    expect((await post(testEnv, snapPath(overrides))).status).toBe(204);

    expect(testEnv.replays.objects.size).toBe(0);
    expect(testEnv.kv.store.has(snapshotRequestKvKey(PROJECT_ID))).toBe(true);
  });

  it('ignores a snapshot nobody asked for, so a public token cannot overwrite a heatmap background', async () => {
    const testEnv = makeEnv();
    expect((await post(testEnv, snapPath())).status).toBe(204);
    expect(testEnv.replays.objects.size).toBe(0);
  });

  it('keeps a request that was replaced while the snapshot was stored', async () => {
    const testEnv = asked();
    const next = JSON.stringify({ ...REQUEST, pageGroupId: 'pnh_next' });
    vi.mocked(testEnv.replays.put).mockImplementation((async () => {
      testEnv.kv.store.set(snapshotRequestKvKey(PROJECT_ID), next);
      return null;
    }) as never);

    await post(testEnv, snapPath());

    expect(testEnv.kv.store.get(snapshotRequestKvKey(PROJECT_ID))).toBe(next);
  });

  it.each([
    ['a bad page group', { g: '../x' }],
    ['a missing page group', { g: undefined }],
    ['a bad device class', { d: 'phone' }],
    ['a missing token', { t: undefined }],
  ])('answers 400 for %s', async (_label, overrides) => {
    const res = await post(asked(), snapPath(overrides));
    expect(res.status).toBe(400);
  });

  it('answers 400 for a body that is not gzip and 413 for one over a MiB', async () => {
    expect((await post(asked(), snapPath(), 'not gzip at all, not gzip at all')).status).toBe(400);
    const big = new Uint8Array(1024 * 1024 + 1);
    big[0] = 0x1f;
    big[1] = 0x8b;
    expect((await post(asked(), snapPath(), big)).status).toBe(413);
  });

  it('drops with a 204 for a paused project, a blocked quota and a foreign origin', async () => {
    const paused = makeEnv(projectRecord({ status: 'paused' }));
    paused.kv.store.set(snapshotRequestKvKey(PROJECT_ID), JSON.stringify(REQUEST));
    const blocked = asked();
    blocked.kv.store.set(quotaKvKey(WORKSPACE_ID), 'replay_blocked');
    const foreign = makeEnv(projectRecord({ allowedDomains: ['example.com'] }));
    foreign.kv.store.set(snapshotRequestKvKey(PROJECT_ID), JSON.stringify(REQUEST));

    for (const [testEnv, headers] of [[paused, {}], [blocked, {}], [foreign, { Origin: 'https://evil.test' }]] as const) {
      expect((await post(testEnv, snapPath(), CHUNK, headers)).status).toBe(204);
      expect(testEnv.replays.objects.size).toBe(0);
    }
  });

  it('answers 429 over its own per-IP limit', async () => {
    const testEnv = makeEnv(projectRecord(), { limits: { snapshots: 0 } });
    expect((await post(testEnv, snapPath())).status).toBe(429);
  });

  it('is off, with a 204, when the bucket is not bound', async () => {
    const testEnv = asked();
    delete (testEnv.env as { PANEL_REPLAYS?: unknown }).PANEL_REPLAYS;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post(testEnv, snapPath())).status).toBe(204);
    warn.mockRestore();
  });
});
