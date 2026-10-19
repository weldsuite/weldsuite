/**
 * Pins the exact SQL text the move engine sends: what it asks the catalog
 * about the migrations journal, what it runs to prepare and finish a target
 * and what it runs to count and checksum tables. The text is the contract with
 * the database, so a refactor of the code that builds it must leave every
 * character where it is. Runs against PGlite like database-move.pglite.test.ts,
 * and for the same reason in one file with one pair of databases.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteTenant, type PgliteTenant } from '../../test/pglite-tenant-sql';
import { createFixturePair } from '../../test/move-fixture';
import {
  finishTarget,
  prepareTargetForCopy,
  readCatalog,
  readJournalSummary,
  restoreForeignKeys,
  tableChecksums,
  type SqlParam,
  type SqlStatement,
  type TenantSql,
} from './index';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

interface Recorded {
  queries: Array<{ text: string; params: readonly SqlParam[] | undefined }>;
  transactions: SqlStatement[][];
}

/** A `TenantSql` that forwards to `inner` and remembers what it was asked. */
function recording(inner: TenantSql): { sql: TenantSql; log: Recorded } {
  const log: Recorded = { queries: [], transactions: [] };
  const sql: TenantSql = {
    query(text, params) {
      log.queries.push({ text, params });
      return inner.query(text, params);
    },
    transaction(statements) {
      log.transactions.push(statements.map((s) => ({ ...s })));
      return inner.transaction(statements);
    },
  };
  return { sql, log };
}

const texts = (statements: readonly SqlStatement[]): string[] => statements.map((s) => s.text);

let source: PgliteTenant;
let target: PgliteTenant;

beforeAll(async () => {
  ({ source, target } = await createFixturePair(createPgliteTenant));
});

afterAll(async () => {
  await source.close();
  await target.close();
});

describe('readJournalSummary', () => {
  it('asks to_regclass about public and drizzle, then summarises the public journal', async () => {
    const { sql, log } = recording(source.sql);
    expect(await readJournalSummary(sql)).toEqual({ schema: 'public', count: 2, maxCreatedAt: '1700000100000' });
    expect(log.queries.map((q) => q.text)).toMatchInlineSnapshot(`
      [
        "
          SELECT
            (to_regclass('"public"."__drizzle_migrations"') IS NOT NULL) AS in_public,
            (to_regclass('"drizzle"."__drizzle_migrations"') IS NOT NULL) AS in_drizzle",
        "SELECT count(*)::text AS count, max(created_at)::text AS max_created_at
           FROM "public"."__drizzle_migrations"",
      ]
    `);
  });

  it('falls back to the drizzle schema, and gives null when there is no journal at all', async () => {
    await target.exec(`
      DROP TABLE __drizzle_migrations;
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('h', 5);
    `);
    const inDrizzle = recording(target.sql);
    expect(await readJournalSummary(inDrizzle.sql)).toEqual({ schema: 'drizzle', count: 1, maxCreatedAt: '5' });
    expect(inDrizzle.log.queries.map((q) => q.text.trim().split('\n')[0])).toMatchInlineSnapshot(`
      [
        "SELECT",
        "SELECT count(*)::text AS count, max(created_at)::text AS max_created_at",
      ]
    `);
    expect(inDrizzle.log.queries[1]?.text).toMatchInlineSnapshot(`
      "SELECT count(*)::text AS count, max(created_at)::text AS max_created_at
           FROM "drizzle"."__drizzle_migrations""
    `);

    await target.exec('DROP TABLE drizzle.__drizzle_migrations');
    const none = recording(target.sql);
    expect(await readJournalSummary(none.sql)).toBeNull();
    expect(none.log.queries).toHaveLength(1);

    // Put the fixture back for the tests below.
    await target.exec(`
      CREATE TABLE __drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, tag text);
      INSERT INTO __drizzle_migrations (hash, created_at, tag) VALUES
        ('hash-0', 1700000000000, '0000_init'),
        ('hash-1', 1700000100000, '0001_more');
    `);
  });
});

describe('tableChecksums', () => {
  it('counts every table in one UNION ALL and hashes the non-empty ones in another', async () => {
    const catalog = await readCatalog(source.sql);
    const { sql, log } = recording(source.sql);
    const checksums = await tableChecksums(sql, catalog.tables);
    expect(Object.keys(checksums)).toHaveLength(catalog.tables.length);
    expect(log.queries.map((q) => q.text)).toMatchInlineSnapshot(`
      [
        "SELECT 'accounts' AS t, count(*)::text AS n FROM "public"."accounts"
      UNION ALL
      SELECT 'correspondents' AS t, count(*)::text AS n FROM "public"."correspondents"
      UNION ALL
      SELECT 'embeddings' AS t, count(*)::text AS n FROM "public"."embeddings"
      UNION ALL
      SELECT 'empty_table' AS t, count(*)::text AS n FROM "public"."empty_table"
      UNION ALL
      SELECT 'folders' AS t, count(*)::text AS n FROM "public"."folders"
      UNION ALL
      SELECT 'messages' AS t, count(*)::text AS n FROM "public"."messages"
      UNION ALL
      SELECT 'order_lines' AS t, count(*)::text AS n FROM "public"."order_lines"
      UNION ALL
      SELECT 'orders' AS t, count(*)::text AS n FROM "public"."orders"
      UNION ALL
      SELECT 'seeded_defaults' AS t, count(*)::text AS n FROM "public"."seeded_defaults"",
      ]
    `);
    const [hashTransaction] = log.transactions;
    expect(texts(hashTransaction ?? []).slice(5)).toMatchInlineSnapshot(`
      [
        "SELECT 'accounts' AS t, coalesce(sum(hashtextextended(ROW(r."id", r."name", r."balance", r."ratio", r."big", r."status", r."settings", r."payload", r."tags", r."created_at", r."note")::text, 0)), 0)::text AS h FROM "public"."accounts" r
      UNION ALL
      SELECT 'correspondents' AS t, coalesce(sum(hashtextextended(ROW(r."email", r."message_count")::text, 0)), 0)::text AS h FROM "public"."correspondents" r
      UNION ALL
      SELECT 'embeddings' AS t, coalesce(sum(hashtextextended(ROW(r."id", r."label", r."embedding")::text, 0)), 0)::text AS h FROM "public"."embeddings" r
      UNION ALL
      SELECT 'folders' AS t, coalesce(sum(hashtextextended(ROW(r."id", r."parent_id", r."name")::text, 0)), 0)::text AS h FROM "public"."folders" r
      UNION ALL
      SELECT 'messages' AS t, coalesce(sum(hashtextextended(ROW(r."id", r."from_email", r."direction")::text, 0)), 0)::text AS h FROM "public"."messages" r
      UNION ALL
      SELECT 'order_lines' AS t, coalesce(sum(hashtextextended(ROW(r."order_id", r."line_no", r."sku", r."qty")::text, 0)), 0)::text AS h FROM "public"."order_lines" r
      UNION ALL
      SELECT 'orders' AS t, coalesce(sum(hashtextextended(ROW(r."id", r."account_id", r."total", r."placed_at", r."meta")::text, 0)), 0)::text AS h FROM "public"."orders" r
      UNION ALL
      SELECT 'seeded_defaults' AS t, coalesce(sum(hashtextextended(ROW(r."id", r."label")::text, 0)), 0)::text AS h FROM "public"."seeded_defaults" r",
      ]
    `);
  });
});

describe('prepareTargetForCopy and finishTarget', () => {
  it('prepare runs one transaction: lock timeout, drop keys, truncate, disable triggers', async () => {
    const catalog = await readCatalog(source.sql);
    const { sql, log } = recording(target.sql);
    await prepareTargetForCopy(sql, catalog);
    expect(log.transactions).toHaveLength(1);
    expect(log.transactions[0]).toMatchInlineSnapshot(`
      [
        {
          "text": "SET LOCAL lock_timeout = '30s'",
        },
        {
          "text": "ALTER TABLE IF EXISTS "public"."folders" DROP CONSTRAINT IF EXISTS "folders_parent_fk"",
        },
        {
          "text": "ALTER TABLE IF EXISTS "public"."order_lines" DROP CONSTRAINT IF EXISTS "order_lines_order_fk"",
        },
        {
          "text": "ALTER TABLE IF EXISTS "public"."orders" DROP CONSTRAINT IF EXISTS "orders_account_fk"",
        },
        {
          "text": "TRUNCATE TABLE "public"."accounts", "public"."correspondents", "public"."embeddings", "public"."empty_table", "public"."folders", "public"."messages", "public"."order_lines", "public"."orders", "public"."seeded_defaults"",
        },
        {
          "text": "ALTER TABLE IF EXISTS "public"."messages" DISABLE TRIGGER USER",
        },
      ]
    `);
  });

  it('finish re-enables triggers, adds and validates the keys, refreshes the views', async () => {
    const catalog = await readCatalog(source.sql);
    const prepared = await prepareTargetForCopy(target.sql, catalog);
    const { sql, log } = recording(target.sql);
    await finishTarget(sql, prepared.saved, catalog);
    expect(log.transactions).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "ALTER TABLE "public"."messages" ENABLE TRIGGER "messages_track_inbound"",
          },
        ],
        [
          {
            "text": "ALTER TABLE "public"."folders" ADD CONSTRAINT "folders_parent_fk" FOREIGN KEY (parent_id) REFERENCES folders(id) NOT VALID",
          },
          {
            "text": "ALTER TABLE "public"."folders" VALIDATE CONSTRAINT "folders_parent_fk"",
          },
        ],
        [
          {
            "text": "ALTER TABLE "public"."order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY (order_id) REFERENCES orders(id) NOT VALID",
          },
          {
            "text": "ALTER TABLE "public"."order_lines" VALIDATE CONSTRAINT "order_lines_order_fk"",
          },
        ],
        [
          {
            "text": "ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_account_fk" FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID",
          },
          {
            "text": "ALTER TABLE "public"."orders" VALIDATE CONSTRAINT "orders_account_fk"",
          },
        ],
      ]
    `);
    expect(log.queries.map((q) => q.text).filter((t) => t.startsWith('REFRESH'))).toMatchInlineSnapshot(`
      [
        "REFRESH MATERIALIZED VIEW "public"."account_names" WITH NO DATA",
        "REFRESH MATERIALIZED VIEW "public"."account_totals"",
      ]
    `);
  });

  it('a key that was NOT VALID on the source is re-added NOT VALID, once, and never validated', async () => {
    await source.exec(`
      ALTER TABLE orders DROP CONSTRAINT orders_account_fk;
      ALTER TABLE orders ADD CONSTRAINT orders_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
    `);
    const catalog = await readCatalog(source.sql);
    const prepared = await prepareTargetForCopy(target.sql, catalog);
    const { sql, log } = recording(target.sql);
    await restoreForeignKeys(sql, prepared.saved);
    expect(log.transactions.map(texts)).toMatchInlineSnapshot(`
      [
        [
          "ALTER TABLE "public"."folders" ADD CONSTRAINT "folders_parent_fk" FOREIGN KEY (parent_id) REFERENCES folders(id) NOT VALID",
          "ALTER TABLE "public"."folders" VALIDATE CONSTRAINT "folders_parent_fk"",
        ],
        [
          "ALTER TABLE "public"."order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY (order_id) REFERENCES orders(id) NOT VALID",
          "ALTER TABLE "public"."order_lines" VALIDATE CONSTRAINT "order_lines_order_fk"",
        ],
        [
          "ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_account_fk" FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID",
        ],
      ]
    `);
  });
});
