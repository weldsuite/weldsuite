/**
 * pglite-backed tests for the sync-run bookkeeping in `connections.ts`.
 *
 * These exist specifically because `finishSyncRun` writes raw SQL expressions
 * (`recordsSynced + n`, `jsonb || jsonb`) rather than values computed in JS.
 * That is the whole point — concurrent per-model sync webhooks must not lose
 * each other's counts or watermarks — but it also means a typo fails at
 * runtime, not at type-check. Only a real Postgres proves them.
 *
 * The DDL is inline because `nango_connections` / `nango_sync_runs` have no
 * migration file yet (pending approval per CLAUDE.md), so the pglite helper
 * cannot create them. `IF NOT EXISTS` makes this a no-op once the migration
 * lands and the helper applies it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { finishSyncRun, startSyncRun } from './connections';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

const DDL = `
CREATE TABLE IF NOT EXISTS nango_connections (
  id varchar(30) PRIMARY KEY,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp,
  provider_config_key varchar(100) NOT NULL,
  provider varchar(100) NOT NULL,
  nango_connection_id varchar(255),
  display_name varchar(255),
  status varchar(20) NOT NULL DEFAULT 'pending',
  scopes jsonb,
  external_account_id varchar(255),
  enabled_syncs jsonb,
  sync_watermarks jsonb,
  last_sync_at timestamp,
  last_sync_status varchar(20),
  last_error text,
  last_error_at timestamp,
  records_synced integer NOT NULL DEFAULT 0,
  connected_at timestamp,
  connected_by varchar(255),
  disconnected_at timestamp
);
CREATE TABLE IF NOT EXISTS nango_sync_runs (
  id varchar(30) PRIMARY KEY,
  created_at timestamp NOT NULL DEFAULT now(),
  connection_id varchar(30) NOT NULL REFERENCES nango_connections(id) ON DELETE CASCADE,
  sync_name varchar(100) NOT NULL,
  model varchar(100) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'running',
  trigger varchar(20) NOT NULL,
  sync_type varchar(20),
  records_added integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  records_deleted integer NOT NULL DEFAULT 0,
  records_created integer NOT NULL DEFAULT 0,
  records_modified integer NOT NULL DEFAULT 0,
  records_skipped integer NOT NULL DEFAULT 0,
  records_failed integer NOT NULL DEFAULT 0,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  duration_ms integer,
  error text,
  error_samples jsonb
);
`;

let connectionSeq = 0;

async function makeConnection(overrides: Record<string, unknown> = {}): Promise<string> {
  connectionSeq += 1;
  const id = `nconn_t${connectionSeq}`;
  await db.insert(schema.nangoConnections).values({
    id,
    providerConfigKey: `hubspot-${connectionSeq}`,
    provider: 'hubspot',
    status: 'active',
    ...overrides,
  });
  return id;
}

function readConnection(id: string) {
  return db
    .select()
    .from(schema.nangoConnections)
    .where(eq(schema.nangoConnections.id, id))
    .limit(1)
    .then((rows) => rows[0]!);
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  for (const statement of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }
}, 60_000);

describe('finishSyncRun · watermarks', () => {
  it('advances the watermark for the synced model on a clean run', async () => {
    const connectionId = await makeConnection();
    const runId = await startSyncRun({
      db, connectionId, syncName: 'hubspot-companies', model: 'HubspotCompany', trigger: 'webhook',
    });

    await finishSyncRun({
      db,
      runId,
      connectionId,
      status: 'success',
      applied: { created: 3, modified: 1, skipped: 0, deleted: 0, failed: 0 },
      watermark: { model: 'HubspotCompany', at: '2026-07-01T00:00:00Z' },
    });

    const row = await readConnection(connectionId);
    expect(row.syncWatermarks).toEqual({ HubspotCompany: '2026-07-01T00:00:00Z' });
    expect(row.recordsSynced).toBe(4);
    expect(row.status).toBe('active');
  });

  it('does NOT advance the watermark on a partial run — those records would be lost', async () => {
    const connectionId = await makeConnection();
    const runId = await startSyncRun({
      db, connectionId, syncName: 'hubspot-companies', model: 'HubspotCompany', trigger: 'webhook',
    });

    await finishSyncRun({
      db,
      runId,
      connectionId,
      status: 'partial',
      applied: { created: 1, modified: 0, skipped: 0, deleted: 0, failed: 2 },
      error: '2 record(s) failed to import',
      // Even though a caller asked for it.
      watermark: { model: 'HubspotCompany', at: '2026-07-01T00:00:00Z' },
    });

    const row = await readConnection(connectionId);
    expect(row.syncWatermarks ?? null).toBeNull();
  });

  it('does NOT advance the watermark on an errored run', async () => {
    const connectionId = await makeConnection();
    const runId = await startSyncRun({
      db, connectionId, syncName: 'hubspot-companies', model: 'HubspotCompany', trigger: 'webhook',
    });

    await finishSyncRun({
      db, runId, connectionId, status: 'error', error: 'boom',
      watermark: { model: 'HubspotCompany', at: '2026-07-01T00:00:00Z' },
    });

    const row = await readConnection(connectionId);
    expect(row.syncWatermarks ?? null).toBeNull();
    expect(row.status).toBe('sync_error');
  });

  it('merges a new model watermark without clobbering the others', async () => {
    const connectionId = await makeConnection({
      syncWatermarks: { HubspotCompany: '2026-06-01T00:00:00Z' },
    });
    const runId = await startSyncRun({
      db, connectionId, syncName: 'hubspot-contacts', model: 'HubspotContact', trigger: 'webhook',
    });

    await finishSyncRun({
      db, runId, connectionId, status: 'success',
      applied: { created: 1, modified: 0, skipped: 0, deleted: 0, failed: 0 },
      watermark: { model: 'HubspotContact', at: '2026-07-01T00:00:00Z' },
    });

    expect((await readConnection(connectionId)).syncWatermarks).toEqual({
      HubspotCompany: '2026-06-01T00:00:00Z',
      HubspotContact: '2026-07-01T00:00:00Z',
    });
  });
});

describe('finishSyncRun · concurrency', () => {
  it('keeps every count and watermark when per-model runs finish concurrently', async () => {
    const connectionId = await makeConnection();
    const models = ['HubspotCompany', 'HubspotContact', 'HubspotDeal'];

    const runIds = await Promise.all(
      models.map((model) =>
        startSyncRun({ db, connectionId, syncName: `sync-${model}`, model, trigger: 'webhook' }),
      ),
    );

    // Nango delivers one sync webhook per model and they land in parallel. A
    // JS-side read-modify-write here would lose two of the three watermarks and
    // most of the count.
    await Promise.all(
      runIds.map((runId, i) =>
        finishSyncRun({
          db,
          runId,
          connectionId,
          status: 'success',
          applied: { created: 10, modified: 0, skipped: 0, deleted: 0, failed: 0 },
          watermark: { model: models[i]!, at: `2026-07-0${i + 1}T00:00:00Z` },
        }),
      ),
    );

    const row = await readConnection(connectionId);
    expect(row.recordsSynced).toBe(30);
    expect(row.syncWatermarks).toEqual({
      HubspotCompany: '2026-07-01T00:00:00Z',
      HubspotContact: '2026-07-02T00:00:00Z',
      HubspotDeal: '2026-07-03T00:00:00Z',
    });
  });
});

describe('finishSyncRun · status', () => {
  it('does not downgrade an auth error into a sync error', async () => {
    const connectionId = await makeConnection({ status: 'auth_error' });
    const runId = await startSyncRun({
      db, connectionId, syncName: 'hubspot-companies', model: 'HubspotCompany', trigger: 'manual',
    });

    await finishSyncRun({
      db, runId, connectionId, status: 'success',
      applied: { created: 0, modified: 0, skipped: 0, deleted: 0, failed: 0 },
    });

    // Credentials are still broken — the tenant must reconnect regardless of
    // what this particular run reported.
    expect((await readConnection(connectionId)).status).toBe('auth_error');
  });

  it('records applied counts and the duration on the run row', async () => {
    const connectionId = await makeConnection();
    const runId = await startSyncRun({
      db, connectionId, syncName: 'hubspot-companies', model: 'HubspotCompany', trigger: 'manual',
    });

    await finishSyncRun({
      db, runId, connectionId, status: 'partial',
      reported: { added: 5, updated: 2, deleted: 1 },
      applied: { created: 4, modified: 2, skipped: 1, deleted: 1, failed: 1 },
      error: '1 record(s) failed to import',
      errorSamples: [{ externalId: 'hs-9', message: 'redacted' }],
    });

    const [run] = await db
      .select()
      .from(schema.nangoSyncRuns)
      .where(eq(schema.nangoSyncRuns.id, runId));

    expect(run).toMatchObject({
      status: 'partial',
      recordsAdded: 5,
      recordsCreated: 4,
      recordsFailed: 1,
    });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run?.errorSamples).toEqual([{ externalId: 'hs-9', message: 'redacted' }]);
  });
});
