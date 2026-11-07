/**
 * The data migration `0244_weldmerge_adopt_github` (WeldFlow and WeldConnect
 * move from github_connections to merge_connections): run against rows as they
 * stand before it. What must not regress:
 *   1. Every github_connections row is copied into merge_connections with its
 *      own id, the installation id as the external account id, and its webhook
 *      secret, app slug, scopes and lifecycle timestamps.
 *   2. A live installation WeldMerge adopted in phase 1 (another id) is not
 *      duplicated: it keeps its id and gains the GitHub App fields.
 *   3. Running it twice changes nothing more.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { openDb, resetTables } from './helpers';
import { seedConnection } from './seed';

const MIGRATION = new URL(
  '../../../../../packages/core/db/drizzle/tenant-migrations/0244_weldmerge_adopt_github.sql',
  import.meta.url,
);

let db: Database;

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

const FOREIGN_KEYS = new URL(
  '../../../../../packages/core/db/drizzle/tenant-migrations/0245_weldmerge_github_fk.sql',
  import.meta.url,
);

async function runStatements(text: string) {
  const statements = text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

async function runMigration() {
  await runStatements(readFileSync(fileURLToPath(MIGRATION.href), 'utf8'));
}

const githubRow = (id: string, installationId: number, extra: Partial<typeof schema.githubConnections.$inferInsert> = {}) => ({
  id,
  workspaceId: 'org_alpha',
  installationId,
  appSlug: 'weldsuite',
  ownerType: 'org' as const,
  ownerLogin: `owner-${installationId}`,
  createdBy: 'user_alice',
  ...extra,
});

describe('0244_weldmerge_adopt_github', () => {
  it('copies github_connections into merge_connections keeping ids, and adopts a phase 1 row in place', async () => {
    const installedAt = new Date('2026-10-01T10:00:00Z');
    await db.insert(schema.githubConnections).values([
      githubRow('ghc_new', 1001, { webhookSecret: 'v2:sealed', scopes: ['contents:read'], installedAt, ownerType: 'user' }),
      githubRow('ghc_adopted', 4242, { webhookSecret: 'v2:sealed-4242', status: 'suspended' }),
      githubRow('ghc_gone', 1002, { deletedAt: new Date('2026-10-02T00:00:00Z'), status: 'revoked' }),
    ]);
    // WeldMerge adopted installation 4242 in phase 1, with its own id.
    const adopted = await seedConnection(db, { externalAccountId: '4242' });

    await runMigration();

    const rows = await db.select().from(schema.mergeConnections);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(rows).toHaveLength(3);
    expect(byId.get('ghc_new')).toMatchObject({
      provider: 'github',
      externalAccountId: '1001',
      accountLogin: 'owner-1001',
      accountType: 'user',
      status: 'active',
      webhookSecret: 'v2:sealed',
      appSlug: 'weldsuite',
      scopes: ['contents:read'],
      createdByUserId: 'user_alice',
      deletedAt: null,
    });
    expect(byId.get('ghc_new')!.installedAt?.toISOString()).toBe(installedAt.toISOString());
    expect(byId.get('ghc_gone')).toMatchObject({ externalAccountId: '1002', status: 'revoked' });
    expect(byId.get('ghc_gone')!.deletedAt).toBeInstanceOf(Date);

    // The phase 1 row keeps its id and gains the App fields; no second row for the installation.
    expect(byId.has('ghc_adopted')).toBe(false);
    expect(byId.get(adopted.id)).toMatchObject({ webhookSecret: 'v2:sealed-4242', appSlug: 'weldsuite' });

    await runMigration();
    expect(await db.select().from(schema.mergeConnections)).toHaveLength(3);
  });

  it('repoints links on an adopted installation while their keys still name github_connections', async () => {
    // As before 0245: the links' keys reference github_connections, not merge_connections.
    await runStatements(`
      ALTER TABLE "github_repo_links" DROP CONSTRAINT IF EXISTS "github_repo_links_connection_id_merge_connections_id_fk";--> statement-breakpoint
      ALTER TABLE "github_project_links" DROP CONSTRAINT IF EXISTS "github_project_links_connection_id_merge_connections_id_fk";--> statement-breakpoint
      ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade;--> statement-breakpoint
      ALTER TABLE "github_project_links" ADD CONSTRAINT "github_project_links_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade;
    `);
    try {
      await db.insert(schema.githubConnections).values(githubRow('ghc_adopted', 4242));
      const adopted = await seedConnection(db, { externalAccountId: '4242' });
      await db.insert(schema.githubRepoLinks).values({
        id: 'grl_1',
        connectionId: 'ghc_adopted',
        workspaceId: 'org_alpha',
        repoId: 501,
        repoFullName: 'acme/api',
      });

      await runMigration();

      const [link] = await db.select().from(schema.githubRepoLinks);
      expect(link!.connectionId).toBe(adopted.id);
    } finally {
      await db.delete(schema.githubRepoLinks);
      // 0245 puts the keys back on merge_connections, whichever are left.
      await runStatements(readFileSync(fileURLToPath(FOREIGN_KEYS.href), 'utf8'));
    }
  });
});
