/**
 * The collector's routes through the test harness, so conformance mode
 * (`CONFORMANCE_TARGET=rust`) runs each request on the Rust backend too and
 * compares the answers and what each wrote: the rows sent to the events and
 * recording chunk streams, the day's counts on PanelUsage, the objects in
 * the replays bucket and the install-check stamp in KV.
 *
 * The bindings are in-memory stand-ins that conformance mode serves to the
 * Rust server (the KV, bucket, ledger, pipeline and rate-limit bridges of
 * worker-kit). The salt object is shared by the whole file, as one global
 * Durable Object is, so both backends hash with the same salt; every test
 * uses its own project, so the five-minute "seen" throttle of one test never
 * meets another's, and a workspace of its own wherever it sets a quota state
 * (the worker remembers one for a minute).
 *
 * `PANEL_PROJECT` (people, identities, groups, the live view) is not bound:
 * the Rust collector has no PanelProject object yet, so these tests check the
 * worker as it runs without that binding.
 *
 * Rust serves the collector at /public/panel (`rustBasePath`); the worker and
 * these tests keep its own paths.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  keyKvKey,
  projectKvKey,
  quotaKvKey,
  seenKvKey,
  snapshotRequestKvKey,
  type PanelProjectRecord,
} from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { MAX_BATCH_BYTES, type EventBatch, type WireEvent } from '@weldsuite/panel-domain/wire';
import { buildBatches } from '../../../../packages/sdk/panel-sdk/src/batch';
import { PanelSalt } from './durable-objects/panel-salt';
import { PanelUsage } from './durable-objects/panel-usage';
import type { Env } from './env';
import { app } from './index';
import recorderBundle from './testing/recorder-bundle-stub';
import stubBundle from './testing/sdk-bundle-stub';
import vitalsBundle from './testing/vitals-bundle-stub';
import { CHROME_WINDOWS } from './testing/fakes';

// Conformance mode runs every write on both backends.
vi.setConfig({ testTimeout: 60_000 });

const RUST_BASE = '/public/panel';
const WORKSPACE = 'ws_conformance';
const CLIENT_IP = '203.0.113.7';
const PAGE = 'https://shop.example.com/pricing?plan=pro&utm_source=newsletter';
const DAY_MS = 24 * 60 * 60 * 1000;

let tenantDb: Database;
let bundleFiles: Record<string, string>;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-sdk-'));
  const write = (name: string, text: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  bundleFiles = {
    PANEL_SDK_FILE: write('panel.global.js', stubBundle),
    PANEL_RECORDER_FILE: write('panel-recorder.global.js', recorderBundle),
    PANEL_VITALS_FILE: write('panel-vitals.global.js', vitalsBundle),
  };
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
        instance = new PanelUsage(storageOver(data), {} as Env);
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

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

/** `PANEL_REPLAYS`: an R2 bucket of objects by key. */
function memoryBucket(objects = new Map<string, StoredObject>()) {
  return {
    objects,
    get: async (key: string) => {
      const object = objects.get(key);
      return object ? { body: object.bytes, size: object.bytes.byteLength, httpMetadata: { contentType: object.contentType } } : null;
    },
    put: async (key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
      return { key };
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

/** A Workers rate limiter that lets `allowed` calls per key through, then refuses; `fork()` for the TypeScript run. */
function rateLimit(allowed: number, calls = new Map<string, number>()) {
  return {
    calls,
    limit: async ({ key }: { key: string }) => {
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      return { success: n <= allowed };
    },
    fork: () => rateLimit(allowed, new Map(calls)),
  };
}

let projects = 0;

interface Limits {
  events?: number;
  proxy?: number;
  replays?: number;
  snapshots?: number;
}

interface SetupOptions {
  failingStream?: boolean;
  /** Bind `PANEL_REPLAYS` (default) or leave it out. */
  replays?: boolean;
  /** Bind `PANEL_REPLAY_CHUNKS` (default) or leave it out. */
  chunks?: boolean;
  limits?: Limits;
}

interface Setup {
  token: string;
  projectId: string;
  workspaceId: string;
  kv: ReturnType<typeof memoryKv>;
  stream: ReturnType<typeof eventStream>;
  chunks: ReturnType<typeof eventStream>;
  replays: ReturnType<typeof memoryBucket>;
  usage: ReturnType<typeof usageNamespace>;
  limiters: Record<string, ReturnType<typeof rateLimit>>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * A project of its own (`wpk_` + a fresh number), registered unless `record`
 * is null, in `WORKSPACE` unless the record names another.
 */
function setup(record: Partial<PanelProjectRecord> | null = {}, options: SetupOptions = {}): Setup {
  projects += 1;
  const token = `wpk_${projects.toString(16).padStart(32, '0')}`;
  const projectId = `pnp_conformance_${projects}`;
  const workspaceId = record?.workspaceId ?? WORKSPACE;
  const kv = memoryKv();
  if (record) {
    kv.entries.set(
      projectKvKey(token),
      JSON.stringify({
        v: 1,
        projectId,
        workspaceId,
        status: 'active',
        allowedDomains: [],
        settings: { ...DEFAULT_PANEL_SETTINGS },
        ...record,
      }),
    );
  }
  const stream = eventStream([], options.failingStream);
  const chunks = eventStream();
  const replays = memoryBucket();
  const usage = usageNamespace();
  const { limits = {} } = options;
  const limiters: Record<string, ReturnType<typeof rateLimit>> = {};
  if (limits.events !== undefined) limiters.EVENTS_RATE_LIMIT = rateLimit(limits.events);
  if (limits.proxy !== undefined) limiters.EVENTS_PROXY_RATE_LIMIT = rateLimit(limits.proxy);
  if (limits.replays !== undefined) limiters.REPLAYS_RATE_LIMIT = rateLimit(limits.replays);
  if (limits.snapshots !== undefined) limiters.SNAPSHOTS_RATE_LIMIT = rateLimit(limits.snapshots);
  const testApp = createTestApp('/', app as never, {
    context: { tenantDb },
    env: {
      ENVIRONMENT: 'test',
      WORKSPACE_CACHE: kv as unknown as KVNamespace,
      PANEL_EVENTS: stream,
      PANEL_SALT: saltNamespace,
      PANEL_USAGE: usage,
      ...(options.replays === false ? {} : { PANEL_REPLAYS: replays }),
      ...(options.chunks === false ? {} : { PANEL_REPLAY_CHUNKS: chunks }),
      ...limiters,
      ...bundleFiles,
    } as never,
    rustBasePath: RUST_BASE,
  });
  // The rows are written after the 204, as `waitUntil` work: wait for it.
  const request = async (p: string, init?: RequestInit) => {
    const res = await testApp.request(p, init);
    await testApp.settled();
    return res;
  };
  return { token, projectId, workspaceId, kv, stream, chunks, replays, usage, limiters, request };
}

let workspaces = 0;

/** A workspace of its own, for a test that sets its quota state. */
function freshWorkspace(): string {
  workspaces += 1;
  return `ws_conformance_quota_${workspaces}`;
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
      recordingSampleRate: 1,
      recordingBlocked: false,
      snapshot: null,
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

  it('writes the user id, click position and error message, with consent only, and accepts people operations', async () => {
    const { request, token, stream } = setup();
    const people = [{ op: 'set', user_id: 'user-1', ts: new Date().toISOString(), props: { $email: 'a@b.com', plan: 'pro' } }];
    const events = [
      event({ event_id: 'evt-aaaaaaaa', name: '$identify', anon_id: 'a-browser', user_id: 'user-1' }),
      event({
        event_id: 'evt-bbbbbbbb',
        name: '$rageclick',
        anon_id: 'a-browser',
        user_id: 'user-1',
        x: 10,
        y: 20,
        rel_x: 0.25,
        rel_y: 1,
        el: { tag: 'button', selector: 'main > button', action: 'click' },
      }),
      event({ event_id: 'evt-cccccccc', name: '$exception', anon_id: 'a-browser', error_message: 'x is not a function', props: { $source: 'app.js', $line: 12, $col: 3 } }),
      event({ event_id: 'evt-dddddddd', name: '$quickback', anon_id: 'a-browser', props: { $from: '/pricing' } }),
    ];
    expect((await request('/e', post({ ...batch(token, { consent: true, events }), people }))).status).toBe(204);
    expect((await request('/e', post({ ...batch(token, { consent: false, events: [{ ...events[1]!, event_id: 'evt-eeeeeeee' }] }), people }))).status).toBe(204);

    expect(stream.sent.map((row) => [row.event_id, row.user_id, row.distinct_id])).toEqual([
      ['evt-aaaaaaaa', 'user-1', 'user-1'],
      ['evt-bbbbbbbb', 'user-1', 'user-1'],
      ['evt-cccccccc', null, 'a-browser'],
      ['evt-dddddddd', null, 'a-browser'],
      ['evt-eeeeeeee', null, expect.stringMatching(/^ck_/)],
    ]);
    expect(stream.sent[1]).toMatchObject({ rel_x: 0.25, rel_y: 1, x: 10, y: 20, error_message: null });
    expect(stream.sent[2]).toMatchObject({ error_message: 'x is not a function', properties: '{"$source":"app.js","$line":12,"$col":3}' });
    expect(stream.sent[3]!.properties).toBe('{"$from":"/pricing"}');
  });

  it('refuses a bad user id, click position or reserved property, and too many people or group operations', async () => {
    const { request, token } = setup();
    const op = { op: 'set', user_id: 'u', ts: new Date().toISOString(), props: {} };
    const groupOp = { op: 'set', type: 'company', key: 'acme', props: {} };
    const cases: Array<[unknown, string]> = [
      [batch(token, { events: [{ ...event(), user_id: 'a\nb' }] }), 'events.0.user_id: Invalid'],
      [batch(token, { events: [{ ...event(), user_id: '' }] }), 'events.0.user_id: Invalid'],
      [batch(token, { events: [{ ...event(), rel_x: 1.5 }] }), 'events.0.rel_x: Number must be less than or equal to 1'],
      [batch(token, { events: [{ ...event(), error_message: 'e'.repeat(1001) }] }), 'events.0.error_message: String must contain at most 1000 character(s)'],
      [batch(token, { events: [{ ...event(), props: { $action: 'click' } }] }), 'events.0.props.$action: Invalid'],
      [batch(token, { events: [{ ...event(), props: { $group_Company: 'acme' } }] }), 'events.0.props.$group_Company: Invalid'],
      [batch(token, { events: [{ ...event(), props: { $initial_utm: 'x' } }] }), 'events.0.props.$initial_utm: Invalid'],
      [batch(token, { events: [{ ...event(), name: '$app_crashed' }] }), 'events.0.name: Invalid'],
      [{ ...batch(token), people: Array.from({ length: 51 }, () => op) }, 'people: Array must contain at most 50 element(s)'],
      [{ ...batch(token), groups: Array.from({ length: 51 }, () => groupOp) }, 'groups: Array must contain at most 50 element(s)'],
    ];
    for (const [body, message] of cases) {
      const res = await request('/e', post(body));
      expect(res.status, message).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'invalid_batch', message });
    }
  });

  it('drops events with 204 when the workspace is events_blocked, and says recordings are blocked on /c', async () => {
    const workspaceId = 'ws_conformance_quota';
    const { request, token, stream, usage, kv } = setup({ workspaceId });
    kv.entries.set(quotaKvKey(workspaceId), 'events_blocked');

    expect((await request('/e', post(batch(token)))).status).toBe(204);
    expect(stream.sent).toEqual([]);
    expect((await usage.get(workspaceId).month(month())).events).toBe(0);
    expect(await (await request(`/c/${token}`)).json()).toMatchObject({ recordingBlocked: true, recordingSampleRate: 1, snapshot: null });
  });

  it('keeps counting when only recordings are blocked', async () => {
    const workspaceId = 'ws_conformance_replay_blocked';
    const { request, token, stream, kv } = setup({ workspaceId });
    kv.entries.set(quotaKvKey(workspaceId), 'replay_blocked');

    expect((await request('/e', post(batch(token)))).status).toBe(204);
    expect(stream.sent).toHaveLength(1);
    expect(await (await request(`/c/${token}`)).json()).toMatchObject({ recordingBlocked: true });
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

  it("takes a mobile event's app, screen and device from its properties, not the URL or user agent", async () => {
    const { request, token, stream } = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, excludedUrls: ['/Settings*'] } });
    const url = 'app://com.acme.shop/Product Detail';
    const props = { $app_id: 'com.acme.shop', $os: 'ios', $device_type: 'tablet', $app_version: '2.1.0' };
    const res = await request(
      '/e',
      post(
        batch(token, {
          lib: 'mobile',
          lib_version: '0.3.0',
          events: [
            event({
              event_id: 'evt-aaaaaaaa',
              name: '$screen',
              url,
              title: 'Not the screen',
              referrer: 'https://www.google.com/?q=shoes',
              viewport_w: 820,
              props: { ...props, $screen_name: ' Product  Detail ' },
            }),
            event({ event_id: 'evt-bbbbbbbb', name: '$app_opened', url, props }),
            event({ event_id: 'evt-cccccccc', name: '$screen', url, props: { ...props, $screen_name: 'Settings Privacy' } }),
            event({
              event_id: 'evt-dddddddd',
              name: 'Added to cart',
              url,
              title: 'Cart',
              props: { $app_id: '.not-an-id', $os: 'Android', $device_type: 'phone', $screen_name: '   ' },
            }),
          ],
        }),
      ),
    );
    expect(res.status).toBe(204);

    expect(stream.sent.map((row) => row.event_id)).toEqual(['evt-aaaaaaaa', 'evt-bbbbbbbb', 'evt-dddddddd']);
    const placeless = { browser: null, referrer: null, referrer_host: null, utm_source: null, utm_medium: null, lib: 'mobile', lib_version: '0.3.0' };
    expect(stream.sent[0]).toMatchObject({
      ...placeless,
      host: 'com.acme.shop',
      path: '/Product-Detail',
      url: 'app://com.acme.shop/Product-Detail',
      title: 'Product  Detail',
      os: 'iOS',
      device_type: 'tablet',
      viewport_w: 820,
      properties: JSON.stringify({ ...props, $screen_name: ' Product  Detail ' }),
    });
    expect(stream.sent[1]).toMatchObject({
      ...placeless,
      host: 'com.acme.shop',
      path: '/',
      url: 'app://com.acme.shop/',
      title: null,
      os: 'iOS',
      device_type: 'tablet',
    });
    expect(stream.sent[2]).toMatchObject({ ...placeless, host: '', path: '/', url: '', title: 'Cart', os: 'Android', device_type: null });
  });

  it('accepts group operations and stores first-touch, group and web vitals properties as sent', async () => {
    const { request, token, stream } = setup();
    const groups = [
      { op: 'set', type: 'company', key: 'acme', props: { $name: 'Acme', plan: 'pro' } },
      { op: 'set_once', type: 'company', key: 'acme', props: { $created: '2026-01-01' } },
      { op: 'unset', type: 'company', key: 'acme', keys: ['legacy'] },
      // Not understood: costs only itself.
      { op: 'set', type: 'Bad Type', key: 'acme', props: {} },
      { op: 'delete', type: 'company', key: 'acme' },
    ];
    const firstTouch = {
      $group_company: 'acme',
      $initial_referrer: 'https://www.google.com/',
      $initial_referring_domain: 'www.google.com',
      $initial_utm_source: 'newsletter',
      $initial_landing_path: '/pricing',
    };
    const vitals = { $lcp: 1830, $inp: 96, $fcp: 640, $ttfb: 120, $cls: 0.04, $lcp_el: 'main > img.hero', $nav_type: 'navigate' };
    const events = [
      event({ event_id: 'evt-aaaaaaaa', props: firstTouch }),
      event({ event_id: 'evt-bbbbbbbb', name: '$webvitals', props: { ...vitals, $group_company: 'acme' } }),
    ];
    for (const consent of [false, true]) {
      const body = { ...batch(token, { consent, events: events.map((e) => ({ ...e, event_id: `${e.event_id}-${consent}` })) }), groups };
      expect((await request('/e', post(body))).status).toBe(204);
    }

    expect(stream.sent.map((row) => [row.event_id, row.name, row.properties])).toEqual([
      ['evt-aaaaaaaa-false', '$pageview', JSON.stringify(firstTouch)],
      ['evt-bbbbbbbb-false', '$webvitals', JSON.stringify({ ...vitals, $group_company: 'acme' })],
      ['evt-aaaaaaaa-true', '$pageview', JSON.stringify(firstTouch)],
      ['evt-bbbbbbbb-true', '$webvitals', JSON.stringify({ ...vitals, $group_company: 'acme' })],
    ]);
  });

  it("takes the visitor's address from the first forwarded hop, and the geo from a proxy's headers", async () => {
    const { request, token, stream } = setup();
    const forwarded = { 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' };
    const cases: Array<[string, Record<string, string>, { country: string | null; region: string | null; city: string | null }]> = [
      [
        'evt-aaaaaaaa',
        { ...forwarded, 'X-WeldPanel-Country': 'de', 'X-WeldPanel-Region': 'Berlin', 'X-WeldPanel-City': 'Berlin%20Mitte' },
        { country: 'DE', region: 'Berlin', city: 'Berlin Mitte' },
      ],
      [
        'evt-bbbbbbbb',
        { ...forwarded, 'x-vercel-ip-country': 'br', 'x-vercel-ip-country-region': 'SP', 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' },
        { country: 'BR', region: 'SP', city: 'São Paulo' },
      ],
      // The first-party family wins whenever it names a country, even an unknown one.
      [
        'evt-cccccccc',
        { ...forwarded, 'X-WeldPanel-Country': 'XX', 'X-WeldPanel-City': '100%', 'x-vercel-ip-country': 'NL', 'x-vercel-ip-city': 'Amsterdam' },
        { country: null, region: null, city: '100%' },
      ],
      ['evt-dddddddd', { 'X-WeldPanel-Country': '  ', 'x-vercel-ip-country': 'Netherlands' }, { country: null, region: null, city: null }],
      ['evt-eeeeeeee', {}, { country: null, region: null, city: null }],
    ];
    for (const [eventId, headers] of cases) {
      expect((await request('/e', post(batch(token, { events: [event({ event_id: eventId })] }), headers))).status).toBe(204);
    }

    expect(stream.sent.map((row) => [row.event_id, { country: row.country, region: row.region, city: row.city }])).toEqual(
      cases.map(([eventId, , geo]) => [eventId, geo]),
    );
    // The cookieless hash reads the first hop: the same visitor through the proxy, another one without it.
    const [viaProxy, , , direct] = stream.sent.map((row) => row.anon_id);
    expect(stream.sent[1]!.anon_id).toBe(viaProxy);
    expect(direct).not.toBe(viaProxy);
  });

  it("drops a batch whose first forwarded hop is filtered, whatever the hops after it", async () => {
    const { request, token, stream } = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, ipFilters: ['198.51.100.0/24'] } });
    const filtered = await request('/e', post(batch(token), { 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' }));
    expect(filtered.status).toBe(204);
    expect(stream.sent).toEqual([]);

    const kept = await request('/e', post(batch(token), { 'X-Forwarded-For': '203.0.113.7, 198.51.100.9' }));
    expect(kept.status).toBe(204);
    expect(stream.sent).toHaveLength(1);
  });

  it('refuses what it cannot read', async () => {
    const { request, token } = setup();
    const cases: Array<[RequestInit, number, string, string]> = [
      [post(batch(token), { 'Content-Type': 'application/xml' }), 415, 'unsupported_media_type', 'Send the batch as text/plain or application/json'],
      [post('x'.repeat(MAX_BATCH_BYTES + 1)), 413, 'payload_too_large', `A batch is at most ${MAX_BATCH_BYTES} bytes`],
      [post('{not json'), 400, 'invalid_body', 'The body is not valid JSON'],
      [post({ ...batch(token), token: 42 }), 400, 'invalid_batch', 'token: Expected string, received number'],
      [post({ ...batch(token), lib: 'ios' }), 400, 'invalid_batch', "lib: Invalid enum value. Expected 'web' | 'server' | 'mobile', received 'ios'"],
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

// ---------------------------------------------------------------------------
// The plugins, the client config's recording settings, recordings, heatmap
// snapshots, the server API and the per-IP limits
// ---------------------------------------------------------------------------

describe('GET /rec.js and /v.js', () => {
  it('serve the recording and web vitals plugins like /s.js, each with its own validator', async () => {
    const { request } = setup();
    const etags: string[] = [];
    for (const [file, text] of [
      ['/rec.js', recorderBundle],
      ['/v.js', vitalsBundle],
    ] as const) {
      const res = await request(file);
      expect(res.status, file).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/javascript');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(await res.text()).toBe(text);
      const etag = res.headers.get('ETag')!;
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      etags.push(etag);

      const again = await request(file, { headers: { 'If-None-Match': `W/${etag}` } });
      expect(again.status, file).toBe(304);
      expect((await request(file, { headers: { 'If-None-Match': '"stale"' } })).status).toBe(200);
    }
    const core = (await request('/s.js')).headers.get('ETag');
    expect(new Set([...etags, core]).size).toBe(3);
  });
});

describe('GET /c/:token: recordings and snapshots', () => {
  const config = async (s: Setup) => (await (await s.request(`/c/${s.token}`)).json()) as Record<string, unknown>;

  it('gives the sample rate from the settings, kept between 0 and 1', async () => {
    const quarter = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, recordingSampleRate: 0.25 } });
    expect(await config(quarter)).toMatchObject({ recordingSampleRate: 0.25, recordingBlocked: false, snapshot: null });
    const high = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, recordingSampleRate: 7 } });
    expect(await config(high)).toMatchObject({ recordingSampleRate: 1 });
    const off = setup({ settings: { ...DEFAULT_PANEL_SETTINGS, recordingSampleRate: 0 } });
    expect(await config(off)).toMatchObject({ recordingSampleRate: 0, recordingBlocked: true });
  });

  it('passes on the snapshot the project asks for, and null for one it cannot read', async () => {
    const asked = setup();
    const request = { pageGroupId: 'pnh_products', urlPattern: '/products/*', deviceClass: 'tablet' };
    asked.kv.entries.set(snapshotRequestKvKey(asked.projectId), JSON.stringify(request));
    expect(await config(asked)).toMatchObject({ snapshot: request });

    const unreadable = setup();
    unreadable.kv.entries.set(
      snapshotRequestKvKey(unreadable.projectId),
      JSON.stringify({ pageGroupId: '../x', urlPattern: '/', deviceClass: 'desktop' }),
    );
    expect(await config(unreadable)).toMatchObject({ snapshot: null });
  });
});

const CHUNK = new Uint8Array(gzipSync(JSON.stringify([{ type: 2, data: {}, timestamp: Date.now() }])));
const SESSION = 's-0123456789';
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A recording plugin's `POST /r` or `POST /snap`: gzip bytes, from the client's address. */
function blob(body: Uint8Array | string = CHUNK, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'User-Agent': CHROME_WINDOWS,
      'CF-Connecting-IP': CLIENT_IP,
      'X-Forwarded-For': CLIENT_IP,
      Origin: 'https://shop.example.com',
      ...headers,
    },
    body: body as BodyInit,
  };
}

function query(path: string, params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `${path}?${pairs.join('&')}`;
}

describe('POST /r', () => {
  const chunkPath = (s: Setup, overrides: Record<string, string | undefined> = {}) => {
    const now = Date.now();
    return query('/r', { t: s.token, s: SESSION, q: '0', a: String(now - 5000), b: String(now - 1000), f: '1', ...overrides });
  };

  it('stores the chunk in the replays bucket, indexes it and counts the recording once', async () => {
    const s = setup();
    const start = Date.now() - 5000;
    const end = start + 4000;
    const res = await s.request(chunkPath(s, { a: String(start), b: String(end) }), blob());
    expect(res.status).toBe(204);

    const key = `30d/${WORKSPACE}/${s.projectId}/${utcDate(start)}/${SESSION}/0.json.gz`;
    expect([...s.replays.objects.keys()]).toEqual([key]);
    expect(s.replays.objects.get(key)).toEqual({ bytes: CHUNK, contentType: 'application/gzip' });
    expect(s.chunks.sent).toEqual([
      {
        workspace_id: WORKSPACE,
        project_id: s.projectId,
        session_id: SESSION,
        seq: 0,
        ts_start: new Date(start).toISOString(),
        ts_end: new Date(end).toISOString(),
        bytes: CHUNK.byteLength,
        has_full_snapshot: true,
        r2_key: key,
      },
    ]);

    expect((await s.request(chunkPath(s, { q: '1', f: '0' }), blob())).status).toBe(204);
    expect((await s.request(chunkPath(s, { q: '2', f: '0' }), blob())).status).toBe(204);
    const usage = await s.usage.get(WORKSPACE).month(month());
    expect(usage.recordings).toBe(1);
    expect(usage.events).toBe(0);
    expect(s.chunks.sent.map((row) => [row.seq, row.has_full_snapshot])).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
  });

  it('uses the 90 day tier the project record names, and the day each chunk starts', async () => {
    const s = setup({ replayTier: '90d' });
    const start = Date.now() - 20 * 60 * 60 * 1000;
    expect((await s.request(chunkPath(s, { q: '3', a: String(start), b: String(start + 60_000), f: '0' }), blob())).status).toBe(204);
    expect([...s.replays.objects.keys()]).toEqual([`90d/${WORKSPACE}/${s.projectId}/${utcDate(start)}/${SESSION}/3.json.gz`]);
  });

  it('keeps client times inside a believable window', async () => {
    const s = setup();
    const now = Date.now();
    await s.request(chunkPath(s, { a: String(now - 90 * DAY_MS), b: String(now + 60 * 60 * 1000) }), blob());

    const [row] = s.chunks.sent;
    expect(Math.abs(Date.parse(String(row!.ts_start)) - (now - 7 * DAY_MS))).toBeLessThan(30_000);
    expect(Math.abs(Date.parse(String(row!.ts_end)) - (now + 60 * 1000))).toBeLessThan(30_000);
  });

  it('refuses what is malformed', async () => {
    const s = setup();
    const now = Date.now();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ t: undefined }, 't: the project token is required'],
      [{ t: '' }, 't: the project token is required'],
      [{ s: 'no spaces allowed' }, 's: not a session id'],
      [{ s: undefined }, 's: not a session id'],
      [{ q: '-1' }, 'q: a whole number from 0 to 100000'],
      [{ q: '100001' }, 'q: a whole number from 0 to 100000'],
      [{ q: '1.5' }, 'q: a whole number from 0 to 100000'],
      [{ a: 'yesterday' }, 'a, b: millisecond times, b not before a'],
      [{ a: String(now), b: String(now - 1) }, 'a, b: millisecond times, b not before a'],
      [{ f: '2' }, 'f: 0 or 1'],
    ];
    for (const [overrides, message] of cases) {
      const res = await s.request(chunkPath(s, overrides), blob());
      expect(res.status, message).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'invalid_request', message });
    }

    const big = new Uint8Array(1024 * 1024 + 1);
    big[0] = 0x1f;
    big[1] = 0x8b;
    const bodies: Array<[Uint8Array | string, number, string, string]> = [
      ['[{"type":2}]'.padEnd(40, ' '), 400, 'invalid_body', 'The body is not gzip'],
      [new Uint8Array(0), 400, 'invalid_body', 'The body is not gzip'],
      [big, 413, 'payload_too_large', 'A body is at most 1048576 bytes'],
    ];
    for (const [body, status, code, message] of bodies) {
      const res = await s.request(chunkPath(s), blob(body));
      expect(res.status, message).toBe(status);
      expect(await errorOf(res)).toEqual({ code, message });
    }
    const unknown = await s.request(chunkPath(s, { t: `wpk_${'f'.repeat(32)}` }), blob());
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual({ code: 'unknown_project', message: 'Unknown project token' });
    expect(s.replays.objects.size).toBe(0);
  });

  it('drops with a 204 what it must not keep', async () => {
    const replayBlocked = freshWorkspace();
    const eventsBlocked = freshWorkspace();
    const cases: Array<[Setup, Record<string, string>]> = [
      [setup({ status: 'paused' }), {}],
      [setup({ allowedDomains: ['example.com'] }), { Origin: 'https://evil.test' }],
      [setup(), { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }],
      [setup({ settings: { ...DEFAULT_PANEL_SETTINGS, ipFilters: ['203.0.113.0/24'] } }), {}],
      [setup({ settings: { ...DEFAULT_PANEL_SETTINGS, recordingSampleRate: 0 } }), {}],
      [setup({ workspaceId: replayBlocked }), {}],
      [setup({ workspaceId: eventsBlocked }), {}],
    ];
    cases[5]![0].kv.entries.set(quotaKvKey(replayBlocked), 'replay_blocked');
    cases[6]![0].kv.entries.set(quotaKvKey(eventsBlocked), 'events_blocked');
    for (const [s, headers] of cases) {
      expect((await s.request(chunkPath(s), blob(CHUNK, headers))).status).toBe(204);
      expect(s.replays.objects.size).toBe(0);
      expect(s.chunks.sent).toEqual([]);
      expect((await s.usage.get(s.workspaceId).month(month())).recordings).toBe(0);
    }

    const subdomain = setup({ allowedDomains: ['example.com'] });
    expect((await subdomain.request(chunkPath(subdomain), blob())).status).toBe(204);
    expect(subdomain.replays.objects.size).toBe(1);
  });

  it('is off, with a 204, without the bucket, and stores without indexing without the stream', async () => {
    const noBucket = setup({}, { replays: false });
    expect((await noBucket.request(chunkPath(noBucket), blob())).status).toBe(204);
    expect(noBucket.chunks.sent).toEqual([]);
    expect((await noBucket.usage.get(WORKSPACE).month(month())).recordings).toBe(0);

    const noIndex = setup({}, { chunks: false });
    expect((await noIndex.request(chunkPath(noIndex), blob())).status).toBe(204);
    expect(noIndex.replays.objects.size).toBe(1);
    expect((await noIndex.usage.get(WORKSPACE).month(month())).recordings).toBe(1);
  });

  it('answers 429 over the per-IP limit, before reading anything, and a CORS preflight', async () => {
    const s = setup({}, { limits: { replays: 1 } });
    expect((await s.request(chunkPath(s), blob())).status).toBe(204);
    const limited = await s.request(chunkPath(s, { q: '1' }), blob('not even gzip'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('10');
    expect(await errorOf(limited)).toEqual({ code: 'rate_limited', message: 'Too many requests' });
    expect(s.replays.objects.size).toBe(1);
    for (const key of s.limiters.REPLAYS_RATE_LIMIT!.calls.keys()) expect(key).toMatch(/^[0-9a-f]{16}$/);

    const preflight = await s.request('/r', {
      method: 'OPTIONS',
      headers: { Origin: 'https://shop.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
  });
});

describe('POST /snap', () => {
  const REQUEST = { pageGroupId: 'pnh_products', urlPattern: '/products/*', deviceClass: 'mobile' };
  const snapPath = (s: Setup, overrides: Record<string, string | undefined> = {}) =>
    query('/snap', { t: s.token, g: 'pnh_products', d: 'mobile', ...overrides });
  const asked = (record: Partial<PanelProjectRecord> = {}, options: SetupOptions = {}) => {
    const s = setup(record, options);
    s.kv.entries.set(snapshotRequestKvKey(s.projectId), JSON.stringify(REQUEST));
    return s;
  };

  it('stores the snapshot the project asked for and takes the request down, counting nothing', async () => {
    const s = asked();
    expect((await s.request(snapPath(s), blob())).status).toBe(204);

    const key = `snapshots/${WORKSPACE}/${s.projectId}/pnh_products/mobile.json.gz`;
    expect([...s.replays.objects.keys()]).toEqual([key]);
    expect(s.replays.objects.get(key)).toEqual({ bytes: CHUNK, contentType: 'application/gzip' });
    expect(s.kv.entries.has(snapshotRequestKvKey(s.projectId))).toBe(false);
    expect(s.chunks.sent).toEqual([]);
    expect((await s.usage.get(WORKSPACE).month(month())).recordings).toBe(0);
  });

  it('ignores a snapshot of another page group or device class, or one nobody asked for', async () => {
    for (const overrides of [{ g: 'pnh_other' }, { d: 'desktop' }]) {
      const s = asked();
      expect((await s.request(snapPath(s, overrides), blob())).status).toBe(204);
      expect(s.replays.objects.size).toBe(0);
      expect(s.kv.entries.has(snapshotRequestKvKey(s.projectId))).toBe(true);
    }
    const unasked = setup();
    expect((await unasked.request(snapPath(unasked), blob())).status).toBe(204);
    expect(unasked.replays.objects.size).toBe(0);
  });

  it('refuses what is malformed', async () => {
    const s = asked();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ t: undefined }, 't: the project token is required'],
      [{ g: '../x' }, 'g: not a page group id'],
      [{ g: undefined }, 'g: not a page group id'],
      [{ d: 'phone' }, 'd: desktop, tablet or mobile'],
      [{ d: undefined }, 'd: desktop, tablet or mobile'],
    ];
    for (const [overrides, message] of cases) {
      const res = await s.request(snapPath(s, overrides), blob());
      expect(res.status, message).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'invalid_request', message });
    }
    expect((await s.request(snapPath(s), blob('not gzip at all, not gzip at all'))).status).toBe(400);
    const big = new Uint8Array(1024 * 1024 + 1);
    big[0] = 0x1f;
    big[1] = 0x8b;
    expect((await s.request(snapPath(s), blob(big))).status).toBe(413);
    expect(s.replays.objects.size).toBe(0);
  });

  it('drops with a 204 for a paused project, a blocked quota and a foreign origin', async () => {
    const workspaceId = freshWorkspace();
    const blocked = asked({ workspaceId });
    blocked.kv.entries.set(quotaKvKey(workspaceId), 'replay_blocked');
    const cases: Array<[Setup, Record<string, string>]> = [
      [asked({ status: 'paused' }), {}],
      [blocked, {}],
      [asked({ allowedDomains: ['example.com'] }), { Origin: 'https://evil.test' }],
    ];
    for (const [s, headers] of cases) {
      expect((await s.request(snapPath(s), blob(CHUNK, headers))).status).toBe(204);
      expect(s.replays.objects.size).toBe(0);
    }
  });

  it('answers 429 over its own per-IP limit, and is off without the bucket', async () => {
    const limited = asked({}, { limits: { snapshots: 0 } });
    expect((await limited.request(snapPath(limited), blob())).status).toBe(429);

    const noBucket = asked({}, { replays: false });
    expect((await noBucket.request(snapPath(noBucket), blob())).status).toBe(204);
    expect(noBucket.kv.entries.has(snapshotRequestKvKey(noBucket.projectId))).toBe(true);
  });
});

const SECRET = `wps_${'0123456789abcdef'.repeat(2)}`;
const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** A project with the secret key registered, as panel-api writes its record. */
function withKey(record: Partial<PanelProjectRecord> = {}, options: SetupOptions = {}, status?: 'active' | 'paused'): Setup {
  const s = setup(record, options);
  s.kv.entries.set(
    keyKvKey(sha256Hex(SECRET)),
    JSON.stringify({ v: 1, keyId: 'pnk_1', workspaceId: s.workspaceId, projectId: s.projectId, ...(status ? { status } : {}) }),
  );
  return s;
}

const iso = (ms: number) => new Date(ms).toISOString();

const serverEvent = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt-00000001',
  name: 'Order placed',
  ts: iso(Date.now() - 1000),
  distinct_id: 'user-1',
  ...overrides,
});

const serverBody = (events: unknown[], extra: Record<string, unknown> = {}) => ({ lib: 'server', lib_version: '0.1.0', events, ...extra });

function send(payload: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

describe.each(['/v1/track', '/v1/import'] as const)('POST %s', (route) => {
  it('writes the events without geo, user agent or visitor hash, and answers how many it accepted', async () => {
    const s = withKey();
    const res = await s.request(
      route,
      send(
        serverBody([
          serverEvent({ props: { total: 12.5, coupon: null } }),
          serverEvent({
            event_id: 'evt-00000002',
            url: 'https://shop.example.com/thanks?utm_source=mail&token=secret',
            title: 'Thanks',
            user_id: 'user-1',
            anon_id: 'a-1',
          }),
        ]),
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(s.stream.sent[0]).toMatchObject({
      event_id: 'evt-00000001',
      workspace_id: WORKSPACE,
      project_id: s.projectId,
      name: 'Order placed',
      distinct_id: 'user-1',
      anon_id: 'user-1',
      user_id: null,
      session_id: null,
      cookieless: false,
      url: '',
      host: '',
      path: '',
      country: null,
      device_type: null,
      browser: null,
      viewport_w: null,
      lib: 'server',
      lib_version: '0.1.0',
      properties: '{"total":12.5,"coupon":null}',
    });
    expect(s.stream.sent[1]).toMatchObject({
      url: 'https://shop.example.com/thanks?utm_source=mail',
      host: 'shop.example.com',
      path: '/thanks',
      utm_source: 'mail',
      title: 'Thanks',
      user_id: 'user-1',
      anon_id: 'a-1',
    });
    const usage = await s.usage.get(WORKSPACE).month(month());
    expect([usage.events, usage.recordings]).toEqual([2, 0]);
    expect(s.kv.entries.get(seenKvKey(s.projectId))).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts unreadable events and times outside the window as dropped, and moves a minute of skew back to now', async () => {
    const s = withKey();
    const now = Date.now();
    const res = await s.request(
      route,
      send(
        serverBody([
          serverEvent(),
          serverEvent({ event_id: 'evt-00000002', distinct_id: undefined }),
          serverEvent({ event_id: 'evt-00000003', ts: iso(now + 30 * 1000) }),
          serverEvent({ event_id: 'evt-00000004', ts: iso(now + 5 * 60 * 1000) }),
          serverEvent({ event_id: 'evt-00000005', ts: iso(now - 6 * 365 * DAY_MS) }),
        ]),
      ),
    );
    expect(await res.json()).toEqual({ accepted: 2, dropped: 3 });
    expect(s.stream.sent.map((row) => row.event_id)).toEqual(['evt-00000001', 'evt-00000003']);
    expect(Math.abs(Date.parse(String(s.stream.sent[1]!.ts)) - now)).toBeLessThan(30_000);
  });

  it('accepts profile and group operations, alone or with events', async () => {
    const s = withKey();
    const people = [
      { op: 'set', user_id: 'user-1', ts: iso(Date.now()), props: { $email: 'Ada@Example.com', plan: 'pro' } },
      { op: 'increment', user_id: 'user-1', ts: iso(Date.now()), props: { orders: 1 } },
      { op: 'bogus' },
    ];
    const groups = [{ op: 'set', type: 'company', key: 'acme', props: { $name: 'Acme' } }];
    const withEvents = await s.request(
      route,
      send(serverBody([serverEvent({ name: '$identify', user_id: 'user-1', anon_id: 'a-browser', props: { $group_company: 'acme' } })], { people, groups })),
    );
    expect(await withEvents.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(s.stream.sent[0]!.properties).toBe('{"$group_company":"acme"}');

    const alone = await s.request(route, send(serverBody([], { people })));
    expect(alone.status).toBe(200);
    expect(await alone.json()).toEqual({ accepted: 0, dropped: 0 });
  });

  it('answers 200 with everything dropped for a blocked workspace, and for a paused project until it resumes', async () => {
    const workspaceId = freshWorkspace();
    const blocked = withKey({ workspaceId });
    blocked.kv.entries.set(quotaKvKey(workspaceId), 'events_blocked');
    const res = await blocked.request(route, send(serverBody([serverEvent(), { nope: 1 }])));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, dropped: 2 });
    expect(blocked.stream.sent).toEqual([]);

    const paused = withKey({}, {}, 'paused');
    expect(await (await paused.request(route, send(serverBody([serverEvent()])))).json()).toEqual({ accepted: 0, dropped: 1 });
    expect(paused.stream.sent).toEqual([]);
    paused.kv.entries.set(
      keyKvKey(sha256Hex(SECRET)),
      JSON.stringify({ v: 1, keyId: 'pnk_1', workspaceId: WORKSPACE, projectId: paused.projectId, status: 'active' }),
    );
    expect(await (await paused.request(route, send(serverBody([serverEvent()])))).json()).toEqual({ accepted: 1, dropped: 0 });
  });

  it('answers 503 when the stream refuses the rows, so the caller can retry', async () => {
    const s = withKey({}, { failingStream: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await s.request(route, send(serverBody([serverEvent()])));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toEqual({ code: 'write_failed', message: 'The events could not be stored, try again' });
    expect((await s.usage.get(WORKSPACE).month(month())).events).toBe(0);
    consoleError.mockRestore();
  });

  it('answers 401 without a valid secret key, before reading the body', async () => {
    const s = withKey();
    const cases: Array<Record<string, string>> = [
      {},
      { Authorization: `Basic ${SECRET}` },
      { Authorization: `Bearer wpk_${'a'.repeat(32)}` },
      { Authorization: 'Bearer wps_short' },
      { Authorization: `Bearer wps_${'f'.repeat(32)}` },
    ];
    for (const headers of cases) {
      const res = await s.request(route, send('{not json', headers));
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await errorOf(res)).toEqual({ code: 'unauthorized', message: 'Send a valid secret key as a Bearer token' });
    }
    s.kv.entries.delete(keyKvKey(sha256Hex(SECRET)));
    expect((await s.request(route, send(serverBody([serverEvent()])))).status).toBe(401);
    expect(s.stream.sent).toEqual([]);
  });

  it('refuses what it cannot read', async () => {
    const s = withKey();
    const cases: Array<[unknown, string, string]> = [
      ['{not json', 'invalid_body', 'The body is not valid JSON'],
      [{ ...serverBody([serverEvent()]), lib: 'web' }, 'invalid_batch', 'lib: Invalid literal value, expected "server"'],
      [serverBody([]), 'invalid_batch', 'events: Send at least one event or people operation'],
      [serverBody([{ nope: 1 }]), 'invalid_batch', 'events.0.event_id: Required'],
      [serverBody([{ nope: true }], { people: [] }), 'invalid_batch', 'events.0.event_id: Required'],
      [serverBody([], { people: [{ op: 'bogus' }] }), 'invalid_batch', 'people: No valid event or people operation'],
      [serverBody([serverEvent({ name: 'bad name!' })]), 'invalid_batch', 'events.0.name: Invalid'],
      [[1, 2], 'invalid_batch', 'Expected object, received array'],
    ];
    for (const [body, code, message] of cases) {
      const res = await s.request(route, send(body));
      expect(res.status, message).toBe(400);
      expect(await errorOf(res)).toEqual({ code, message });
    }
  });
});

describe('POST /v1/track and /v1/import limits', () => {
  const many = (count: number, overrides: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_, i) => serverEvent({ event_id: `evt-${String(i).padStart(8, '0')}`, ...overrides }));

  it('track takes 100 events from the last 7 days and at most a MiB', async () => {
    const s = withKey();
    expect((await s.request('/v1/track', send(serverBody(many(100))))).status).toBe(200);
    expect(s.stream.sent).toHaveLength(100);
    const tooMany = await s.request('/v1/track', send(serverBody(many(101))));
    expect(tooMany.status).toBe(400);
    expect(await errorOf(tooMany)).toEqual({ code: 'invalid_batch', message: 'events: Array must contain at most 100 element(s)' });

    const now = Date.now();
    const window = await s.request(
      '/v1/track',
      send(serverBody([serverEvent({ ts: iso(now - 6 * DAY_MS) }), serverEvent({ event_id: 'evt-00000002', ts: iso(now - 8 * DAY_MS) })])),
    );
    expect(await window.json()).toEqual({ accepted: 1, dropped: 1 });

    const big = await s.request('/v1/track', send('x'.repeat(1024 * 1024 + 1)));
    expect(big.status).toBe(413);
    expect(await errorOf(big)).toEqual({ code: 'payload_too_large', message: 'A request is at most 1048576 bytes' });
  });

  it('import takes 1000 events up to five years old, keeping their time', async () => {
    const s = withKey();
    expect((await s.request('/v1/import', send(serverBody(many(1000))))).status).toBe(200);
    expect(s.stream.sent).toHaveLength(1000);
    expect((await s.request('/v1/import', send(serverBody(many(1001))))).status).toBe(400);

    const old = Date.now() - 4 * 365 * DAY_MS;
    const res = await s.request(
      '/v1/import',
      send(serverBody([serverEvent({ event_id: 'evt-old-0001', ts: iso(old) }), serverEvent({ event_id: 'evt-old-0002', ts: iso(Date.now() - 6 * 365 * DAY_MS) })])),
    );
    expect(await res.json()).toEqual({ accepted: 1, dropped: 1 });
    expect(s.stream.sent.at(-1)!.ts).toBe(iso(old));
  });

  it('are not reachable with GET', async () => {
    const s = withKey();
    expect((await s.request('/v1/track')).status).toBe(404);
  });
});

describe('POST /e limits', () => {
  it('answers 429 over the per-IP limit, before reading the body', async () => {
    const s = setup({}, { limits: { events: 2 } });
    expect((await s.request('/e', post(batch(s.token)))).status).toBe(204);
    expect((await s.request('/e', post(batch(s.token)))).status).toBe(204);
    const res = await s.request('/e', post('{not json'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('10');
    expect(await errorOf(res)).toEqual({ code: 'rate_limited', message: 'Too many requests' });
    expect(s.stream.sent).toHaveLength(2);
  });

  it('limits per client address, and per connecting address with the higher ceiling', async () => {
    const s = setup({}, { limits: { events: 1, proxy: 2 } });
    const from = (client: string) => post(batch(s.token), { 'X-Forwarded-For': client, 'CF-Connecting-IP': CLIENT_IP });

    expect((await s.request('/e', from('198.51.100.1'))).status).toBe(204);
    expect((await s.request('/e', from('198.51.100.1'))).status).toBe(429);
    expect((await s.request('/e', from('198.51.100.2'))).status).toBe(204);
    // A third client through the same proxy is over the proxy's ceiling of two.
    expect((await s.request('/e', from('198.51.100.3'))).status).toBe(429);
    for (const key of s.limiters.EVENTS_RATE_LIMIT!.calls.keys()) {
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(key).not.toContain('198.51.100');
    }
  });

  it('does not limit a request that has no address', async () => {
    const s = setup({}, { limits: { events: 0 } });
    expect((await s.request('/e', post(batch(s.token), { 'CF-Connecting-IP': '', 'X-Forwarded-For': '' }))).status).toBe(204);
    expect(s.stream.sent).toHaveLength(1);
  });
});
