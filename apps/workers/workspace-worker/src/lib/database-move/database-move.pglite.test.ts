/**
 * The move engine against two real (in-process) Postgres databases. All
 * PGlite-backed tests live in this one file and run sequentially: pglite
 * crashes when many instances start at once, and every test here builds its own
 * source and target pair.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteTenant, type PgliteTenant } from '../../test/pglite-tenant-sql';
import { FIXTURE_ACCOUNT_COUNT, FIXTURE_SCHEMA_SQL, createFixturePair } from '../../test/move-fixture';
import {
  ForeignKeyValidationError,
  InvalidCursorError,
  JournalMismatchError,
  SchemaMismatchError,
  UnsupportedSchemaError,
  census,
  compareChecksums,
  copyTable,
  copyTablePage,
  finishTarget,
  planCopy,
  prepareTargetForCopy,
  readCatalog,
  readTables,
  restoreForeignKeys,
  sourceUnchanged,
  tableChecksums,
  type Catalog,
  type TableInfo,
} from './index';

// Every test boots two PGlite instances (~0.7 s each locally); leave room for a slow CI runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let source: PgliteTenant;
let target: PgliteTenant;

beforeEach(async () => {
  ({ source, target } = await createFixturePair(createPgliteTenant));
});

afterEach(async () => {
  await source.close();
  await target.close();
});

function requireTable(catalog: Catalog, name: string): TableInfo {
  const table = catalog.tables.find((t) => t.name === name);
  if (!table) throw new Error(`fixture table ${name} missing from the catalog`);
  return table;
}

async function scalar(db: PgliteTenant, text: string): Promise<string> {
  const rows = await db.sql.query(text);
  const first = rows[0];
  if (!first) throw new Error('no row');
  const value = Object.values(first)[0];
  return String(value);
}

/** prepare -> census -> plan -> copy every planned table to the end. Returns what finishTarget needs. */
async function copyEverything(options: { pageSize?: number; maxPageBytes?: number } = {}) {
  const catalog = await readCatalog(source.sql);
  const prepared = await prepareTargetForCopy(target.sql, catalog);
  const nonEmpty = await census(source.sql, catalog.tables);
  const plan = planCopy(catalog, nonEmpty);
  let pages = 0;
  for (const planned of plan.tables) {
    const result = await copyTable(source.sql, target.sql, requireTable(catalog, planned.name), null, {
      pageSize: options.pageSize ?? planned.pageSize,
      maxPageBytes: options.maxPageBytes,
      maxPages: 10_000,
    });
    expect(result.done).toBe(true);
    pages += result.pages;
  }
  return { catalog, prepared, plan, pages };
}

async function compareAll(catalog: Catalog, hashLimitRows?: number) {
  const from = await tableChecksums(source.sql, catalog.tables, { hashLimitRows });
  const to = await tableChecksums(target.sql, catalog.tables, { hashLimitRows });
  return compareChecksums(from, to);
}

describe('readCatalog', () => {
  it('re-derives tables, keys, columns, constraints, triggers, views and the journal', async () => {
    const catalog = await readCatalog(source.sql);

    // Tables only: no materialized views, no journal.
    expect(catalog.tables.map((t) => t.name)).toEqual([
      'accounts',
      'correspondents',
      'embeddings',
      'empty_table',
      'folders',
      'messages',
      'order_lines',
      'orders',
      'seeded_defaults',
    ]);

    expect(requireTable(catalog, 'correspondents').primaryKey).toEqual(['email']);
    expect(requireTable(catalog, 'order_lines').primaryKey).toEqual(['order_id', 'line_no']);

    const accounts = requireTable(catalog, 'accounts');
    expect(accounts.columns.find((c) => c.name === 'settings')).toEqual({ name: 'settings', type: 'jsonb', json: true });
    expect(accounts.columns.find((c) => c.name === 'name')).toEqual({ name: 'name', type: 'text', json: false });
    expect(accounts.columns.find((c) => c.name === 'balance')?.type).toBe('numeric(20,6)');
    expect(accounts.columns.find((c) => c.name === 'id')?.type).toBe('character varying(30)');
    expect(accounts.avgRowBytes).toBeGreaterThan(0);

    expect(catalog.foreignKeys.map((f) => `${f.table}.${f.name}`)).toEqual([
      'folders.folders_parent_fk',
      'order_lines.order_lines_order_fk',
      'orders.orders_account_fk',
    ]);
    expect(catalog.foreignKeys.every((f) => f.validated)).toBe(true);
    expect(catalog.foreignKeys[2]?.definition).toContain('ON DELETE CASCADE');

    expect(catalog.triggers).toEqual([
      { table: 'messages', name: 'messages_audit_noop', enabled: 'D' },
      { table: 'messages', name: 'messages_track_inbound', enabled: 'O' },
    ]);
    expect(catalog.materializedViews).toEqual([
      { name: 'account_names', populated: false },
      { name: 'account_totals', populated: true },
    ]);
    expect(catalog.sequences).toEqual([]); // the journal's own serial does not count
    expect(catalog.journal).toEqual({ schema: 'public', count: 2, maxCreatedAt: '1700000100000' });
  });

  it('reads a slice of the tables by name', async () => {
    const whole = await readCatalog(source.sql);
    const slice = await readTables(source.sql, ['orders', 'accounts', 'no_such_table']);
    expect(slice).toEqual(whole.tables.filter((t) => t.name === 'accounts' || t.name === 'orders'));
    expect(await readTables(source.sql, [])).toEqual([]);
    // Names are data, not SQL.
    expect(await readTables(source.sql, [`accounts'); DROP TABLE accounts; --`])).toEqual([]);
    expect(await scalar(source, 'SELECT count(*) FROM accounts')).toBe(String(FIXTURE_ACCOUNT_COUNT));
  });

  it('is plain JSON, so a Workflow can persist it between steps', async () => {
    const catalog = await readCatalog(source.sql);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });

  it('reports serial/identity columns as sequences', async () => {
    await source.exec('CREATE TABLE counters (id serial PRIMARY KEY, label text)');
    const catalog = await readCatalog(source.sql);
    expect(catalog.sequences).toEqual(['counters_id_seq']);
  });

  it('finds the journal in the drizzle schema when it is not in public', async () => {
    await source.exec(`
      CREATE SCHEMA drizzle;
      ALTER TABLE public.__drizzle_migrations SET SCHEMA drizzle;
    `);
    const catalog = await readCatalog(source.sql);
    expect(catalog.journal).toEqual({ schema: 'drizzle', count: 2, maxCreatedAt: '1700000100000' });
  });
});

describe('census and planCopy', () => {
  it('finds non-empty tables in one query and orders them smallest first', async () => {
    const catalog = await readCatalog(source.sql);
    const nonEmpty = await census(source.sql, catalog.tables);
    expect([...nonEmpty].sort()).toEqual([
      'accounts',
      'correspondents',
      'embeddings',
      'folders',
      'messages',
      'order_lines',
      'orders',
      'seeded_defaults',
    ]);

    const plan = planCopy(catalog, nonEmpty);
    expect(plan.skippedEmpty).toBe(1); // empty_table
    expect(plan.tables.map((t) => t.name)).not.toContain('empty_table');
    expect(plan.tables.every((t) => t.pageSize >= 50 && t.pageSize <= 5000)).toBe(true);

    // Estimated sizes (rows x width) never decrease along the plan.
    const byName = new Map(catalog.tables.map((t) => [t.name, t]));
    const sizes = plan.tables.map((p) => {
      const t = byName.get(p.name);
      return (t?.estimatedRows ?? 0) * (t?.avgRowBytes ?? 0);
    });
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });
});

describe('full move', () => {
  it('copies every table so that count and checksum match the source', async () => {
    const catalog = await readCatalog(source.sql);
    const persisted: Catalog = JSON.parse(JSON.stringify(catalog));
    const prepared = await prepareTargetForCopy(target.sql, persisted);
    const plan = planCopy(persisted, await census(source.sql, persisted.tables));
    for (const planned of plan.tables) {
      // A small page forces several pages per table, composite keys included.
      const result = await copyTable(source.sql, target.sql, requireTable(persisted, planned.name), null, {
        pageSize: 7,
        maxPages: 10_000,
      });
      expect(result.done).toBe(true);
    }

    const finished = await finishTarget(target.sql, JSON.parse(JSON.stringify(prepared.saved)), persisted);
    expect(finished.complete).toBe(true);

    const comparison = await compareAll(catalog);
    expect(comparison.mismatched).toEqual([]);
    expect(comparison.ok).toBe(true);
    // Everything was hashed, nothing merely counted.
    expect(comparison.tables.every((t) => t.hashCompared)).toBe(true);
    expect(comparison.tables.find((t) => t.table === 'accounts')?.source?.count).toBe(FIXTURE_ACCOUNT_COUNT);
  });

  it('keeps values exact: numerics, jsonb scalars and nulls, timestamps, text', async () => {
    const { catalog, prepared } = await copyEverything({ pageSize: 25 });
    await finishTarget(target.sql, prepared.saved, catalog);

    const pick = (db: PgliteTenant, id: string) =>
      db.sql.query(
        `SELECT balance::text AS balance, ratio::text AS ratio, big::text AS big, settings::text AS settings,
                payload::text AS payload, jsonb_typeof(payload) AS payload_type, (settings IS NULL) AS settings_is_null,
                tags::text AS tags, created_at AT TIME ZONE 'UTC' AS created_utc, note, name
         FROM accounts WHERE id = '${id}'`,
      );
    for (const id of ['acc_edge1', 'acc_edge2', 'acc_edge3', 'acc_0042']) {
      expect(await pick(target, id)).toEqual(await pick(source, id));
    }

    // The jsonb `null` in a NOT NULL column survived as jsonb null, not as an SQL NULL.
    expect(await scalar(target, `SELECT jsonb_typeof(payload) FROM accounts WHERE id = 'acc_edge1'`)).toBe('null');
    expect(await scalar(target, `SELECT balance::text FROM accounts WHERE id = 'acc_edge1'`)).toBe('99999999999999.999999');
    expect(await scalar(target, `SELECT settings->>'huge' FROM accounts WHERE id = 'acc_edge1'`)).toBe(
      '12345678901234567890123.45678901234567890',
    );
    expect(await scalar(target, `SELECT created_at::text FROM accounts WHERE id = 'acc_edge3'`)).toBe('infinity');
    expect(await scalar(target, `SELECT (SELECT count(*) FROM accounts WHERE settings IS NULL)`)).toBe(
      await scalar(source, `SELECT (SELECT count(*) FROM accounts WHERE settings IS NULL)`),
    );
  });

  it('keeps json (not jsonb) columns byte for byte, including a JSON null and odd spacing', async () => {
    const ddl = `CREATE TABLE raw_docs (id varchar(30) PRIMARY KEY, raw json NOT NULL, extra json)`;
    await source.exec(ddl);
    await target.exec(ddl);
    await source.exec(`
      INSERT INTO raw_docs (id, raw, extra) VALUES
        ('r1', 'null'::json, NULL),
        ('r2', ' {"a" :  1,  "a": 2 } '::json, 'null'::json),
        ('r3', '"text with \\u00e9 and \\" quote"'::json, '[1 , 2]'::json);
    `);
    const { catalog, prepared } = await copyEverything();
    await finishTarget(target.sql, prepared.saved, catalog);

    const dump = (db: PgliteTenant) =>
      db.sql.query(`SELECT id, raw::text AS raw, extra::text AS extra, (extra IS NULL) AS extra_is_null FROM raw_docs ORDER BY id`);
    expect(await dump(target)).toEqual(await dump(source));
    expect(await scalar(target, `SELECT raw::text FROM raw_docs WHERE id = 'r2'`)).toBe(' {"a" :  1,  "a": 2 } ');
    expect((await compareAll(catalog)).ok).toBe(true);
  });

  it('quotes every identifier: tables, key and columns with quotes, spaces and keywords', async () => {
    const ddl = `
      CREATE TABLE "Odd ""Table" (
        "Id" text,
        "select" integer,
        "j""x" jsonb,
        "from;--" text,
        PRIMARY KEY ("select", "Id")
      );
      CREATE TABLE "Odd ""Child" (
        id text PRIMARY KEY,
        parent_sel integer NOT NULL,
        parent_id text NOT NULL,
        CONSTRAINT "fk ""odd" FOREIGN KEY (parent_sel, parent_id) REFERENCES "Odd ""Table" ("select", "Id")
      );
    `;
    await source.exec(ddl);
    await target.exec(ddl);
    await source.exec(`
      INSERT INTO "Odd ""Table" ("Id", "select", "j""x", "from;--") VALUES
        ('a', 1, '{"k": null}', 'x'), ('a', 2, 'null', 'y'), ('b''c', 1, NULL, 'z');
      INSERT INTO "Odd ""Child" (id, parent_sel, parent_id) VALUES ('c1', 1, 'a'), ('c2', 2, 'a');
    `);
    const { catalog, prepared } = await copyEverything({ pageSize: 2 });
    const finished = await finishTarget(target.sql, prepared.saved, catalog);
    expect(finished.complete).toBe(true);
    expect(await scalar(target, `SELECT count(*) FROM "Odd ""Table"`)).toBe('3');
    expect(await scalar(target, `SELECT jsonb_typeof("j""x") FROM "Odd ""Table" WHERE "select" = 2`)).toBe('null');
    expect((await readCatalog(target.sql)).foreignKeys.map((f) => f.name)).toContain('fk "odd');
    expect((await compareAll(catalog)).ok).toBe(true);
  });

  it('copies the vector column', async () => {
    const { catalog, prepared } = await copyEverything();
    await finishTarget(target.sql, prepared.saved, catalog);
    expect(await scalar(target, `SELECT embedding::text FROM embeddings WHERE id = 'emb_007'`)).toBe('[7,3.5,-1.25]');
    expect((await compareAll(catalog)).ok).toBe(true);
  });

  it('is independent of the session time zone of either side', async () => {
    await source.exec(`SET TimeZone = 'Asia/Tokyo'`);
    await target.exec(`SET TimeZone = 'America/Los_Angeles'`);
    const { catalog, prepared } = await copyEverything({ pageSize: 40 });
    await finishTarget(target.sql, prepared.saved, catalog);
    expect((await compareAll(catalog)).ok).toBe(true);
    expect(await scalar(target, `SELECT extract(epoch FROM created_at)::text FROM accounts WHERE id = 'acc_edge1'`)).toBe(
      await scalar(source, `SELECT extract(epoch FROM created_at)::text FROM accounts WHERE id = 'acc_edge1'`),
    );
  });

  it('honours a byte cap per page and still finishes (first row always passes)', async () => {
    const { catalog, prepared, pages } = await copyEverything({ pageSize: 50, maxPageBytes: 600 });
    await finishTarget(target.sql, prepared.saved, catalog);
    expect((await compareAll(catalog)).ok).toBe(true);
    // 123 accounts at ~3-4 rows per 600 bytes cannot fit in the 3 pages a 50-row page size would need.
    expect(pages).toBeGreaterThan(30);
  });

  it('leaves the user triggers in their original modes and the foreign keys validated', async () => {
    const { catalog, prepared } = await copyEverything();
    // While copying, user triggers are off.
    expect(await scalar(target, `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D'`)).toBe('0');
    await finishTarget(target.sql, prepared.saved, catalog);

    const after = await readCatalog(target.sql);
    expect(after.triggers).toEqual(catalog.triggers); // enabled one back to 'O', the deliberately disabled one still 'D'
    expect(after.foreignKeys).toEqual(catalog.foreignKeys);
    expect(after.foreignKeys.every((f) => f.validated)).toBe(true);
  });

  it('would double-count without the trigger being disabled (control)', async () => {
    // Skip prepareTargetForCopy's trigger disabling: truncate by hand and copy with the trigger live.
    const catalog = await readCatalog(source.sql);
    await target.exec(`
      ALTER TABLE orders DROP CONSTRAINT orders_account_fk;
      ALTER TABLE order_lines DROP CONSTRAINT order_lines_order_fk;
      ALTER TABLE folders DROP CONSTRAINT folders_parent_fk;
      TRUNCATE accounts, orders, order_lines, folders, correspondents, messages, embeddings, seeded_defaults;
    `);
    for (const name of ['correspondents', 'messages']) {
      await copyTable(source.sql, target.sql, requireTable(catalog, name), null, { pageSize: 10, maxPages: 100 });
    }
    const comparison = await compareAll({ ...catalog, tables: catalog.tables.filter((t) => t.name === 'correspondents') });
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatched).toEqual(['correspondents']);
  });

  it('truncates the pre-seeded target and refreshes only the views populated on the source', async () => {
    const { catalog, prepared } = await copyEverything();
    expect(prepared.truncatedTables).toBe(catalog.tables.length);
    expect(await scalar(target, `SELECT label FROM seeded_defaults WHERE id = 'def_1'`)).toBe('from source');
    expect(await scalar(target, `SELECT count(*) FROM seeded_defaults`)).toBe('1');
    expect(await scalar(target, `SELECT name FROM accounts WHERE id = 'acc_0001'`)).toBe('Account 1');

    const finished = await finishTarget(target.sql, prepared.saved, catalog);
    expect(finished.refreshedViews).toEqual(['account_totals']);
    expect(finished.clearedViews).toEqual(['account_names']); // the pool had refreshed it against seed rows
    expect(await scalar(target, `SELECT ispopulated::text FROM pg_matviews WHERE matviewname = 'account_totals'`)).toBe('true');
    expect(await scalar(target, `SELECT ispopulated::text FROM pg_matviews WHERE matviewname = 'account_names'`)).toBe('false');
    expect(await scalar(target, `SELECT sum(total)::text FROM account_totals`)).toBe(
      await scalar(source, `SELECT sum(total)::text FROM account_totals`),
    );
  });
});

describe('resuming and replaying', () => {
  it('resumes mid-table from a persisted cursor with no duplicates and no gaps', async () => {
    const catalog = await readCatalog(source.sql);
    await prepareTargetForCopy(target.sql, catalog);
    const accounts = requireTable(catalog, 'accounts');

    const first = await copyTablePage(source.sql, target.sql, accounts, null, 50);
    expect(first).toMatchObject({ readRows: 50, insertedRows: 50, done: false });
    expect(first.nextCursor).toBe(JSON.stringify(['acc_0050']));

    // "Crash": nothing but the cursor string survives.
    const persisted: string | null = JSON.parse(JSON.stringify(first.nextCursor));
    const rest = await copyTable(source.sql, target.sql, accounts, persisted, { pageSize: 50, maxPages: 100 });
    expect(rest.done).toBe(true);
    expect(rest.readRows).toBe(FIXTURE_ACCOUNT_COUNT - 50);
    expect(rest.insertedRows).toBe(FIXTURE_ACCOUNT_COUNT - 50);

    expect(await scalar(target, 'SELECT count(*) FROM accounts')).toBe(String(FIXTURE_ACCOUNT_COUNT));
    expect(await scalar(target, 'SELECT count(DISTINCT id) FROM accounts')).toBe(String(FIXTURE_ACCOUNT_COUNT));
    const comparison = await compareAll({ ...catalog, tables: [accounts] });
    expect(comparison.ok).toBe(true);
  });

  it('resumes a composite-key table from a two-part cursor', async () => {
    const catalog = await readCatalog(source.sql);
    await prepareTargetForCopy(target.sql, catalog);
    const lines = requireTable(catalog, 'order_lines');

    const first = await copyTablePage(source.sql, target.sql, lines, null, 33);
    expect(first.nextCursor).toBe(JSON.stringify(['ord_0017', '1'])); // 33 rows = 16 orders x 2 lines + 1
    const rest = await copyTable(source.sql, target.sql, lines, first.nextCursor, { pageSize: 33, maxPages: 100 });
    expect(rest.done).toBe(true);
    expect(first.readRows + rest.readRows).toBe(300);
    expect((await compareAll({ ...catalog, tables: [lines] })).ok).toBe(true);
  });

  it('re-running a page is harmless', async () => {
    const catalog = await readCatalog(source.sql);
    await prepareTargetForCopy(target.sql, catalog);
    const orders = requireTable(catalog, 'orders');

    const first = await copyTablePage(source.sql, target.sql, orders, null, 60);
    const again = await copyTablePage(source.sql, target.sql, orders, null, 60);
    expect(again).toMatchObject({ readRows: 60, insertedRows: 0, nextCursor: first.nextCursor, done: false });

    const rest = await copyTable(source.sql, target.sql, orders, again.nextCursor, { pageSize: 60, maxPages: 100 });
    expect(rest.done).toBe(true);
    expect(await scalar(target, 'SELECT count(*) FROM orders')).toBe('150');
    expect((await compareAll({ ...catalog, tables: [orders] })).ok).toBe(true);
  });

  it('reports done on the last page, on an exact page boundary, and on an empty table', async () => {
    const catalog = await readCatalog(source.sql);
    await prepareTargetForCopy(target.sql, catalog);
    const lines = requireTable(catalog, 'order_lines');
    // 300 rows with pages of 100: the third page is exactly full and must still say done.
    const pages = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await copyTablePage(source.sql, target.sql, lines, cursor, 100);
      pages.push(page);
      cursor = page.nextCursor;
      if (page.done) break;
    }
    expect(pages.map((p) => [p.readRows, p.done])).toEqual([
      [100, false],
      [100, false],
      [100, true],
    ]);

    const empty = await copyTablePage(source.sql, target.sql, requireTable(catalog, 'empty_table'), null, 100);
    expect(empty).toEqual({ readRows: 0, insertedRows: 0, readBytes: 0, nextCursor: null, done: true });
  });

  it('rejects a cursor that does not fit the table key', async () => {
    const catalog = await readCatalog(source.sql);
    const lines = requireTable(catalog, 'order_lines');
    await expect(copyTablePage(source.sql, target.sql, lines, JSON.stringify(['only-one']), 10)).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
    await expect(copyTablePage(source.sql, target.sql, lines, 'not json', 10)).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe('prepareTargetForCopy and finishTarget', () => {
  it('prepare is idempotent: a second run changes nothing and returns the same saved state', async () => {
    const catalog = await readCatalog(source.sql);
    const first = await prepareTargetForCopy(target.sql, catalog);
    const second = await prepareTargetForCopy(target.sql, catalog);
    expect(second.saved).toEqual(first.saved);
    expect(first.droppedForeignKeys).toBe(3);
    expect(first.saved.triggers).toEqual(catalog.triggers);
    expect(await scalar(target, `SELECT count(*) FROM pg_constraint WHERE contype = 'f'`)).toBe('0');
    expect(await scalar(target, 'SELECT count(*) FROM seeded_defaults')).toBe('0');
  });

  it('finish is idempotent: running it again restores nothing more and keeps the data', async () => {
    const { catalog, prepared } = await copyEverything();
    const first = await finishTarget(target.sql, prepared.saved, catalog);
    expect(first.restoredForeignKeys).toBe(3);
    const second = await finishTarget(target.sql, prepared.saved, catalog);
    expect(second).toMatchObject({ restoredForeignKeys: 0, remainingForeignKeys: 0, complete: true });
    expect((await compareAll(catalog)).ok).toBe(true);
  });

  it('finish can be driven in slices via maxForeignKeys', async () => {
    const { catalog, prepared } = await copyEverything();
    const a = await finishTarget(target.sql, prepared.saved, catalog, { maxForeignKeys: 2 });
    expect(a).toMatchObject({ restoredForeignKeys: 2, remainingForeignKeys: 1, complete: false });
    expect(a.refreshedViews).toEqual([]); // views wait until every key is back
    const b = await finishTarget(target.sql, prepared.saved, catalog, { maxForeignKeys: 2 });
    expect(b).toMatchObject({ restoredForeignKeys: 1, remainingForeignKeys: 0, complete: true });
    expect(b.refreshedViews).toEqual(['account_totals']);
  });

  it('finish recovers when a previous attempt died after adding a key NOT VALID', async () => {
    const { catalog, prepared } = await copyEverything();
    await target.exec(
      `ALTER TABLE orders ADD CONSTRAINT orders_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID`,
    );
    const result = await finishTarget(target.sql, prepared.saved, catalog);
    expect(result.complete).toBe(true);
    expect((await readCatalog(target.sql)).foreignKeys.every((f) => f.validated)).toBe(true);
  });

  it('a key that was NOT VALID on the source stays NOT VALID on the target', async () => {
    // Add an orphan the source's key tolerates because it was never validated.
    await source.exec(`
      ALTER TABLE orders DROP CONSTRAINT orders_account_fk;
      INSERT INTO orders (id, account_id, total) VALUES ('ord_orphan', 'acc_missing', 1);
      ALTER TABLE orders ADD CONSTRAINT orders_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
    `);
    const { catalog, prepared } = await copyEverything();
    const result = await finishTarget(target.sql, prepared.saved, catalog);
    expect(result.complete).toBe(true);
    const fk = (await readCatalog(target.sql)).foreignKeys.find((f) => f.name === 'orders_account_fk');
    expect(fk?.validated).toBe(false);
  });

  it('throws ForeignKeyValidationError naming the constraint when the copied data violates a key', async () => {
    const catalog = await readCatalog(source.sql);
    const prepared = await prepareTargetForCopy(target.sql, catalog);
    // Copy orders but not their accounts.
    await copyTable(source.sql, target.sql, requireTable(catalog, 'orders'), null, { pageSize: 100, maxPages: 100 });

    const error = await finishTarget(target.sql, prepared.saved, catalog).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForeignKeyValidationError);
    expect(error).toMatchObject({ table: 'orders', constraint: 'orders_account_fk' });
    // The failed key is absent again rather than left half-added.
    const keys = (await readCatalog(target.sql)).foreignKeys.map((f) => f.name);
    expect(keys).not.toContain('orders_account_fk');
  });

  it('restoreForeignKeys on its own reports what is left', async () => {
    const { prepared } = await copyEverything();
    expect(await restoreForeignKeys(target.sql, prepared.saved, { limit: 1 })).toEqual({ restored: 1, remaining: 2 });
  });
});

describe('journal and schema checks', () => {
  it('throws JournalMismatchError when the target is at another migration', async () => {
    await target.exec(`INSERT INTO __drizzle_migrations (hash, created_at, tag) VALUES ('hash-2', 1700000200000, '0002_extra')`);
    const catalog = await readCatalog(source.sql);
    const error = await prepareTargetForCopy(target.sql, catalog).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalMismatchError);
    expect(error).toMatchObject({
      source: { count: 2, maxCreatedAt: '1700000100000' },
      target: { count: 3, maxCreatedAt: '1700000200000' },
    });
    // Nothing was touched.
    expect(await scalar(target, 'SELECT count(*) FROM seeded_defaults')).toBe('2');
  });

  it('throws when only the newest created_at differs', async () => {
    await target.exec(`UPDATE __drizzle_migrations SET created_at = 1700000100001 WHERE tag = '0001_more'`);
    await expect(prepareTargetForCopy(target.sql, await readCatalog(source.sql))).rejects.toBeInstanceOf(JournalMismatchError);
  });

  it('does not compare tags: a journal without the tag column (drizzle-made) still matches', async () => {
    await target.exec('ALTER TABLE __drizzle_migrations DROP COLUMN tag');
    await expect(prepareTargetForCopy(target.sql, await readCatalog(source.sql))).resolves.toMatchObject({
      truncatedTables: 9,
    });
  });

  it('throws SchemaMismatchError when the target lacks a table or column the source has', async () => {
    await target.exec('DROP TABLE embeddings; ALTER TABLE accounts DROP COLUMN note;');
    const error = await prepareTargetForCopy(target.sql, await readCatalog(source.sql)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SchemaMismatchError);
    expect(error).toMatchObject({
      missingTables: ['embeddings'],
      missingColumns: [{ table: 'accounts', column: 'note' }],
    });
  });

  it('refuses a schema with sequences instead of resetting their counters', async () => {
    await source.exec('CREATE TABLE counters (id serial PRIMARY KEY, label text)');
    await target.exec('CREATE TABLE counters (id serial PRIMARY KEY, label text)');
    const error = await prepareTargetForCopy(target.sql, await readCatalog(source.sql)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedSchemaError);
    expect(error).toMatchObject({ feature: 'sequences', objects: ['counters_id_seq'] });
  });

  it('truncates and reports tables the source does not have', async () => {
    await target.exec(`CREATE TABLE pool_only (id varchar(30) PRIMARY KEY); INSERT INTO pool_only VALUES ('x');`);
    const prepared = await prepareTargetForCopy(target.sql, await readCatalog(source.sql));
    expect(prepared.extraTargetTables).toEqual(['pool_only']);
    expect(await scalar(target, 'SELECT count(*) FROM pool_only')).toBe('0');
  });
});

describe('verification', () => {
  it('detects a source that changed after the first reading', async () => {
    const catalog = await readCatalog(source.sql);
    const before = await tableChecksums(source.sql, catalog.tables);
    expect(sourceUnchanged(before, await tableChecksums(source.sql, catalog.tables))).toEqual({
      unchanged: true,
      changedTables: [],
    });

    // Same row count, different value: only the checksum can see this.
    await source.exec(`UPDATE accounts SET balance = balance + 0.000001 WHERE id = 'acc_0007'`);
    expect(sourceUnchanged(before, await tableChecksums(source.sql, catalog.tables))).toEqual({
      unchanged: false,
      changedTables: ['accounts'],
    });

    // A new row changes the count.
    const mid = await tableChecksums(source.sql, catalog.tables);
    await source.exec(`INSERT INTO seeded_defaults (id, label) VALUES ('def_9', 'late write')`);
    expect(sourceUnchanged(mid, await tableChecksums(source.sql, catalog.tables))).toMatchObject({
      unchanged: false,
      changedTables: ['seeded_defaults'],
    });
  });

  it('detects a copy that differs from the source, per table', async () => {
    const { catalog, prepared } = await copyEverything();
    await finishTarget(target.sql, prepared.saved, catalog);
    await target.exec(`UPDATE orders SET total = total + 1 WHERE id = 'ord_0003'`);
    await target.exec(`DELETE FROM order_lines WHERE order_id = 'ord_0004' AND line_no = 1`);
    const comparison = await compareAll(catalog);
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatched).toEqual(['order_lines', 'orders']);
    expect(comparison.tables.find((t) => t.table === 'orders')?.reason).toBe('hash');
    expect(comparison.tables.find((t) => t.table === 'order_lines')?.reason).toBe('count');
  });

  it('tells a jsonb null from an SQL NULL', async () => {
    const { catalog, prepared } = await copyEverything();
    await finishTarget(target.sql, prepared.saved, catalog);
    await target.exec(`UPDATE accounts SET settings = 'null'::jsonb WHERE id = 'acc_edge2'`); // was SQL NULL
    expect((await compareAll(catalog)).mismatched).toEqual(['accounts']);
  });

  it('only counts tables above hashLimitRows', async () => {
    const catalog = await readCatalog(source.sql);
    const sums = await tableChecksums(source.sql, catalog.tables, { hashLimitRows: 100 });
    expect(sums.accounts).toMatchObject({ count: FIXTURE_ACCOUNT_COUNT, hash: null }); // 123 > 100
    expect(sums.orders?.hash).toBeNull(); // 150 > 100
    expect(sums.folders?.hash).toEqual(expect.any(String)); // 60 <= 100
    expect(sums.empty_table).toEqual({ count: 0, hash: '0' });
  });

  it('can be run on subsets of tables and merged', async () => {
    const catalog = await readCatalog(source.sql);
    const all = await tableChecksums(source.sql, catalog.tables);
    const a = await tableChecksums(source.sql, catalog.tables.slice(0, 4));
    const b = await tableChecksums(source.sql, catalog.tables.slice(4));
    expect({ ...a, ...b }).toEqual(all);
  });
});

describe('fixture sanity', () => {
  it('builds the same schema on both sides', async () => {
    expect(FIXTURE_SCHEMA_SQL).toContain('messages_track_inbound');
    const a = await readCatalog(source.sql);
    const b = await readCatalog(target.sql);
    expect(b.tables.map((t) => [t.name, t.primaryKey, t.columns])).toEqual(a.tables.map((t) => [t.name, t.primaryKey, t.columns]));
  });
});
