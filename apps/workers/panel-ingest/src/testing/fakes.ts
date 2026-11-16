/**
 * In-memory stand-ins for the worker's bindings, and request builders for the
 * route tests. The Durable Objects are the real classes on a fake `ctx`, so
 * the tests drive the same code the runtime does.
 */

import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import { projectKvKey } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { EventBatch, WireEvent } from '@weldsuite/panel-domain/wire';
import { PanelProject } from '../durable-objects/panel-project';
import { PanelSalt } from '../durable-objects/panel-salt';
import { PanelUsage } from '../durable-objects/panel-usage';
import type { PanelIdentityRecord, PanelPersonRecord, PanelReplayChunkRecord } from '@weldsuite/panel-domain/tables';
import type { Env, PanelEventRecord } from '../env';
import { app } from '../index';
import { resetLive } from '../lib/live';
import { resetQuotaCache } from '../lib/quota';
import { resetSeenThrottle } from '../lib/seen';
import { resetWarnings } from '../lib/warn';
import { resetSaltCache } from '../lib/visitor';

export const TOKEN = `wpk_${'a'.repeat(32)}`;
export const PROJECT_ID = 'pnp_test_project';
export const WORKSPACE_ID = 'ws_test_workspace';
export const NOW = Date.parse('2026-10-27T12:00:00.000Z');

export const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export interface FakeKv extends KVNamespace {
  store: Map<string, string>;
  puts: { key: string; value: string; options: unknown }[];
}

export function fakeKv(initial: Record<string, string> = {}): FakeKv {
  const store = new Map(Object.entries(initial));
  const puts: FakeKv['puts'] = [];
  const kv = {
    store,
    puts,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, options?: unknown) => {
      store.set(key, value);
      puts.push({ key, value, options });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return kv as unknown as FakeKv;
}

/** The slice of Durable Object storage the objects use, with an alarm that can be read back. */
export function fakeDurableObjectContext(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      let removed = 0;
      for (const key of list) if (data.delete(key)) removed += 1;
      return removed;
    },
    list: async (options: { prefix?: string } = {}) =>
      new Map([...data].filter(([key]) => !options.prefix || key.startsWith(options.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
  return { ctx: { storage } as unknown as DurableObjectState, data, alarm: () => alarm };
}

/** A namespace whose `get(idFromName(name))` returns the same object for the same name. */
export function fakeNamespace<T extends object>(create: () => T) {
  const instances = new Map<string, T>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let instance = instances.get(id);
      if (!instance) {
        instance = create();
        instances.set(id, instance);
      }
      return instance;
    },
    instances,
  };
}

export function fakePipeline<T>() {
  const sent: T[] = [];
  return {
    sent,
    send: vi.fn(async (records: T[]) => {
      sent.push(...records);
    }),
  };
}

export function fakeStream() {
  return fakePipeline<PanelEventRecord>();
}

type SqlValue = string | number | null;

/**
 * Durable Object storage with a real SQLite behind `storage.sql` (node's
 * built-in), so the PanelProject object runs its own queries in the tests.
 */
export function fakeSqlContext() {
  const db = new DatabaseSync(':memory:');
  let alarm: number | null = null;
  const sql = {
    exec: (query: string, ...bindings: SqlValue[]) => {
      const rows = db.prepare(query).all(...bindings) as Record<string, SqlValue>[];
      return { toArray: () => rows, one: () => rows[0], rowsRead: rows.length, rowsWritten: 0 };
    },
  };
  const storage = {
    sql,
    transactionSync: <R>(fn: () => R): R => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  return { ctx: { storage } as unknown as DurableObjectState, db, alarm: () => alarm };
}

export interface FakeR2 extends R2Bucket {
  objects: Map<string, { bytes: Uint8Array; options: unknown }>;
}

export function fakeR2(): FakeR2 {
  const objects: FakeR2['objects'] = new Map();
  return {
    objects,
    put: vi.fn(async (key: string, value: Uint8Array, options?: unknown) => {
      objects.set(key, { bytes: value, options });
      return null;
    }),
  } as unknown as FakeR2;
}

/** A Workers rate limiter that lets `allowed` calls per key through, then refuses. */
export function fakeRateLimit(allowed: number) {
  const calls = new Map<string, number>();
  return {
    calls,
    limit: vi.fn(async ({ key }: { key: string }) => {
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      return { success: n <= allowed };
    }),
  };
}

export function projectRecord(overrides: Partial<PanelProjectRecord> = {}): PanelProjectRecord {
  return {
    v: 1,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    status: 'active',
    allowedDomains: [],
    settings: { ...DEFAULT_PANEL_SETTINGS },
    ...overrides,
  };
}

export interface TestEnv {
  env: Env;
  kv: FakeKv;
  stream: ReturnType<typeof fakeStream>;
  identities: ReturnType<typeof fakePipeline<PanelIdentityRecord>>;
  people: ReturnType<typeof fakePipeline<PanelPersonRecord>>;
  replayChunks: ReturnType<typeof fakePipeline<PanelReplayChunkRecord>>;
  replays: FakeR2;
  /** The PanelProject objects behind `PANEL_PROJECT`, by project id; `jurisdictions` records `jurisdiction()` calls. */
  projects: ReturnType<typeof fakeNamespace<PanelProject>> & { jurisdictions: string[] };
  /** The salt object behind `PANEL_SALT`. */
  salt: PanelSalt;
  usage: ReturnType<typeof fakeNamespace<PanelUsage>>;
}

/** An environment with one project (`TOKEN`) registered, unless `record` is null. */
export function makeEnv(record: PanelProjectRecord | null = projectRecord(), options: { limits?: { events?: number; replays?: number; snapshots?: number } } = {}): TestEnv {
  const kv = fakeKv(record ? { [projectKvKey(TOKEN)]: JSON.stringify(record) } : {});
  const stream = fakeStream();
  const salt = new PanelSalt(fakeDurableObjectContext().ctx, {});
  const saltNamespace = fakeNamespace(() => salt);
  const usage = fakeNamespace(() => new PanelUsage(fakeDurableObjectContext().ctx, {} as Env));

  const identities = fakePipeline<PanelIdentityRecord>();
  const people = fakePipeline<PanelPersonRecord>();
  const replayChunks = fakePipeline<PanelReplayChunkRecord>();
  const replays = fakeR2();
  const jurisdictions: string[] = [];
  // The object namespace is EU-only here: `jurisdiction('eu')` returns it, and is noted.
  const projectObjects = fakeNamespace(() => new PanelProject(fakeSqlContext().ctx, env));
  const projectNamespace = {
    ...projectObjects,
    jurisdiction: (jurisdiction: string) => {
      jurisdictions.push(jurisdiction);
      return projectObjects;
    },
  };
  const { limits = {} } = options;

  const env = {
    ENVIRONMENT: 'test',
    WORKSPACE_CACHE: kv,
    PANEL_EVENTS: stream,
    PANEL_IDENTITIES: identities,
    PANEL_PEOPLE: people,
    PANEL_REPLAY_CHUNKS: replayChunks,
    PANEL_REPLAYS: replays,
    PANEL_SALT: saltNamespace,
    PANEL_USAGE: usage,
    PANEL_PROJECT: projectNamespace,
    ...(limits.events !== undefined ? { EVENTS_RATE_LIMIT: fakeRateLimit(limits.events) } : {}),
    ...(limits.replays !== undefined ? { REPLAYS_RATE_LIMIT: fakeRateLimit(limits.replays) } : {}),
    ...(limits.snapshots !== undefined ? { SNAPSHOTS_RATE_LIMIT: fakeRateLimit(limits.snapshots) } : {}),
  } as unknown as Env;
  return { env, kv, stream, identities, people, replayChunks, replays, projects: Object.assign(projectObjects, { jurisdictions }), salt, usage };
}

/** Clears what an isolate would keep between requests. */
export function resetIsolateState(): void {
  resetSaltCache();
  resetSeenThrottle();
  resetQuotaCache();
  resetLive();
  resetWarnings();
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function fakeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settled: () => Promise.all(pending) };
}

export function wireEvent(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    event_id: 'evt-00000001',
    name: '$pageview',
    ts: '2026-10-27T11:59:58.000Z',
    url: 'https://shop.example.com/products?utm_source=news',
    ...overrides,
  };
}

export function wireBatch(overrides: Partial<EventBatch> = {}): EventBatch {
  return {
    token: TOKEN,
    sent_at: '2026-10-27T12:00:00.000Z',
    lib: 'web',
    lib_version: '0.1.0',
    consent: false,
    events: [wireEvent()],
    ...overrides,
  };
}

export interface SendOptions {
  /** A string or bytes are sent as is, anything else as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /** `request.cf`, as Cloudflare would set it. */
  cf?: Record<string, unknown>;
  method?: string;
  path?: string;
}

const DEFAULT_CF = { country: 'NL', region: 'North Holland', city: 'Amsterdam' };

/** Calls the worker like a browser's beacon would and waits for the `waitUntil` work. */
export async function call(testEnv: TestEnv, options: SendOptions = {}) {
  const { method = 'POST', path = '/e', body, cf = DEFAULT_CF } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'User-Agent': CHROME_WINDOWS,
    'CF-Connecting-IP': '203.0.113.7',
    Origin: 'https://shop.example.com',
    ...options.headers,
  };
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'OPTIONS' && method !== 'HEAD') {
    init.body =
      typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body ?? wireBatch());
  }

  const request = new Request(`https://pnl.test${path}`, init);
  Object.defineProperty(request, 'cf', { value: cf });

  const execution = fakeExecutionContext();
  const response = await app.fetch(request, testEnv.env, execution.ctx);
  await execution.settled();
  return response;
}
