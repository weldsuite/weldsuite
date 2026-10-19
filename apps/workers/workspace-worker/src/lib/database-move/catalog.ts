/**
 * Catalog reader: re-derives, at runtime, everything the move engine needs to
 * know about a tenant database (tables, primary keys, columns, foreign keys,
 * user triggers, materialized views, migrations journal). Nothing about the
 * tenant schema is hard-coded, so a migration that adds a table needs no
 * change here.
 *
 * Size: the real tenant schema (371 tables) serialises to ~480 KB, too big to
 * carry through Workflow step state (1 MiB per step result). The source is
 * locked for the whole move, so a step can simply call `readCatalog` again, or
 * `readTables(sql, [name])` for the one table it works on.
 *
 * Cost: seven statements (seven subrequests on neon-http). Every query returns
 * text cells (`json_agg(...)::text`, `::text` casts) so the result does not
 * depend on how a driver parses json, arrays or bigints.
 */

import { TENANT_SCHEMA, quoteIdent, quoteLiteral } from './quote';
import {
  asStringArray,
  isRecord,
  readBool,
  readInt,
  readJson,
  readNullableString,
  readString,
} from './rows';
import type {
  Catalog,
  ColumnInfo,
  ForeignKeyInfo,
  JournalSummary,
  MaterializedViewInfo,
  SqlRow,
  TableInfo,
  TenantSql,
  TriggerEnabledMode,
  TriggerInfo,
} from './types';

/** Journal table the migration runners maintain. Never copied: the target carries its own. */
export const JOURNAL_TABLE = '__drizzle_migrations';

/** Width assumed for a table that has neither column statistics nor a populated heap. */
const DEFAULT_ROW_BYTES = 256;
/** `"name":` plus separators and quoting, per column, in `row_to_json` output. */
const JSON_KEY_OVERHEAD_BYTES = 6;

const TABLES_QUERY = `
SELECT
  c.relname AS name,
  c.reltuples::float8::text AS reltuples,
  c.relpages::text AS relpages,
  (
    SELECT coalesce(json_agg(json_build_object(
             'name', a.attname,
             'type', format_type(a.atttypid, a.atttypmod),
             'json', coalesce(nullif(ty.typbasetype, 0), a.atttypid) IN (114, 3802)
           ) ORDER BY a.attnum), '[]'::json)::text
    FROM pg_attribute a
    JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
  ) AS columns,
  (
    SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]'::json)::text
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE i.indrelid = c.oid AND i.indisprimary
  ) AS primary_key,
  (
    SELECT sum(s.avg_width)::text
    FROM pg_stats s
    WHERE s.schemaname = ${quoteLiteral(TENANT_SCHEMA)} AND s.tablename = c.relname AND NOT s.inherited
  ) AS stats_width
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${quoteLiteral(TENANT_SCHEMA)} AND c.relkind = 'r' AND c.relname <> ${quoteLiteral(JOURNAL_TABLE)}`;

const FOREIGN_KEYS_QUERY = `
SELECT cl.relname AS "table", con.conname AS name, pg_get_constraintdef(con.oid) AS definition,
       con.convalidated AS validated
FROM pg_constraint con
JOIN pg_class cl ON cl.oid = con.conrelid
JOIN pg_namespace n ON n.oid = cl.relnamespace
WHERE con.contype = 'f' AND n.nspname = ${quoteLiteral(TENANT_SCHEMA)}
ORDER BY cl.relname, con.conname`;

const TRIGGERS_QUERY = `
SELECT c.relname AS "table", t.tgname AS name, t.tgenabled::text AS enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND c.relkind = 'r' AND n.nspname = ${quoteLiteral(TENANT_SCHEMA)}
ORDER BY c.relname, t.tgname`;

const MATERIALIZED_VIEWS_QUERY = `
SELECT matviewname AS name, ispopulated AS populated
FROM pg_matviews
WHERE schemaname = ${quoteLiteral(TENANT_SCHEMA)}
ORDER BY matviewname`;

// Owned sequences (serial: deptype 'a', identity: 'i') hang off their table in pg_depend.
const SEQUENCES_QUERY = `
SELECT c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname = ${quoteLiteral(TENANT_SCHEMA)}
  AND NOT EXISTS (
    SELECT 1
    FROM pg_depend d
    JOIN pg_class owner ON owner.oid = d.refobjid
    WHERE d.objid = c.oid AND d.deptype IN ('a', 'i') AND owner.relname = ${quoteLiteral(JOURNAL_TABLE)}
  )
ORDER BY c.relname`;

function parseColumns(value: unknown, table: string): ColumnInfo[] {
  if (!Array.isArray(value)) throw new Error(`Columns of "${table}" are not a list`);
  return value.map((entry): ColumnInfo => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.type !== 'string') {
      throw new Error(`Malformed column entry for "${table}"`);
    }
    return { name: entry.name, type: entry.type, json: entry.json === true };
  });
}

/** Estimated JSON-text bytes of one row, from column statistics, else heap density, else a default. */
export function estimateRowBytes(input: {
  statsWidth: number | null;
  reltuples: number | null;
  relpages: number;
  columnNames: readonly string[];
}): number {
  const heapWidth =
    input.reltuples !== null && input.reltuples > 0 && input.relpages > 0
      ? (input.relpages * 8192) / input.reltuples
      : null;
  const dataWidth = input.statsWidth ?? heapWidth ?? DEFAULT_ROW_BYTES;
  const keyOverhead = input.columnNames.reduce((sum, name) => sum + name.length + JSON_KEY_OVERHEAD_BYTES, 0);
  return Math.max(1, Math.ceil(dataWidth + keyOverhead));
}

/**
 * Read the tables of the tenant schema (the journal excluded). Pass `names` to
 * read just those tables: one table's `TableInfo` is ~1 KB where the whole
 * catalog is ~480 KB, so a Workflow step that copies one table should fetch its
 * own slice rather than carry the catalog in step state.
 */
export async function readTables(sql: TenantSql, names?: readonly string[]): Promise<TableInfo[]> {
  const rows = names
    ? await sql.query(`${TABLES_QUERY} AND c.relname IN (SELECT json_array_elements_text($1::json)) ORDER BY c.relname`, [
        JSON.stringify(names),
      ])
    : await sql.query(`${TABLES_QUERY} ORDER BY c.relname`);
  return rows.map((row): TableInfo => {
    const name = readString(row, 'name');
    const columns = parseColumns(readJson(row, 'columns'), name);
    const reltuplesRaw = Number(readString(row, 'reltuples'));
    // PG14+ reports -1 for "never analysed"; treat that as unknown.
    const reltuples = Number.isFinite(reltuplesRaw) && reltuplesRaw >= 0 ? reltuplesRaw : null;
    const statsWidthRaw = readNullableString(row, 'stats_width');
    return {
      name,
      columns,
      primaryKey: asStringArray(readJson(row, 'primary_key'), `primary key of "${name}"`),
      estimatedRows: reltuples,
      avgRowBytes: estimateRowBytes({
        statsWidth: statsWidthRaw === null ? null : Number(statsWidthRaw),
        reltuples,
        relpages: readInt(row, 'relpages'),
        columnNames: columns.map((c) => c.name),
      }),
    };
  });
}

export async function readForeignKeys(sql: TenantSql): Promise<ForeignKeyInfo[]> {
  const rows = await sql.query(FOREIGN_KEYS_QUERY);
  return rows.map((row) => ({
    table: readString(row, 'table'),
    name: readString(row, 'name'),
    definition: readString(row, 'definition'),
    validated: readBool(row, 'validated'),
  }));
}

function toTriggerMode(value: string): TriggerEnabledMode {
  if (value === 'O' || value === 'D' || value === 'R' || value === 'A') return value;
  throw new Error(`Unexpected trigger mode "${value}"`);
}

export async function readTriggers(sql: TenantSql): Promise<TriggerInfo[]> {
  const rows = await sql.query(TRIGGERS_QUERY);
  return rows.map((row) => ({
    table: readString(row, 'table'),
    name: readString(row, 'name'),
    enabled: toTriggerMode(readString(row, 'enabled')),
  }));
}

export async function readMaterializedViews(sql: TenantSql): Promise<MaterializedViewInfo[]> {
  const rows = await sql.query(MATERIALIZED_VIEWS_QUERY);
  return rows.map((row) => ({ name: readString(row, 'name'), populated: readBool(row, 'populated') }));
}

export async function readSequences(sql: TenantSql): Promise<string[]> {
  const rows = await sql.query(SEQUENCES_QUERY);
  return rows.map((row) => readString(row, 'name'));
}

/** `"schema"."__drizzle_migrations"` as a string literal, the argument `to_regclass` takes. */
function journalRegclassLiteral(schema: string): string {
  return quoteLiteral(`${quoteIdent(schema)}.${quoteIdent(JOURNAL_TABLE)}`);
}

/** The schema holding the journal: `public` wins when both have one. */
function journalSchemaOf(located: SqlRow): JournalSummary['schema'] | null {
  if (readBool(located, 'in_public')) return 'public';
  if (readBool(located, 'in_drizzle')) return 'drizzle';
  return null;
}

/**
 * Summarise the migrations journal: `count(*)` and `max(created_at)`. The
 * `tag` column only exists when `applyTenantMigrations` created the table, so
 * it is deliberately not part of the comparison. Looks in `public` first (where
 * both migration runners put it), then in drizzle's default `drizzle` schema.
 */
export async function readJournalSummary(sql: TenantSql): Promise<JournalSummary | null> {
  const [located] = await sql.query(`
    SELECT
      (to_regclass(${journalRegclassLiteral('public')}) IS NOT NULL) AS in_public,
      (to_regclass(${journalRegclassLiteral('drizzle')}) IS NOT NULL) AS in_drizzle`);
  if (!located) return null;
  const schema = journalSchemaOf(located);
  if (!schema) return null;
  const [summary] = await sql.query(
    `SELECT count(*)::text AS count, max(created_at)::text AS max_created_at
     FROM ${quoteIdent(schema)}.${quoteIdent(JOURNAL_TABLE)}`,
  );
  if (!summary) return null;
  return { schema, count: readInt(summary, 'count'), maxCreatedAt: readNullableString(summary, 'max_created_at') };
}

/** Read the whole catalog of a tenant database. */
export async function readCatalog(sql: TenantSql): Promise<Catalog> {
  const tables = await readTables(sql);
  const foreignKeys = await readForeignKeys(sql);
  const triggers = await readTriggers(sql);
  const materializedViews = await readMaterializedViews(sql);
  const sequences = await readSequences(sql);
  const journal = await readJournalSummary(sql);
  return { tables, foreignKeys, triggers, materializedViews, sequences, journal };
}
