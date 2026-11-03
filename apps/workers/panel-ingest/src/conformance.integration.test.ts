/**
 * The collector's routes through the test harness, so conformance mode
 * (`CONFORMANCE_TARGET=rust`) runs each request on the Rust backend too and
 * compares the answers and what each wrote: the rows sent to the events
 * stream, the day's count on PanelUsage and the install-check stamp in KV.
 *
 * The bindings are in-memory stand-ins that conformance mode serves to the
 * Rust server (the KV, ledger and pipeline bridges of worker-kit). The salt
 * object is shared by the whole file, as one global Durable Object is, so
 * both backends hash with the same salt; every test uses its own project, so
 * the five-minute "seen" throttle of one test never meets another's.
 *
 * Rust serves the collector at /public/panel (`rustBasePath`); the worker and
 * these tests keep its own paths.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { projectKvKey, seenKvKey, type PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { MAX_BATCH_BYTES, type EventBatch, type WireEvent } from '@weldsuite/panel-domain/wire';
import { buildBatches } from '../../../../packages/sdk/panel-sdk/src/batch';
import { PanelSalt } from './durable-objects/panel-salt';
import { PanelUsage } from './durable-objects/panel-usage';
import { app } from './index';
import stubBundle from './testing/sdk-bundle-stub';
import { CHROME_WINDOWS } from './testing/fakes';

// Conformance mode runs every write on both backends.
vi.setConfig({ testTimeout: 60_000 });

const RUST_BASE = '/public/panel';
const WORKSPACE = 'ws_conformance';
const CLIENT_IP = '203.0.113.7';
const PAGE = 'https://shop.example.com/pricing?plan=pro&utm_source=newsletter';

let tenantDb: Database;
let sdkFile: string;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-sdk-'));
  sdkFile = path.join(dir, 'panel.global.js');
  writeFileSync(sdkFile, stubBundle);
}, 120_000);

// ---------------------------------------------------------------------------
// Bindings that conformance mode can share with the Rust server
// ---------------------------------------------------------------------------

/** Durable Object storage over `data`, the slice the objects use. */
function storageOver(data: Map<string, unknown>) {
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (keys: string | string[]) => {
      let removed = 0;
      for (const key of Array.isArray(keys) ? keys : [keys]) if (data.delete(key)) removed += 1;
      return removed;
    },
    list: async (options: { prefix?: string } = {}) =>
      new Map([...data].filter(([key]) => !options.prefix || key.startsWith(options.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
  return { storage } as unknown as DurableObjectState;
}

/** One global salt object for the file (`PANEL_SALT.idFromName('global')`). No fork: both runs share it. */
const SALT = new PanelSalt(storageOver(new Map()), {});
const saltNamespace = { idFromName: (name: string) => name, get: () => SALT };

/** `PANEL_USAGE`; `fork()` gives the TypeScript run of a write a copy. */
function usageNamespace(state = new Map<string, Map<string, unknown>>()) {
  const instances = new Map<string, PanelUsage>();
  return {
    state,
    idFromName: (name: string) => name,
    get(name: string) {
      let instance = instances.get(name);
      if (!instance) {
        const data = state.get(name) ?? new Map<string, unknown>();
        state.set(name, data);
        instance = new PanelUsage(storageOver(data), {});
        instances.set(name, instance);
      }
      return instance;
    },
    fork: () => usageNamespace(new Map([...state].map(([name, data]) => [name, new Map(data)]))),
  };
}

/** `PANEL_EVENTS`, failing on purpose when `fail`. */
function eventStream(sent: Record<string, unknown>[] = [], fail = false) {
  return {
    sent,
    send: async (records: Record<string, unknown>[]) => {
      if (fail) throw new Error('stream unavailable');
      sent.push(...records);
    },
    fork: () => eventStream([...sent], fail),
  };
}

/** `WORKSPACE_CACHE`. */
function memoryKv(entries = new Map<string, string>()) {
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
    fork: () => memoryKv(new Map(entries)),
  };
}

let projects = 0;

interface Setup {
  token: string;
  projectId: string;
  kv: ReturnType<typeof memoryKv>;
  stream: ReturnType<typeof eventStream>;
  usage: ReturnType<typeof usageNamespace>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

/** A project of its own (`wpk_` + a fresh number), registered unless `record` is null. */
function setup(record: Partial<PanelProjectRecord> | null = {}, options: { failingStream?: boolean } = {}): Setup {
  projects += 1;
  const token = `wpk_${projects.toString(16).padStart(32, '0')}`;
  const projectId = `pnp_conformance_${projects}`;
  const kv = memoryKv();
  if (record) {
    kv.entries.set(
      projectKvKey(token),
      JSON.stringify({
        v: 1,
        projectId,
        workspaceId: WORKSPACE,
        status: 'active',
        allowedDomains: [],
        settings: { ...DEFAULT_PANEL_SETTINGS },
        ...record,
      }),
    );
  }
  const stream = eventStream([], options.failingStream);
  const usage = usageNamespace();
  const testApp = createTestApp('/', app as never, {
    context: { tenantDb },
    env: {
      ENVIRONMENT: 'test',
      WORKSPACE_CACHE: kv as unknown as KVNamespace,
      PANEL_EVENTS: stream,
      PANEL_SALT: saltNamespace,
      PANEL_USAGE: usage,
      PANEL_SDK_FILE: sdkFile,
    } as never,
    rustBasePath: RUST_BASE,
  });
  // The rows are written after the 204, as `waitUntil` work: wait for it.
  const request = async (p: string, init?: RequestInit) => {
    const res = await testApp.request(p, init);
    await testApp.settled();
    return res;
  };
  return { token, projectId, kv, stream, usage, request };
}

function event(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    event_id: 'evt-00000001',
    name: '$pageview',
    ts: new Date(Date.now() - 2000).toISOString(),
    url: 'https://shop.example.com/products?utm_source=news',
    ...overrides,
  };
}

function batch(token: string, overrides: Partial<EventBatch> = {}): EventBatch {
  return {
    token,
    sent_at: new Date().toISOString(),
    lib: 'web',
    lib_version: '0.1.0',
    consent: false,
    events: [event()],
    ...overrides,
  };
}

/** A beacon's `POST /e`, from the client's address as the edge forwards it. */
function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'User-Agent': CHROME_WINDOWS,
      'CF-Connecting-IP': CLIENT_IP,
      'X-Forwarded-For': CLIENT_IP,
      Origin: 'https://shop.example.com',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const month = () => new Date().toISOString().slice(0, 7);

// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('names the service and environment', async () => {
    const res = await setup().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'panel-ingest', environment: 'test' });
  });
});

describe('GET /s.js', () => {
  it('serves the bundle, then 304 for a matching validator, a weak one, a list or *', async () => {
    const { request } = setup();
    const res = await request('/s.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe(stubBundle);
    const etag = res.headers.get('ETag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const again = await request('/s.js', { headers: { 'If-None-Match': header } });
      expect(again.status, header).toBe(304);
      expect(again.headers.get('ETag')).toBe(etag);
    }
    expect((await request('/s.js', { headers: { 'If-None-Match': '"stale"' } })).status).toBe(200);
  });
});

describe('GET /c/:token', () => {
  it("answers the project's collection settings, defaults filled in", async () => {
    const { request, token } = setup({ settings: { autocapture: false, excludedUrls: ['/admin/*'] } as never });
    const res = await request(`/c/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual({
      autocapture: false,
      consentMode: 'required',
      maskingLevel: 'balanced',
      excludedUrls: ['/admin/*'],
    });
  });

  it('is a 404 for an unknown, malformed or unversioned token', async () => {
    const { request, token, kv } = setup(null);
    const unknown = await request(`/c/${token}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('Cache-Control')).toBe('no-store');
    expect(await errorOf(unknown)).toEqual({ code: 'unknown_project', message: 'Unknown project token' });

    expect((await request('/c/not-a-token')).status).toBe(404);
    kv.entries.set(projectKvKey(token), JSON.stringify({ v: 2, projectId: 'p', workspaceId: 'w' }));
    expect((await request(`/c/${token}`)).status).toBe(404);
  });
});

describe('CORS', () => {
  it('answers a preflight for any site', async () => {
    const res = await setup().request('/e', {
      method: 'OPTIONS',
      headers: { Origin: 'https://shop.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
  });
});

describe('POST /e', () => {
  it('writes one row per event, counts them and stamps the install check', async () => {
    const { request, token, projectId, stream, usage, kv } = setup();
    const res = await request(
      '/e',
      post(
        batch(token, {
          events: [
            event({ event_id: 'evt-aaaaaaaa', title: 'Shoes', referrer: 'https://www.google.com/?q=shoes', viewport_w: 1280 }),
            event({ event_id: 'evt-bbbbbbbb', name: '$pageleave', scroll_depth: 40 }),
            event({
              event_id: 'evt-cccccccc',
              name: '$autocapture',
              x: 10,
              y: 20,
              el: { tag: 'button', selector: 'main > button.buy', text: 'Buy', action: 'click' },
            }),
          ],
        }),
      ),
    );
    expect(res.status).toBe(204);

    expect(stream.sent.map((row) => [row.event_id, row.name])).toEqual([
      ['evt-aaaaaaaa', '$pageview'],
      ['evt-bbbbbbbb', '$pageleave'],
      ['evt-cccccccc', '$autocapture'],
    ]);
    expect(stream.sent[0]).toMatchObject({
      project_id: projectId,
      workspace_id: WORKSPACE,
      cookieless: true,
      session_id: null,
      host: 'shop.example.com',
      path: '/products',
      utm_source: 'news',
      title: 'Shoes',
      referrer_host: 'www.google.com',
      browser: 'Chrome',
      os: 'Windows',
      device_type: 'desktop',
      viewport_w: 1280,
      properties: '{}',
    });
    expect(String(stream.sent[0]!.anon_id)).toMatch(/^ck_[0-9a-f]{24}$/);
    expect(stream.sent[2]).toMatchObject({ el_selector: 'main > button.buy', el_text: 'Buy', x: 10, y: 20, properties: '{"$action":"click"}' });

    expect((await usage.get(WORKSPACE).month(month())).events).toBe(3);
    expect(kv.entries.get(seenKvKey(projectId))).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the browser ids only with consent, and drops events it cannot read or must not keep', async () => {
    const { request, token, stream } = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, excludedUrls: ['/admin/*'] } });
    const res = await request(
      '/e',
      post(
        batch(token, {
          consent: true,
          events: [
            event({ event_id: 'evt-aaaaaaaa', anon_id: 'a-browser-id', session_id: 's-browser-id', props: { plan: 'pro', seats: 3, coupon: null } }),
            { ...event({ event_id: 'evt-bbbbbbbb' }), url: 'not a url' },
            event({ event_id: 'evt-cccccccc', url: 'https://shop.example.com/admin/users', anon_id: 'a-browser-id' }),
            event({ event_id: 'evt-dddddddd', url: 'ftp://shop.example.com/x', anon_id: 'a-browser-id' }),
            event({ event_id: 'evt-eeeeeeee', anon_id: 'ck_forged' }),
          ],
        }),
      ),
    );
    expect(res.status).toBe(204);
    expect(stream.sent.map((row) => row.event_id)).toEqual(['evt-aaaaaaaa', 'evt-eeeeeeee']);
    expect(stream.sent[0]).toMatchObject({
      anon_id: 'a-browser-id',
      session_id: 's-browser-id',
      cookieless: false,
      properties: '{"plan":"pro","seats":3,"coupon":null}',
    });
    expect(stream.sent[1]).toMatchObject({ cookieless: true });
  });

  it('accepts what the SDK sends, with and without consent', async () => {
    const { request, token, stream } = setup();
    const events = [
      { name: '$pageview', url: PAGE, title: 'Pricing', referrer: 'https://www.google.com/', viewport_w: 1280 },
      { name: '$autocapture', url: PAGE, x: 412, y: 980, el: { tag: 'button', selector: 'main > button.buy', text: 'Buy now', action: 'click' as const } },
      { name: '$pageleave', url: PAGE, scroll_depth: 63 },
      { name: 'Signed up', url: PAGE, props: { plan: 'pro', seats: 3, annual: false, coupon: null } },
    ];
    for (const consent of [false, true]) {
      const withIds = events.map((e) => (consent ? { ...e, anon_id: 'a-browser-id', session_id: 's-browser-id' } : e));
      for (const sdkBatch of buildBatches({ token, consent, events: withIds, sentAt: Date.now() })) {
        expect((await request('/e', post(sdkBatch))).status).toBe(204);
      }
    }
    expect(stream.sent.map((row) => [row.name, row.cookieless])).toEqual([
      ['$pageview', true],
      ['$autocapture', true],
      ['$pageleave', true],
      ['Signed up', true],
      ['$pageview', false],
      ['$autocapture', false],
      ['$pageleave', false],
      ['Signed up', false],
    ]);
    expect(stream.sent[3]!.properties).toBe('{"plan":"pro","seats":3,"annual":false,"coupon":null}');
  });

  it('accepts the batch but writes and counts nothing for a paused project, a bot or a filtered address', async () => {
    const paused = setup({ status: 'paused' });
    expect((await paused.request('/e', post(batch(paused.token)))).status).toBe(204);
    const bot = setup();
    expect((await bot.request('/e', post(batch(bot.token), { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }))).status).toBe(204);
    const filtered = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, ipFilters: ['203.0.113.0/24'] } });
    expect((await filtered.request('/e', post(batch(filtered.token)))).status).toBe(204);

    for (const { stream, usage } of [paused, bot, filtered]) {
      expect(stream.sent).toEqual([]);
      expect((await usage.get(WORKSPACE).month(month())).events).toBe(0);
    }
  });

  it('counts nothing when the stream refuses the rows', async () => {
    const { request, token, usage, kv, projectId } = setup({}, { failingStream: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request('/e', post(batch(token)))).status).toBe(204);
    expect((await usage.get(WORKSPACE).month(month())).events).toBe(0);
    expect(kv.entries.has(seenKvKey(projectId))).toBe(false);
    consoleError.mockRestore();
  });

  it('refuses a site that is not an allowed domain, and accepts a subdomain of one', async () => {
    const { request, token, stream } = setup({ allowedDomains: ['example.com'] });
    const refused = await request('/e', post(batch(token), { Origin: 'https://evil.test' }));
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toEqual({ code: 'origin_not_allowed', message: 'This site is not an allowed domain of the project' });
    expect((await request('/e', post(batch(token)))).status).toBe(204);
    expect(stream.sent).toHaveLength(1);
  });

  it('refuses what it cannot read', async () => {
    const { request, token } = setup();
    const cases: Array<[RequestInit, number, string, string]> = [
      [post(batch(token), { 'Content-Type': 'application/xml' }), 415, 'unsupported_media_type', 'Send the batch as text/plain or application/json'],
      [post('x'.repeat(MAX_BATCH_BYTES + 1)), 413, 'payload_too_large', `A batch is at most ${MAX_BATCH_BYTES} bytes`],
      [post('{not json'), 400, 'invalid_body', 'The body is not valid JSON'],
      [post({ ...batch(token), token: 42 }), 400, 'invalid_batch', 'token: Expected string, received number'],
      [post({ ...batch(token), lib: 'ios' }), 400, 'invalid_batch', "lib: Invalid enum value. Expected 'web' | 'server', received 'ios'"],
      [post({ ...batch(token), events: [] }), 400, 'invalid_batch', 'events: Array must contain at least 1 element(s)'],
      [post([1, 2]), 400, 'invalid_batch', 'Expected object, received array'],
      [post(batch(token, { events: [{ ...event(), url: 'not a url' }] })), 400, 'invalid_batch', 'events.0.url: Invalid url'],
      [post(batch(token, { events: [{ ...event(), name: 'bad name!' }] })), 400, 'invalid_batch', 'events.0.name: Invalid'],
      [post(batch(token, { events: [{ ...event(), event_id: 'short' }] })), 400, 'invalid_batch', 'events.0.event_id: String must contain at least 8 character(s)'],
      [post(batch(token, { events: [{ ...event(), x: 1.5 }] })), 400, 'invalid_batch', 'events.0.x: Expected integer, received float'],
      [post(batch(token, { events: [{ ...event(), props: { 'bad-key': 1 } }] })), 400, 'invalid_batch', 'events.0.props.bad-key: Invalid'],
      [post(batch(`wpk_${'f'.repeat(32)}`)), 404, 'unknown_project', 'Unknown project token'],
    ];
    for (const [init, status, code, message] of cases) {
      const res = await request('/e', init);
      expect(res.status, message).toBe(status);
      expect(await errorOf(res)).toEqual({ code, message });
    }
  });
});
