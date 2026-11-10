/**
 * The asset import sweep on the due index, end to end: `runAssetImportSweep(env, now)`
 * lists the SQLite D1 `workspace_due_index` (kind `asset_import`), opens only the
 * due workspace (tenant: pglite), starts the imports that came due, runs ONE
 * bounded step per tick against a stubbed Microsoft, and stores when the
 * workspace is next due: now while an import is under way, the earliest
 * `next_sync_at` otherwise, or drops the row.
 *
 * The Microsoft stub answers by URL and method (never by call order) and is
 * installed as the global `fetch`, so a Rust run of the same tick calls it too.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';

const dbs = vi.hoisted(() => ({ tenant: null as unknown, opened: [] as string[] }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async (_env: unknown, orgId: string) => {
      dbs.opened.push(orgId);
      return dbs.tenant;
    },
  };
});

import { ASSET_IMPORT_MAX_WRITES } from '@weldsuite/core-domain/asset-sources';
import { runAssetImportSweep, ASSET_IMPORT_STEPS_PER_TICK } from './asset-import-sweep';

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const ORG = 'org_asset_import';
const WORKSPACE = 'ws_asset_import';
const KEY = 'ab'.repeat(32);
const SECRET = 's3cret';
const TENANT = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-11-10T08:00:30Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEVICES = 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices';
const { assetSources: sources } = schema;

let db: Database;
let master: MasterDatabase;
let close: () => Promise<void>;
const published: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
}, 120_000);

afterAll(async () => {
  if (close) await close();
});

interface Graph {
  value: unknown[];
  status?: number;
  retryAfter?: string;
  secret: string;
  calls: string[];
}
let graph: Graph;

const device = (n: number) => ({
  id: `dev-${n}`,
  deviceName: `DEVICE-${n}`,
  serialNumber: `SN-${n}`,
  operatingSystem: 'Windows',
  model: 'Latitude 7440',
  complianceState: 'compliant',
});

beforeEach(async () => {
  dbs.opened.length = 0;
  published.length = 0;
  for (const table of [
    schema.customObjectRelations,
    schema.customFieldValues,
    schema.customObjectRecords,
    schema.integrationEntityMappings,
    sources,
    schema.customObjectLinks,
    schema.customFieldDefinitions,
    schema.customObjects,
  ]) {
    await db.delete(table);
  }
  const at = new Date('2026-06-01T09:00:00Z');
  await db.insert(schema.customObjects).values({
    id: 'cobj_asset',
    slug: 'asset',
    entityKey: 'co_asset',
    labelSingular: 'Asset',
    labelPlural: 'Assets',
    titleFieldId: 'cfld_name',
    status: 'active',
    enableEvents: true,
  });
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_name', entityType: 'co_asset', name: 'Name', slug: 'name', fieldType: 'text', required: true, sortOrder: 0, createdAt: at, updatedAt: at },
    { id: 'cfld_serial', entityType: 'co_asset', name: 'Serial number', slug: 'serial_number', fieldType: 'text', sortOrder: 1, createdAt: at, updatedAt: at },
  ]);

  graph = { value: [device(1), device(2)], secret: SECRET, calls: [] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    graph.calls.push(`${method} ${url}`);
    if (method === 'POST' && url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      if (new URLSearchParams(String(init?.body)).get('client_secret') !== graph.secret) {
        return new Response(JSON.stringify({ error_codes: [7000215] }), { status: 401 });
      }
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    if (method === 'GET' && url === DEVICES) {
      if (graph.status) return new Response('{}', { status: graph.status, headers: graph.retryAfter ? { 'Retry-After': graph.retryAfter } : {} });
      return new Response(JSON.stringify({ value: graph.value }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function makeEnv() {
  return {
    ENVIRONMENT: 'test',
    DATABASE_ENCRYPTION_KEY: KEY,
    SCHEDULE_INDEX: createSqliteD1(MIGRATION),
    WORKSPACE_CACHE: createMemoryKv(),
    ENTITY_EVENTS: { send: async (message: Record<string, unknown>) => void published.push(message) },
  };
}
type Env = ReturnType<typeof makeEnv>;

function sweep(env: Env, now: Date = NOW) {
  return conformanceSweep({
    job: 'asset-import-sweep',
    now,
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: env as unknown as Record<string, unknown>,
    dueIndex: { d1: env.SCHEDULE_INDEX as never, kind: 'asset_import' },
    kv: env.WORKSPACE_CACHE as object,
    workspaces: { [WORKSPACE]: ORG },
    runTypeScript: async (tenantDb, runEnv) => {
      dbs.tenant = tenantDb;
      try {
        return await runAssetImportSweep(runEnv as never, now);
      } finally {
        dbs.tenant = db;
      }
    },
    takeTypeScriptEvents: () => published.splice(0),
  });
}

async function addSource(id: string, overrides: Partial<typeof sources.$inferInsert> = {}) {
  await db.insert(sources).values({
    id,
    type: 'intune',
    name: `Source ${id}`,
    objectSlug: 'asset',
    config: { tenantId: TENANT, clientId: `client-${id}` },
    secretEncrypted: await encryptField(SECRET, { v1: KEY }),
    enabled: true,
    intervalHours: 24,
    nextSyncAt: new Date(NOW.getTime() - MINUTE),
    createdById: 'user_admin',
    createdAt: new Date(NOW.getTime() - HOUR),
    updatedAt: new Date(NOW.getTime() - HOUR),
    ...overrides,
  });
}

const rowOf = async (id: string) => (await db.select().from(sources).where(eq(sources.id, id)))[0]!;

async function dueAt(env: Env): Promise<number | null> {
  const { results } = await (env.SCHEDULE_INDEX as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('asset_import', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

async function markDue(env: Env, at: Date) {
  await markWorkspaceDue(env.SCHEDULE_INDEX as never, 'asset_import', ORG, at);
}

const recordCount = async () => (await db.select().from(schema.customObjectRecords)).length;
const eventTypes = () => published.map((m) => `${String(m.entityType)}:${String(m.action)}`);

describe('asset import sweep on the due index', () => {
  it('starts a due import, runs it to the end and stores the next scheduled time', async () => {
    await addSource('asrc_a');
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));

    expect(await sweep(env)).toMatchObject({ due: 1, processed: 1, failed: 0, steps: 1, ended: 1 });

    const row = await rowOf('asrc_a');
    expect(row.syncState).toBeNull();
    expect(row.lastStatus).toBe('ok');
    expect(row.lastStats).toEqual({ total: 2, created: 2, updated: 0, unchanged: 0, failed: 0 });
    expect(row.lastSyncAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.nextSyncAt?.toISOString()).toBe('2026-11-11T08:00:30.000Z');
    expect(await dueAt(env)).toBe(Date.parse('2026-11-11T08:00:30Z'));
    expect(await recordCount()).toBe(2);

    // Records, the fields the import added and the finished run are announced.
    expect(eventTypes().filter((t) => t === 'co_asset:created')).toHaveLength(2);
    expect(eventTypes().filter((t) => t === 'custom_field:created').length).toBeGreaterThanOrEqual(8);
    expect(eventTypes()).toContain('asset_source:updated');
    expect(JSON.stringify(published)).not.toContain(SECRET);
    expect(JSON.stringify(published)).not.toContain('ecretEncrypted');
  });

  it('continues an import over ticks while the workspace stays due now', async () => {
    await addSource('asrc_a');
    // Five devices more than one step may write.
    const cap = ASSET_IMPORT_MAX_WRITES;
    const total = cap + 5;
    graph.value = Array.from({ length: total }, (_, i) => device(i + 1));
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));

    expect(await sweep(env)).toMatchObject({ steps: 1, ended: 0 });
    expect((await rowOf('asrc_a')).lastStatus).toBe('running');
    expect((await rowOf('asrc_a')).syncState).toMatchObject({ offset: cap, stats: { total: cap, created: cap } });
    expect(await recordCount()).toBe(cap);
    // Under way: due again right away, not at the schedule.
    expect(await dueAt(env)).toBe(NOW.getTime());

    const later = new Date(NOW.getTime() + MINUTE);
    expect(await sweep(env, later)).toMatchObject({ steps: 1, ended: 1 });
    const row = await rowOf('asrc_a');
    expect(row.lastStatus).toBe('ok');
    expect(row.lastStats).toEqual({ total, created: total, updated: 0, unchanged: 0, failed: 0 });
    expect(row.nextSyncAt?.toISOString()).toBe(new Date(later.getTime() + 24 * HOUR).toISOString());
    expect(await dueAt(env)).toBe(later.getTime() + 24 * HOUR);
  });

  it('does not open the workspace before the next import is due', async () => {
    await addSource('asrc_a', { nextSyncAt: new Date(NOW.getTime() + 6 * HOUR) });
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() + 6 * HOUR));

    expect(await sweep(env)).toMatchObject({ due: 0, steps: 0 });
    expect(dbs.opened).toEqual([]);

    expect(await sweep(env, new Date(NOW.getTime() + 6 * HOUR))).toMatchObject({ due: 1, steps: 1, ended: 1 });
    expect(dbs.opened).toEqual([ORG]);
    expect((await rowOf('asrc_a')).lastStatus).toBe('ok');
  });

  it('runs one step per tick: the second due source waits for the next tick', async () => {
    await addSource('asrc_a', { createdAt: new Date(NOW.getTime() - 2 * HOUR) });
    await addSource('asrc_b', { createdAt: new Date(NOW.getTime() - HOUR) });
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));
    expect(ASSET_IMPORT_STEPS_PER_TICK).toBe(1);

    expect(await sweep(env)).toMatchObject({ steps: 1, ended: 1 });
    expect((await rowOf('asrc_a')).lastStatus).toBe('ok');
    expect((await rowOf('asrc_b')).lastStatus).toBeNull();
    // The other source is still due.
    expect(await dueAt(env)).toBeLessThanOrEqual(NOW.getTime());

    expect(await sweep(env, new Date(NOW.getTime() + MINUTE))).toMatchObject({ steps: 1, ended: 1 });
    expect((await rowOf('asrc_b')).lastStatus).toBe('ok');
  });

  it('leaves a paused source alone, and drops the row when no source is left to import', async () => {
    await addSource('asrc_a', { enabled: false, nextSyncAt: null });
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));

    expect(await sweep(env)).toMatchObject({ due: 1, processed: 1, steps: 0 });
    expect((await rowOf('asrc_a')).lastStatus).toBeNull();
    expect(graph.calls).toEqual([]);
    expect(await dueAt(env)).toBeNull();
  });

  it('finishes an import that was started by hand on a paused source, and keeps the schedule off', async () => {
    await addSource('asrc_a', {
      enabled: false,
      nextSyncAt: null,
      lastStatus: 'running',
      syncState: { startedAt: NOW.toISOString(), nextLink: null, offset: 0, stats: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 }, startedById: 'user_admin' },
    });
    const env = makeEnv();
    await markDue(env, NOW);

    expect(await sweep(env)).toMatchObject({ steps: 1, ended: 1 });
    const row = await rowOf('asrc_a');
    expect(row.lastStatus).toBe('ok');
    expect(row.nextSyncAt).toBeNull();
    expect(await dueAt(env)).toBeNull();
  });

  it('waits for Retry-After when Microsoft throttles, then carries on', async () => {
    await addSource('asrc_a');
    graph.status = 429;
    graph.retryAfter = '300';
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));

    expect(await sweep(env)).toMatchObject({ steps: 1, ended: 0 });
    expect((await rowOf('asrc_a')).lastStatus).toBe('running');
    expect(await dueAt(env)).toBe(NOW.getTime() + 300_000);
    expect(await recordCount()).toBe(0);

    graph.status = undefined;
    expect(await sweep(env, new Date(NOW.getTime() + 300_000))).toMatchObject({ steps: 1, ended: 1 });
    expect((await rowOf('asrc_a')).lastStatus).toBe('ok');
  });

  it('ends a run Microsoft refuses as failed and carries on at the next interval', async () => {
    await addSource('asrc_a');
    graph.secret = 'rotated';
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));

    expect(await sweep(env)).toMatchObject({ steps: 1, ended: 1, failed: 0 });
    const row = await rowOf('asrc_a');
    expect(row.lastStatus).toBe('failed');
    expect(row.lastError).toMatch(/^invalid_secret: /);
    expect(row.syncState).toBeNull();
    expect(await dueAt(env)).toBe(Date.parse('2026-11-11T08:00:30Z'));
    expect(eventTypes()).toEqual(['asset_source:updated']);
  });
});
