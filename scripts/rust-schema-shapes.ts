/**
 * Spike S7 of the ORM plan (rust/docs/spikes.md): what Drizzle returns for a
 * row of every table, to compare with the SeaORM entities' JSON.
 *
 * Inserts two rows into every table of a scratch master and tenant database
 * (built by scripts/rust-test-db.ts) through Drizzle: one with every column
 * set, one with every nullable column null. Then reads them back with
 * `db.select().from(table)` and writes `JSON.stringify` of the rows, by
 * table, to --out. Foreign keys are off for the session
 * (`session_replication_role = replica`); a table whose rows a check
 * constraint refuses is listed under `skipped`.
 *
 *   pnpm exec tsx scripts/rust-schema-shapes.ts --master URL --tenant URL --out rows.json
 *
 * Point it only at a throwaway database: it deletes every row of every table.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFrom = createRequire(path.join(repo, 'packages/core/db/package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

type Which = 0 | 1;

const text = (col: any, which: Which) => `${which === 0 ? 'f' : 'n'}${col.name}`.slice(0, col.length ?? 40);
const pick = <T>(which: Which, first: T, second: T) => (which === 0 ? first : second);

/**
 * A value for a column, by Drizzle column type, in row `which` (0: every
 * column set, 1: nullable columns null). Timestamps carry microseconds and an
 * offset, so truncation and the UTC shift both show.
 */
const VALUES: Record<string, (col: any, which: Which, sql: any) => unknown> = {
  PgVarchar: text,
  PgChar: text,
  PgText: text,
  PgInteger: (_, which) => pick(which, 7, 8),
  PgSerial: (_, which) => pick(which, 7, 8),
  PgSmallInt: (_, which) => pick(which, 3, 4),
  PgSmallSerial: (_, which) => pick(which, 3, 4),
  PgBigInt53: (_, which) => pick(which, 9007199254740, 9007199254741),
  PgBigSerial53: (_, which) => pick(which, 9007199254740, 9007199254741),
  PgBigInt64: (_, which) => pick(which, 9007199254740993n, 9007199254740994n),
  PgReal: () => 1.1,
  PgDoublePrecision: () => 2.2,
  PgNumeric: (_, which) => pick(which, '1.5', '0.05'),
  PgNumericNumber: (_, which) => pick(which, 1.5, 0.05),
  PgBoolean: (_, which) => which === 0,
  PgJson: (_, which) => pick(which, { a: [1, 'x', null], when: '2026-10-29T07:00:00.123456+00:00', nested: { ok: true } }, []),
  PgJsonb: (_, which) => pick(which, { a: [1, 'x', null], when: '2026-10-29T07:00:00.123456+00:00', nested: { ok: true } }, []),
  PgTimestamp: (_, which, sql) => sql.raw(pick(which, `'2026-10-29 07:00:00.123456+02'`, `'2026-01-01 00:00:00+00'`)),
  PgTimestampString: (_, which, sql) =>
    sql.raw(pick(which, `'2026-10-29 07:00:00.123456+02'`, `'2026-01-01 00:00:00+00'`)),
  PgDate: (_, which, sql) => sql.raw(pick(which, `'2026-10-29'`, `'2026-01-01'`)),
  PgDateString: (_, which, sql) => sql.raw(pick(which, `'2026-10-29'`, `'2026-01-01'`)),
  PgEnumColumn: (col, which) => col.enumValues[Math.min(which, col.enumValues.length - 1)],
  PgVector: (col) => Array.from({ length: col.dimensions }, (_, i) => (i % 4) * 0.25),
};

function value(col: any, which: Which, sql: any): unknown {
  if (which === 1 && !col.notNull) return null;
  const make = VALUES[col.columnType];
  if (!make) throw new Error(`no test value for ${col.columnType}`);
  return make(col, which, sql);
}

/** Drizzle's BigInt can't go through JSON; record it as `bigint:<n>`. */
const bigintAsText = (_key: string, v: unknown) => (typeof v === 'bigint' ? `bigint:${v.toString()}` : v);

type TableResult = { name: string; rows: unknown[] } | { name: string; error: string };

/** Clear `table`, insert its two rows through Drizzle, and read them back. */
async function readTable(drizzleOrm: any, db: any, name: string, table: any): Promise<TableResult> {
  const { getTableColumns, sql } = drizzleOrm;
  try {
    const columns = Object.entries<any>(getTableColumns(table)).filter(([, col]) => !col.generated);
    const rows = ([0, 1] as const).map((which) =>
      Object.fromEntries(columns.map(([prop, col]) => [prop, value(col, which, sql)])),
    );
    await db.execute(sql.raw(`DELETE FROM "${name}"`));
    await db.insert(table).values(rows);
    const read = await db.select().from(table);
    return { name, rows: JSON.parse(JSON.stringify(read, bigintAsText)) };
  } catch (error: any) {
    return { name, error: String(error?.cause?.message ?? error?.message ?? error).slice(0, 200) };
  }
}

/** Every table of one database, read through one connection. */
async function readKind(kind: string, entry: string, url: string): Promise<TableResult[]> {
  const [drizzleOrm, pgCore, postgresJs, postgresModule] = await Promise.all([
    load('drizzle-orm'),
    load('drizzle-orm/pg-core'),
    load('drizzle-orm/postgres-js'),
    load('postgres'),
  ]);
  const { is, sql } = drizzleOrm;
  const { PgTable, getTableConfig } = pgCore;
  const client = postgresModule.default(url, { max: 1, onnotice: () => {} });
  const db = postgresJs.drizzle(client);
  // One connection, so these hold for every statement below.
  await db.execute(sql`SET session_replication_role = replica`);
  await db.execute(sql`SET TIME ZONE 'UTC'`);

  const schema = await import(pathToFileURL(path.join(repo, entry)).href);
  const tables = new Map<string, any>();
  for (const candidate of Object.values(schema)) {
    if (!is(candidate, PgTable)) continue;
    const config = getTableConfig(candidate);
    const isPublic = !config.schema || config.schema === 'public';
    if (isPublic && !tables.has(config.name)) tables.set(config.name, candidate);
  }
  // Tables are independent (foreign keys are off), so their statements may interleave.
  const results = await Promise.all(
    [...tables].sort(([a], [b]) => a.localeCompare(b)).map(([name, table]) => readTable(drizzleOrm, db, name, table)),
  );
  await client.end();
  console.log(`${kind}: ${results.filter((r) => 'rows' in r).length} tables read`);
  return results;
}

async function main() {
  const kinds = [
    ['tenant', 'packages/core/db/src/schema/index.ts'],
    ['master', 'packages/core/db/src/schema/master.ts'],
  ] as const;
  const urls = kinds.map(([kind]) => {
    const url = arg(kind);
    if (!url) throw new Error(`--${kind} URL`);
    return url;
  });
  const results = await Promise.all(kinds.map(([kind, entry], i) => readKind(kind, entry, urls[i])));

  const out: Record<string, any> = { skipped: {} };
  kinds.forEach(([kind], i) => {
    out[kind] = {};
    for (const result of results[i]) {
      if ('rows' in result) out[kind][result.name] = result.rows;
      else out.skipped[`${kind}.${result.name}`] = result.error;
    }
  });
  const file = arg('out') ?? 'rows.json';
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`skipped: ${Object.keys(out.skipped).length}; wrote ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
