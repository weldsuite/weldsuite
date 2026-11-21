/**
 * The raw-export runner on a real tenant schema (pglite), with a fake Basin
 * and a fake S3: hour windows up to now − 15 minutes, every table of a window
 * before the cursor moves, keyset pages as separate files, gzipped JSON Lines
 * at the documented keys, one run row per table and window, erased people
 * left out, and three failures in a row → `failing` and one email.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { PanelQueryContext, PanelSqlQuery } from '@weldsuite/panel-domain/query';
import { PANEL_EXPORT_PAGE_SIZE } from '@weldsuite/panel-domain/query/export';
import type { PanelExport } from '@weldsuite/db/schema';
import { basicIso, exportObjectKey, runExport, toJsonLines, windowEnd, type ExportRunDeps } from './exports';
import { sealSecret } from './secrets';
import { gunzipText } from '../test-support/fakes';

const { panelExportRuns, panelExports } = schema;
const KEY = '0'.repeat(63) + '2';
const env = { DATABASE_ENCRYPTION_KEY: KEY } as never;
const NOW = new Date('2026-11-16T12:00:00Z');

let db: Database;

const ctx = (erasedIds: string[] = []): PanelQueryContext => ({ workspaceId: 'ws_a', projectId: 'pnp_a', retentionDays: 365, hasIdentifiedUsers: false, erasedIds, now: NOW });

describe('keys and lines', () => {
  it('names files by table, day, hour, export and window start (ISO basic), pages numbered from the second', () => {
    const from = new Date('2026-11-16T10:00:00Z');
    expect(basicIso(from)).toBe('20261116T100000Z');
    expect(exportObjectKey('raw/weldpanel', 'events', 'pnex_1', from, 0)).toBe('raw/weldpanel/events/dt=2026-11-16/hour=10/pnex_1-20261116T100000Z.jsonl.gz');
    expect(exportObjectKey('', 'people', 'pnex_1', from, 2)).toBe('people/dt=2026-11-16/hour=10/pnex_1-20261116T100000Z-2.jsonl.gz');
  });

  it('writes one JSON object per line, properties as an object', () => {
    expect(toJsonLines([{ a: 1, properties: '{"plan":"pro"}' }, { a: 2, properties: 'not json' }])).toBe('{"a":1,"properties":{"plan":"pro"}}\n{"a":2,"properties":"not json"}\n');
    expect(toJsonLines([])).toBe('');
  });

  it('cuts windows at the hour, or at the end', () => {
    expect(windowEnd(new Date('2026-11-16T10:20:00Z'), NOW).toISOString()).toBe('2026-11-16T11:00:00.000Z');
    expect(windowEnd(new Date('2026-11-16T11:00:00Z'), new Date('2026-11-16T11:45:00Z')).toISOString()).toBe('2026-11-16T11:45:00.000Z');
  });
});

describe('runExport', () => {
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  beforeEach(async () => {
    await db.delete(panelExportRuns);
    await db.delete(panelExports);
  });

  async function exportRow(overrides: Partial<typeof panelExports.$inferInsert> = {}): Promise<PanelExport> {
    const [row] = await db
      .insert(panelExports)
      .values({
        id: 'pnex_1',
        projectId: 'pnp_a',
        name: 'Raw',
        destination: { provider: 's3', endpoint: null, region: 'eu-west-1', bucket: 'acme', prefix: 'weldpanel', accessKeyId: 'AKIA1', pathStyle: false },
        secretCiphertext: await sealSecret(env, 'secret-1'),
        tables: ['events', 'people'],
        frequency: 'hourly',
        startAt: new Date('2026-11-16T10:00:00Z'),
        createdByUserId: 'user_alice',
        ...overrides,
      })
      .returning();
    return row!;
  }

  function fakes(options: { s3Status?: number; eventPages?: number } = {}) {
    const sent: PanelSqlQuery[] = [];
    const puts: { url: string; body: Uint8Array }[] = [];
    let eventCalls = 0;
    const execute = vi.fn(async (query: PanelSqlQuery) => {
      sent.push(query);
      if (query.name === 'export_events') {
        eventCalls += 1;
        // The first window's first page is full, so a second page is read.
        if (options.eventPages === 2 && eventCalls === 1) {
          return { rows: Array.from({ length: PANEL_EXPORT_PAGE_SIZE }, (_, i) => ({ event_id: `evt_${String(i).padStart(5, '0')}`, received_at: '2026-11-16T10:10:00.000001Z', properties: '{}' })) };
        }
        return { rows: [{ event_id: 'evt_last', received_at: '2026-11-16T10:30:00Z', name: '$pageview', properties: '{"plan":"pro"}' }] };
      }
      return { rows: [] };
    });
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      puts.push({ url, body: init.body as Uint8Array });
      return new Response(options.s3Status && options.s3Status >= 400 ? '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' : '', { status: options.s3Status ?? 200 });
    });
    const notifyFailing = vi.fn(async () => {});
    const deps: ExportRunDeps = {
      db,
      env,
      now: NOW,
      deadline: Date.now() + 60_000,
      execute,
      context: async () => ctx(['user_erased']),
      s3: { fetch: fetch as unknown as typeof globalThis.fetch },
      notifyFailing,
    };
    return { deps, sent, puts, notifyFailing };
  }

  it('writes every table of every window up to now − 15 minutes, and moves the cursor', async () => {
    const f = fakes({ eventPages: 2 });
    const result = await runExport(f.deps, await exportRow());
    expect(result).toMatchObject({ windows: 2, caughtUp: true, error: null });
    expect(result.export.exportedUntil?.toISOString()).toBe('2026-11-16T11:45:00.000Z');

    // Windows [10:00, 11:00) and [11:00, 11:45), events then people; the first events window has two pages.
    const runs = await db.select().from(panelExportRuns);
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    const first = runs.find((r) => r.table === 'events' && r.windowFrom.toISOString() === '2026-11-16T10:00:00.000Z')!;
    expect(first).toMatchObject({ rows: PANEL_EXPORT_PAGE_SIZE + 1, files: 2 });

    expect(f.puts.map((p) => p.url)).toEqual([
      'https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/dt%3D2026-11-16/hour%3D10/pnex_1-20261116T100000Z.jsonl.gz',
      'https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/dt%3D2026-11-16/hour%3D10/pnex_1-20261116T100000Z-1.jsonl.gz',
      'https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/dt%3D2026-11-16/hour%3D11/pnex_1-20261116T110000Z.jsonl.gz',
    ]);
    const lines = (await gunzipText(f.puts[1]!.body)).trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ event_id: 'evt_last', properties: { plan: 'pro' } });

    // The second page starts after the first page's last row, fractional seconds kept; erased people are left out.
    const events = f.sent.filter((q) => q.name === 'export_events');
    expect(events[1]!.sql).toContain("received_at = TIMESTAMP '2026-11-16 10:10:00.000001' AND event_id > 'evt_04999'");
    expect(f.sent.every((q) => q.sql.includes("workspace_id = 'ws_a'") && q.sql.includes("project_id = 'pnp_a'"))).toBe(true);
    expect(f.sent.find((q) => q.name === 'export_people')!.sql).toContain("user_id NOT IN ('user_erased')");
  });

  it('starts no earlier than the plan’s retention, and stops at the per-run window limit', async () => {
    const f = fakes();
    const result = await runExport(f.deps, await exportRow({ startAt: new Date('2020-01-01T00:00:00Z'), tables: ['identities'] }));
    expect(result.windows).toBe(24);
    expect(result.caughtUp).toBe(false);
    const firstRun = (await db.select().from(panelExportRuns)).sort((a, b) => a.windowFrom.getTime() - b.windowFrom.getTime())[0]!;
    expect(firstRun.windowFrom.toISOString()).toBe('2025-11-16T12:00:00.000Z');
  });

  it('keeps the cursor on a failure, marks the export failing after three, mails once, and recovers', async () => {
    let exp = await exportRow({ tables: ['events'] });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const f = fakes({ s3Status: 403 });
      const result = await runExport(f.deps, exp);
      exp = result.export;
      expect(result.error).toBe('AccessDenied: Access Denied');
      expect(exp.exportedUntil).toBeNull();
      expect(exp.status).toBe(attempt >= 3 ? 'failing' : 'active');
      expect(f.notifyFailing).toHaveBeenCalledTimes(attempt === 3 ? 1 : 0);
    }
    const ok = fakes();
    const result = await runExport(ok.deps, exp);
    expect(result.export).toMatchObject({ status: 'active', lastError: null });
    expect(result.export.exportedUntil?.toISOString()).toBe('2026-11-16T11:45:00.000Z');
  });

  it('does nothing while paused', async () => {
    const f = fakes();
    const result = await runExport(f.deps, await exportRow({ status: 'paused' }));
    expect(result.windows).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect((await db.select().from(panelExports).where(eq(panelExports.id, 'pnex_1')))[0]!.lastRunAt).toBeNull();
  });
});
