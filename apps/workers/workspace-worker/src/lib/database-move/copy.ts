/**
 * The copy itself: keyset-paginated, idempotent, resumable.
 *
 * One page = two subrequests (one read transaction on the source, one INSERT
 * on the target). A page is safe to run twice: the INSERT is `ON CONFLICT DO
 * NOTHING`, and the cursor (the last row's primary-key values, JSON-encoded
 * strings) is the only state, so a retried Workflow step can resume from the
 * cursor it persisted last.
 *
 * Fidelity. Rows move as TEXT: the source emits `row_to_json(t)::text`, the
 * pages are concatenated into a JSON array string WITHOUT parsing the row
 * bodies, and the target unpacks them with `json_to_recordset`. A numeric(20,6)
 * or a jsonb document never passes through a JavaScript number, so precision
 * survives. json/jsonb columns are the one exception to "plain row_to_json":
 * a jsonb value of `null` and an SQL NULL both serialise as JSON `null`, and
 * the target would turn the former into the latter (a NOT NULL column would
 * then reject the row). Those columns are therefore sent as their TEXT
 * rendering (a JSON string) and cast back to their type on the target.
 */

import { InvalidCursorError, TableWithoutPrimaryKeyError } from './errors';
import { qualifiedTable, quoteIdent, quoteIdentList, quoteLiteral } from './quote';
import { readBool, readInt, readString } from './rows';
import { queryWithStableFormat } from './session-format';
import type { Catalog, ColumnInfo, SqlStatement, TableInfo, TenantSql } from './types';

/** A page aims for about this many bytes of row JSON. */
export const TARGET_PAGE_BYTES = 1024 * 1024;
export const MIN_PAGE_ROWS = 50;
export const MAX_PAGE_ROWS = 5000;
/**
 * Hard cap on the row JSON one page may carry, whatever the row-count target
 * says. Rows with outsized values (mail bodies, documents) would otherwise
 * make a 50-row page enormous. The first row of a page is always returned, so
 * a single row bigger than the cap still makes progress.
 */
export const DEFAULT_MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** Rows per page for a table, aiming at ~1 MiB per page, clamped to 50..5000. */
export function pageSizeFor(
  table: Pick<TableInfo, 'avgRowBytes'>,
  options: { targetBytes?: number; minRows?: number; maxRows?: number } = {},
): number {
  const target = options.targetBytes ?? TARGET_PAGE_BYTES;
  const min = options.minRows ?? MIN_PAGE_ROWS;
  const max = options.maxRows ?? MAX_PAGE_ROWS;
  const byWidth = Math.floor(target / Math.max(1, table.avgRowBytes));
  return Math.min(max, Math.max(min, byWidth));
}

/** `null` = start of the table; otherwise a JSON array of the last row's primary-key values as strings. */
export type CopyCursor = string | null;

export interface CopyPageOptions {
  /** Cap on the row JSON of one page. Defaults to {@link DEFAULT_MAX_PAGE_BYTES}. */
  maxPageBytes?: number;
}

export interface CopyPageResult {
  /** Rows read from the source in this page. */
  readRows: number;
  /** Rows actually inserted on the target (fewer than `readRows` when the page was a replay). */
  insertedRows: number;
  /** Bytes of row JSON moved. */
  readBytes: number;
  /** Cursor for the next page; unchanged when nothing was read. */
  nextCursor: CopyCursor;
  /** True when the source has no rows after `nextCursor`. */
  done: boolean;
}

function requirePrimaryKey(table: TableInfo): void {
  if (table.primaryKey.length === 0) throw new TableWithoutPrimaryKeyError(table.name);
}

function parseCursor(table: TableInfo, cursor: CopyCursor): string[] | null {
  if (cursor === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new InvalidCursorError(table.name);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== table.primaryKey.length ||
    !parsed.every((v): v is string => typeof v === 'string')
  ) {
    throw new InvalidCursorError(table.name);
  }
  return parsed;
}

function assertPositiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${what} must be a positive integer`);
  return value;
}

/**
 * The page reader. Layers, inside out:
 *  - `x`: the page's rows in primary-key order (json columns as text), one peek row beyond the page;
 *  - `y`: each row as JSON text plus its key values as text;
 *  - `z`: running byte total, row number and window size;
 * and the final WHERE trims the page to `pageSize` rows and to the byte cap.
 */
export function buildReadStatement(
  table: TableInfo,
  cursorValues: readonly string[] | null,
  pageSize: number,
  maxPageBytes: number,
): SqlStatement {
  requirePrimaryKey(table);
  const rows = assertPositiveInt(pageSize, 'pageSize');
  const cap = assertPositiveInt(maxPageBytes, 'maxPageBytes');
  const pk = table.primaryKey;
  const orderBy = pk.map((c) => `t.${quoteIdent(c)}`).join(', ');
  const innerColumns = table.columns
    .map((c) => (c.json ? `t.${quoteIdent(c.name)}::text AS ${quoteIdent(c.name)}` : `t.${quoteIdent(c.name)}`))
    .join(', ');
  const where = cursorValues
    ? `WHERE (${pk.map((c) => `t.${quoteIdent(c)}`).join(', ')}) > (${pk.map((_, i) => `$${i + 1}`).join(', ')})`
    : '';
  const keyColumns = pk.map((c, i) => `x.${quoteIdent(c)}::text AS k${i}`).join(', ');
  const orderColumns = pk.map((c, i) => `x.${quoteIdent(c)} AS o${i}`).join(', ');
  const windowOrder = pk.map((_, i) => `o${i}`).join(', ');
  const outerKeys = pk.map((_, i) => `z.k${i}`).join(', ');

  const text = `
SELECT z.body, ${outerKeys}, z.total::text AS total
FROM (
  SELECT y.body, ${pk.map((_, i) => `y.k${i}`).join(', ')},
         row_number() OVER w AS rn,
         sum(octet_length(y.body)) OVER w AS run,
         count(*) OVER () AS total
  FROM (
    SELECT row_to_json(x)::text AS body, ${keyColumns}, ${orderColumns}
    FROM (
      SELECT ${innerColumns}
      FROM ${qualifiedTable(table.name)} t
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${rows + 1}
    ) x
  ) y
  WINDOW w AS (ORDER BY ${windowOrder} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
) z
WHERE z.rn <= ${rows} AND (z.rn = 1 OR z.run <= ${cap})
ORDER BY z.rn`;
  return { text, params: cursorValues ?? [] };
}

function columnDefinition(column: ColumnInfo): string {
  // json/jsonb arrive as a JSON string holding the value's text, so declare them text.
  return `${quoteIdent(column.name)} ${column.json ? 'text' : column.type}`;
}

/**
 * The page writer. `column.type` is `format_type()` output from the catalog
 * (already quoted where needed), so it is spliced in as is.
 */
export function buildInsertStatement(table: TableInfo, rowsJson: string): SqlStatement {
  const names = table.columns.map((c) => c.name);
  const selectList = table.columns
    .map((c) => (c.json ? `x.${quoteIdent(c.name)}::${c.type}` : `x.${quoteIdent(c.name)}`))
    .join(', ');
  const text = `
WITH ins AS (
  INSERT INTO ${qualifiedTable(table.name)} (${quoteIdentList(names)})
  SELECT ${selectList}
  FROM json_to_recordset($1::json) AS x(${table.columns.map(columnDefinition).join(', ')})
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT count(*)::text AS inserted FROM ins`;
  return { text, params: [rowsJson] };
}

/**
 * Copy one page of `table` from `sourceSql` to `targetSql`, starting after
 * `cursor`. The source is only read. Idempotent: replaying a page inserts
 * nothing new.
 */
export async function copyTablePage(
  sourceSql: TenantSql,
  targetSql: TenantSql,
  table: TableInfo,
  cursor: CopyCursor,
  pageSize: number,
  options: CopyPageOptions = {},
): Promise<CopyPageResult> {
  const cursorValues = parseCursor(table, cursor);
  const read = buildReadStatement(table, cursorValues, pageSize, options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES);
  const rows = await queryWithStableFormat(sourceSql, read.text, read.params);

  const last = rows[rows.length - 1];
  const first = rows[0];
  if (!last || !first) return { readRows: 0, insertedRows: 0, readBytes: 0, nextCursor: cursor, done: true };

  const bodies = rows.map((row) => readString(row, 'body'));
  // Concatenate the row texts into one JSON array; the bodies are never parsed.
  const payload = `[${bodies.join(',')}]`;
  const insert = buildInsertStatement(table, payload);
  const [written] = await targetSql.query(insert.text, insert.params);
  if (!written) throw new Error(`Insert into "${table.name}" returned no count`);

  const nextCursor = JSON.stringify(table.primaryKey.map((_, i) => readString(last, `k${i}`)));
  // `total` counts every row the read fetched (page + peek row); anything not returned means more remain.
  const total = readInt(first, 'total');
  return {
    readRows: rows.length,
    insertedRows: readInt(written, 'inserted'),
    readBytes: new TextEncoder().encode(payload).length,
    nextCursor,
    done: total <= rows.length,
  };
}

export interface CopyTableOptions extends CopyPageOptions {
  /** Rows per page; defaults to `pageSizeFor(table)`. */
  pageSize?: number;
  /**
   * Pages to run before returning (2 subrequests each). Pick it so one call
   * stays inside a Workflow step's ~1000-subrequest budget; the default of 100
   * leaves ample headroom.
   */
  maxPages?: number;
}

export interface CopyTableResult {
  cursor: CopyCursor;
  done: boolean;
  pages: number;
  readRows: number;
  insertedRows: number;
  readBytes: number;
}

/** Run pages until the table is done or `maxPages` pages ran. Resume by passing the returned `cursor` back in. */
export async function copyTable(
  sourceSql: TenantSql,
  targetSql: TenantSql,
  table: TableInfo,
  cursor: CopyCursor,
  options: CopyTableOptions = {},
): Promise<CopyTableResult> {
  const pageSize = options.pageSize ?? pageSizeFor(table);
  const maxPages = assertPositiveInt(options.maxPages ?? 100, 'maxPages');
  const result: CopyTableResult = { cursor, done: false, pages: 0, readRows: 0, insertedRows: 0, readBytes: 0 };
  while (result.pages < maxPages && !result.done) {
    const page = await copyTablePage(sourceSql, targetSql, table, result.cursor, pageSize, options);
    result.cursor = page.nextCursor;
    result.done = page.done;
    result.pages += 1;
    result.readRows += page.readRows;
    result.insertedRows += page.insertedRows;
    result.readBytes += page.readBytes;
  }
  return result;
}

/** Branches per census statement; keeps the SQL text a sane size on databases with many tables. */
const CENSUS_BRANCHES_PER_QUERY = 600;

/**
 * Names of the tables that have at least one row, found with one statement
 * per 600 tables (`UNION ALL` of `exists(select 1 ...)`, which stops at the
 * first row of each table).
 */
export async function census(sql: TenantSql, tables: ReadonlyArray<Pick<TableInfo, 'name'>>): Promise<string[]> {
  const nonEmpty: string[] = [];
  for (let start = 0; start < tables.length; start += CENSUS_BRANCHES_PER_QUERY) {
    const chunk = tables.slice(start, start + CENSUS_BRANCHES_PER_QUERY);
    const text = chunk
      .map(
        (t) =>
          `SELECT ${quoteLiteral(t.name)} AS t, exists(SELECT 1 FROM ${qualifiedTable(t.name)}) AS nonempty`,
      )
      .join('\nUNION ALL\n');
    const rows = await sql.query(text);
    for (const row of rows) {
      if (readBool(row, 'nonempty')) nonEmpty.push(readString(row, 't'));
    }
  }
  return nonEmpty;
}

export interface PlannedTable {
  name: string;
  estimatedRows: number | null;
  pageSize: number;
}

export interface CopyPlan {
  /** Non-empty tables in copy order: smallest estimated size first, biggest last. */
  tables: PlannedTable[];
  /** Tables left out because they are empty. */
  skippedEmpty: number;
}

/**
 * Order the non-empty tables for copying, smallest first so most tables finish
 * early and the biggest (whose progress is the cursor) go last. Size is
 * estimated rows x row width; a never-analysed table counts as 0 and sorts
 * early. Throws if a non-empty table has no primary key, before any copying
 * starts. Foreign keys are dropped on the target, so FK order does not matter.
 */
export function planCopy(catalog: Pick<Catalog, 'tables'>, nonEmptyTables: readonly string[]): CopyPlan {
  const nonEmpty = new Set(nonEmptyTables);
  const selected = catalog.tables.filter((t) => nonEmpty.has(t.name));
  for (const table of selected) requirePrimaryKey(table);
  const size = (t: TableInfo): number => (t.estimatedRows ?? 0) * t.avgRowBytes;
  const ordered = [...selected].sort((a, b) => size(a) - size(b) || a.name.localeCompare(b.name));
  return {
    tables: ordered.map((t) => ({ name: t.name, estimatedRows: t.estimatedRows, pageSize: pageSizeFor(t) })),
    skippedEmpty: catalog.tables.length - selected.length,
  };
}
