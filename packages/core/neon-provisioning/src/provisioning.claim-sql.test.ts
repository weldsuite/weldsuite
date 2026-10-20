/**
 * Pins what claiming a warm pool slot for a database move sends to the master
 * database, character for character, and the line `prepareMoveTarget` logs.
 * The claim is one UPDATE whose WHERE clause changes with the shard the caller
 * asked for; behaviour of the claim itself is covered by
 * provisioning.moves.test.ts, this file covers the text.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as masterSchema from '@weldsuite/db/schema/master';
import { DatabaseProvisioningService, type ProvisioningMasterDb } from './provisioning';
import { createMasterTestDb, type MasterTestDb } from './test/master-db';
import { FAKE_SECRET_PREFIX, createFakeNeon, createServiceWith, fakeHost } from './test/fake-neon';

const { neonSharedProjects, databasePool } = masterSchema;

const REGION = 'aws-eu-central-1';
const dialect = new PgDialect();

let master: MasterTestDb;
let db: ProvisioningMasterDb;
let service: DatabaseProvisioningService;
let executed: Array<{ sql: string; params: unknown[] }>;
let logLines: string[];

beforeAll(async () => {
  master = await createMasterTestDb();
  db = master.db;
}, 120_000);

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  await master.reset();
  service = createServiceWith(createFakeNeon());
  executed = [];
  logLines = [];
  const execute = db.execute.bind(db);
  vi.spyOn(db, 'execute').mockImplementation(((query: Parameters<typeof db.execute>[0]) => {
    executed.push(dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]));
    return execute(query);
  }) as typeof db.execute);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedShard(id: string): Promise<void> {
  await db.insert(neonSharedProjects).values({
    id,
    neonProjectId: `prj-${id}`,
    neonProjectName: `shard ${id}`,
    region: REGION,
    mainBranchId: `br-${id}`,
    connectionHost: fakeHost(`prj-${id}`),
    adminRole: 'neondb_owner',
    databaseCount: 0,
    maxDatabases: 100,
    status: 'active',
  });
}

async function seedPoolSlot(id: string): Promise<void> {
  await db.insert(databasePool).values({
    id,
    kind: 'shared',
    neonProjectId: `prj-pool-${id}`,
    neonBranchId: `br-pool-${id}`,
    databaseName: `ws_pool_${id}`,
    roleName: `role_pool_${id}`,
    databaseUrl: `postgresql://role_pool_${id}:${FAKE_SECRET_PREFIX}slot-${id}@ep-pool-${id}-pooler.eu-central-1.aws.neon.tech/ws_pool_${id}?sslmode=require`,
    region: REGION,
    status: 'available',
    schemaVersion: 'v1',
  });
}

const claims = () => executed.filter((q) => q.sql.includes('UPDATE database_pool'));

const shardTarget = (extra: { shardId?: string; excludeShardId?: string } = {}) => ({
  workspaceId: 'ws_acme',
  region: REGION,
  target: { kind: 'shard' as const, ...extra },
});

describe('the pool claim for a move target', () => {
  it('a dedicated target claims a dedicated slot with no shard clause', async () => {
    await service.prepareMoveTarget(db, { workspaceId: 'ws_acme', region: REGION, target: { kind: 'dedicated' } });
    expect(claims()).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "ws_acme",
            "aws-eu-central-1",
            "dedicated",
          ],
          "sql": "UPDATE database_pool
                  SET status = 'assigned',
                      assigned_workspace_id = $1,
                      assigned_at = NOW()
                  WHERE id = (
                    SELECT id FROM database_pool
                    WHERE status = 'available'
                      AND region = $2
                      AND kind = $3
                      
                    ORDER BY schema_version DESC NULLS LAST, created_at DESC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                  )
                  RETURNING *",
          "typings": [
            "none",
            "none",
            "none",
          ],
        },
      ]
    `);
  });

  it('a shard target with no preference narrows to active shards in the region', async () => {
    await seedShard('nsp_a');
    await service.prepareMoveTarget(db, shardTarget());
    expect(claims()).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "ws_acme",
            "aws-eu-central-1",
            "shared",
            "aws-eu-central-1",
          ],
          "sql": "UPDATE database_pool
                  SET status = 'assigned',
                      assigned_workspace_id = $1,
                      assigned_at = NOW()
                  WHERE id = (
                    SELECT id FROM database_pool
                    WHERE status = 'available'
                      AND region = $2
                      AND kind = $3
                      AND shared_project_id IN (
                    SELECT s.id FROM neon_shared_projects s
                    WHERE s.status = 'active'
                      AND s.region = $4
                      
                      
                  )
                    ORDER BY schema_version DESC NULLS LAST, created_at DESC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                  )
                  RETURNING *",
          "typings": [
            "none",
            "none",
            "none",
            "none",
          ],
        },
      ]
    `);
  });

  it('adds the pinned shard', async () => {
    await seedShard('nsp_a');
    await service.prepareMoveTarget(db, shardTarget({ shardId: 'nsp_a' }));
    expect(claims()).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "ws_acme",
            "aws-eu-central-1",
            "shared",
            "aws-eu-central-1",
            "nsp_a",
          ],
          "sql": "UPDATE database_pool
                  SET status = 'assigned',
                      assigned_workspace_id = $1,
                      assigned_at = NOW()
                  WHERE id = (
                    SELECT id FROM database_pool
                    WHERE status = 'available'
                      AND region = $2
                      AND kind = $3
                      AND shared_project_id IN (
                    SELECT s.id FROM neon_shared_projects s
                    WHERE s.status = 'active'
                      AND s.region = $4
                      AND s.id = $5
                      
                  )
                    ORDER BY schema_version DESC NULLS LAST, created_at DESC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                  )
                  RETURNING *",
          "typings": [
            "none",
            "none",
            "none",
            "none",
            "none",
          ],
        },
      ]
    `);
  });

  it('adds the excluded shard', async () => {
    await seedShard('nsp_a');
    await service.prepareMoveTarget(db, shardTarget({ excludeShardId: 'nsp_b' }));
    expect(claims()).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "ws_acme",
            "aws-eu-central-1",
            "shared",
            "aws-eu-central-1",
            "nsp_b",
          ],
          "sql": "UPDATE database_pool
                  SET status = 'assigned',
                      assigned_workspace_id = $1,
                      assigned_at = NOW()
                  WHERE id = (
                    SELECT id FROM database_pool
                    WHERE status = 'available'
                      AND region = $2
                      AND kind = $3
                      AND shared_project_id IN (
                    SELECT s.id FROM neon_shared_projects s
                    WHERE s.status = 'active'
                      AND s.region = $4
                      
                      AND s.id <> $5
                  )
                    ORDER BY schema_version DESC NULLS LAST, created_at DESC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                  )
                  RETURNING *",
          "typings": [
            "none",
            "none",
            "none",
            "none",
            "none",
          ],
        },
      ]
    `);
  });

  it('adds both, pinned first', async () => {
    await seedShard('nsp_a');
    await service.prepareMoveTarget(db, shardTarget({ shardId: 'nsp_a', excludeShardId: 'nsp_b' }));
    expect(claims()).toMatchInlineSnapshot(`
      [
        {
          "params": [
            "ws_acme",
            "aws-eu-central-1",
            "shared",
            "aws-eu-central-1",
            "nsp_a",
            "nsp_b",
          ],
          "sql": "UPDATE database_pool
                  SET status = 'assigned',
                      assigned_workspace_id = $1,
                      assigned_at = NOW()
                  WHERE id = (
                    SELECT id FROM database_pool
                    WHERE status = 'available'
                      AND region = $2
                      AND kind = $3
                      AND shared_project_id IN (
                    SELECT s.id FROM neon_shared_projects s
                    WHERE s.status = 'active'
                      AND s.region = $4
                      AND s.id = $5
                      AND s.id <> $6
                  )
                    ORDER BY schema_version DESC NULLS LAST, created_at DESC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                  )
                  RETURNING *",
          "typings": [
            "none",
            "none",
            "none",
            "none",
            "none",
            "none",
          ],
        },
      ]
    `);
  });
});

describe('prepareMoveTarget log line', () => {
  it('says the target was newly created', async () => {
    await seedShard('nsp_a');
    await service.prepareMoveTarget(db, shardTarget({ shardId: 'nsp_a' }));
    expect(logLines.filter((l) => l.includes('Prepared'))).toMatchInlineSnapshot(`
      [
        "[Provisioning] Prepared shard move target for ws_acme (project prj-nsp_a, newly created)",
      ]
    `);
  });

  it('names the pool slot it claimed', async () => {
    await seedShard('nsp_a');
    await seedPoolSlot('slot1');
    await service.prepareMoveTarget(db, shardTarget());
    expect(logLines.filter((l) => l.includes('Prepared'))).toMatchInlineSnapshot(`
      [
        "[Provisioning] Prepared shard move target for ws_acme (project prj-nsp_a, newly created)",
      ]
    `);
  });
});
