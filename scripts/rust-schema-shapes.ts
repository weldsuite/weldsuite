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

/** A value for `col` in row `which` (0: everything set, 1: nullable columns null). */
function value(col: any, which: 0 | 1, sql: any): unknown {
  if (which === 1 && !col.notNull) return null;
  const tag = which === 0 ? 'f' : 'n';
  switch (col.columnType) {
    case 'PgVarchar':
    case 'PgChar':
    case 'PgText': {
      const text = `${tag}${col.name}`.slice(0, col.length ?? 40);
      return text;
    }
    case 'PgInteger':
    case 'PgSerial':
      return which === 0 ? 7 : 8;
    case 'PgSmallInt':
    case 'PgSmallSerial':
      return which === 0 ? 3 : 4;
    case 'PgBigInt53':
    case 'PgBigSerial53':
      return which === 0 ? 9007199254740 : 9007199254741;
    case 'PgBigInt64':
      return which === 0 ? 9007199254740993n : 9007199254740994n;
    case 'PgReal':
      return 1.1;
    case 'PgDoublePrecision':
      return 2.2;
    case 'PgNumeric':
      return which === 0 ? '1.5' : '0.05';
    case 'PgNumericNumber':
      return which === 0 ? 1.5 : 0.05;
    case 'PgBoolean':
      return which === 0;
    case 'PgJson':
    case 'PgJsonb':
      return which === 0 ? { a: [1, 'x', null], when: '2026-10-29T07:00:00.123456+00:00', nested: { ok: true } } : [];
    case 'PgTimestamp':
    case 'PgTimestampString':
      // Microseconds and an offset: truncation and the UTC shift both show.
      return sql.raw(which === 0 ? `'2026-10-29 07:00:00.123456+02'` : `'2026-01-01 00:00:00+00'`);
    case 'PgDate':
    case 'PgDateString':
      return sql.raw(which === 0 ? `'2026-10-29'` : `'2026-01-01'`);
    case 'PgEnumColumn':
      return col.enumValues[Math.min(which, col.enumValues.length - 1)];
    case 'PgVector':
      return Array.from({ length: col.dimensions }, (_, i) => (i % 4) * 0.25);
    default:
      throw new Error(`no test value for ${col.columnType}`);
  }
}

async function main() {
  const { getTableColumns, is, sql } = await load('drizzle-orm');
  const { PgTable, getTableConfig } = await load('drizzle-orm/pg-core');
  const { drizzle } = await load('drizzle-orm/postgres-js');
  const postgres = (await load('postgres')).default;

  const out: Record<string, any> = { skipped: {} };
  for (const [kind, entry] of [
    ['tenant', 'packages/core/db/src/schema/index.ts'],
    ['master', 'packages/core/db/src/schema/master.ts'],
  ] as const) {
    const url = arg(kind);
    if (!url) throw new Error(`--${kind} URL`);
    const client = postgres(url, { max: 1, onnotice: () => {} });
    const db = drizzle(client);
    await db.execute(sql`SET session_replication_role = replica`);
    await db.execute(sql`SET TIME ZONE 'UTC'`);
    const schema = await import(pathToFileURL(path.join(repo, entry)).href);
    const tables = new Map<string, any>();
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      if (config.schema && config.schema !== 'public') continue;
      if (!tables.has(config.name)) tables.set(config.name, value);
    }
    out[kind] = {};
    for (const [name, table] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        await db.execute(sql.raw(`DELETE FROM "${name}"`));
        const columns = Object.entries<any>(getTableColumns(table));
        for (const which of [0, 1] as const) {
          const row: Record<string, unknown> = {};
          for (const [prop, col] of columns) {
            if (col.generated) continue;
            row[prop] = value(col, which, sql);
          }
          await db.insert(table).values(row);
        }
        const rows = await db.select().from(table);
        out[kind][name] = JSON.parse(
          JSON.stringify(rows, (_key, v) => (typeof v === 'bigint' ? `bigint:${v.toString()}` : v)),
        );
      } catch (error: any) {
        out.skipped[`${kind}.${name}`] = String(error?.cause?.message ?? error?.message ?? error).slice(0, 200);
      }
    }
    await client.end();
    console.log(`${kind}: ${Object.keys(out[kind]).length} tables read`);
  }
  const file = arg('out') ?? 'rows.json';
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`skipped: ${Object.keys(out.skipped).length}; wrote ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
