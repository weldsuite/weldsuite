/**
 * applyTenantMigrations on real Postgres (PGlite), where a transaction really
 * rolls back: a migration that dies midway leaves none of itself behind and
 * goes unrecorded, and the retry applies it whole. Before migrations were
 * applied atomically, such a retry failed on the migration's first statement
 * (42P07) on every run, forever.
 *
 * pglite crashes when many instances start at once, so the databases here are
 * created one after the other.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createPgliteTenant, pgliteTenantSql, type PgliteTenant } from '../test/pglite-tenant-sql';
import type { SqlRow, TenantSql } from './database-move/types';

const bundle = vi.hoisted(() => ({
  MIGRATION_JOURNAL: [] as Array<{ idx: number; tag: string; when: number }>,
  MIGRATION_SQL: {} as Record<string, string>,
  MIGRATION_HASHES: {} as Record<string, string>,
}));
vi.mock('../generated/tenant-migrations', () => bundle);

import { applyTenantMigrations, TenantMigrationError } from './tenant-migrations';

vi.setConfig({ testTimeout: 120_000 });

/** Replace the bundled journal with these migrations, in this order. */
function useJournal(migrations: ReadonlyArray<readonly [tag: string, sql: string]>): void {
  bundle.MIGRATION_JOURNAL.splice(0, bundle.MIGRATION_JOURNAL.length);
  for (const key of Object.keys(bundle.MIGRATION_SQL)) delete bundle.MIGRATION_SQL[key];
  for (const key of Object.keys(bundle.MIGRATION_HASHES)) delete bundle.MIGRATION_HASHES[key];
  for (const [idx, [tag, sql]] of migrations.entries()) {
    bundle.MIGRATION_JOURNAL.push({ idx, tag, when: 1_700_000_000_000 + idx });
    bundle.MIGRATION_SQL[tag] = sql;
    bundle.MIGRATION_HASHES[tag] = createHash('sha256').update(sql).digest('hex');
  }
}

const PRODUCTS = `CREATE TYPE "public"."product_status" AS ENUM('draft', 'active');--> statement-breakpoint
CREATE TABLE "products" ("id" varchar(30) PRIMARY KEY NOT NULL, "status" "product_status" DEFAULT 'draft' NOT NULL);`;
// ALTER TYPE ... ADD VALUE runs inside the migration's transaction (PostgreSQL 12+).
const ARCHIVED = `ALTER TYPE "public"."product_status" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "archived_at" timestamp;`;
// Shaped like 0165_overjoyed_hellion, the migration two production pool slots were stuck on.
const VARIANTS = `CREATE TABLE "product_variants" ("id" varchar(30) PRIMARY KEY NOT NULL, "product_id" varchar(30) NOT NULL);--> statement-breakpoint
CREATE TABLE "discounts" ("id" varchar(30) PRIMARY KEY NOT NULL, "code" varchar(50) NOT NULL);--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");`;

const FIXTURE = [
  ['0000_products', PRODUCTS],
  ['0001_archived', ARCHIVED],
  ['0002_variants', VARIANTS],
] as const;

/**
 * The tenant's `TenantSql`, except that a transaction dies right before the
 * statement starting with `text`, as when a step attempt is cut off or Neon
 * drops the connection mid-request. PGlite rolls the transaction back.
 */
function dyingBefore(db: PGlite, text: string, error: Error): TenantSql {
  return {
    ...pgliteTenantSql(db),
    transaction(statements) {
      return db.transaction(async (tx) => {
        const results: SqlRow[][] = [];
        for (const statement of statements) {
          if (statement.text.startsWith(text)) throw error;
          results.push((await tx.query<SqlRow>(statement.text, statement.params ? [...statement.params] : [])).rows);
        }
        return results;
      });
    },
  };
}

async function tablesOf(db: PGlite): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations' ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

async function recordedTags(db: PGlite): Promise<string[]> {
  const result = await db.query<{ tag: string }>(`SELECT tag FROM "__drizzle_migrations" ORDER BY id`);
  return result.rows.map((row) => row.tag);
}

let tenant: PgliteTenant | null = null;

afterEach(async () => {
  await tenant?.close();
  tenant = null;
});

describe('applyTenantMigrations on Postgres', () => {
  it('leaves nothing of a migration that dies midway, and the retry applies it whole', async () => {
    tenant = await createPgliteTenant();
    useJournal(FIXTURE);
    const dropped = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

    const error = await applyTenantMigrations(
      dyingBefore(tenant.db, 'CREATE INDEX "product_variants_product_idx"', dropped),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TenantMigrationError);
    expect(error).toMatchObject({ tag: '0002_variants', statements: 4, sqlState: '57P01' });
    // Its first two statements ran, and were rolled back with the rest.
    expect(await tablesOf(tenant.db)).toEqual(['products']);
    expect(await recordedTags(tenant.db)).toEqual(['0000_products', '0001_archived']);

    expect(await applyTenantMigrations(tenant.sql)).toEqual({ applied: 1, skipped: 2, remaining: 0 });
    expect(await tablesOf(tenant.db)).toEqual(['discounts', 'product_variants', 'products']);
    expect(await recordedTags(tenant.db)).toEqual(['0000_products', '0001_archived', '0002_variants']);
    // The value 0001 added (inside its transaction) is usable once that committed.
    await tenant.db.query(`INSERT INTO products (id, status) VALUES ('p1', 'archived')`);
  });

  it('rolls back a migration Postgres rejects, naming its SQLSTATE, and keeps the ones before it', async () => {
    tenant = await createPgliteTenant();
    useJournal([
      ...FIXTURE.slice(0, 2),
      ['0002_variants', VARIANTS.replace('"public"."products"("id")', '"public"."missing"("id")')],
    ]);

    const error = await applyTenantMigrations(tenant.sql).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TenantMigrationError);
    expect(error).toMatchObject({ tag: '0002_variants', sqlState: '42P01', statement: null });
    expect(await tablesOf(tenant.db)).toEqual(['products']);
    expect(await recordedTags(tenant.db)).toEqual(['0000_products', '0001_archived']);
  });

  it('applies the whole tenant journal, each migration in a transaction of its own', async () => {
    const dir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../packages/core/db/drizzle/tenant-migrations',
    );
    const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    useJournal(journal.entries.map(({ tag }) => [tag, readFileSync(path.join(dir, `${tag}.sql`), 'utf8').trim()] as const));
    tenant = await createPgliteTenant();

    expect(await applyTenantMigrations(tenant.sql)).toEqual({
      applied: journal.entries.length,
      skipped: 0,
      remaining: 0,
    });
    expect(await applyTenantMigrations(tenant.sql)).toEqual({
      applied: 0,
      skipped: journal.entries.length,
      remaining: 0,
    });
  });
});
