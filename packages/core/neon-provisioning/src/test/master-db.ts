/**
 * Test helpers: a REAL master schema in-process (pglite), and a fake Neon API.
 *
 * The provisioning helpers' interesting logic is SQL against the master tables
 * (atomic shard / pool claims, the capacity counter), so the tests run it on a
 * real Postgres rather than a mocked query builder. Only the Neon REST API is
 * faked.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { ProvisioningMasterDb } from '../provisioning';

export interface MasterTestDb {
  db: ProvisioningMasterDb;
  /** Empty every table the provisioning code touches. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Build a pglite master database by replaying the journaled master migrations. */
export async function createMasterTestDb(): Promise<MasterTestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema: masterSchema });

  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/test → packages/core/db
  const migrationsDir = path.resolve(here, '../../../db/drizzle/master-migrations');
  const journal = JSON.parse(
    await readFile(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };

  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const raw = await readFile(path.join(migrationsDir, `${entry.tag}.sql`), 'utf8');
    const statements = raw
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        await client.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Same tolerance as the shared master helper in worker-kit: the journal
        // is not perfectly idempotent when replayed onto an empty database.
        if (/already exists/i.test(message) || /does not exist/i.test(message)) continue;
        throw new Error(`pglite failed on master migration ${entry.tag}: ${message}`);
      }
    }
  }

  return {
    db: db as unknown as ProvisioningMasterDb,
    reset: async () => {
      await client.exec('TRUNCATE database_pool, workspaces, neon_shared_projects, workspace_database_moves, admin_audit_events CASCADE');
    },
    close: () => client.close(),
  };
}
