/**
 * Verification: per-table row counts plus an order-independent checksum, so
 * the copy can be compared with its source and the source can be shown not to
 * have changed while it was copied.
 *
 * The checksum is `sum(hashtextextended(ROW(<all columns>)::text, 0))`: a
 * 64-bit hash per row, summed (as numeric, so it cannot overflow), which makes
 * it independent of row order. The row text is built from the catalog's column
 * list, so it does not depend on physical column order, and it tells an SQL
 * NULL (empty) from a jsonb `null` (the text `null`), which `to_jsonb(t)`
 * would not. Formats are pinned with `SET LOCAL` (see session-format.ts) so two
 * servers with different defaults still render a row identically.
 *
 * Cost: the hash scans every row of the table. Tables above `hashLimitRows`
 * are only counted (`hash: null`); a locked source plus matching counts is the
 * guarantee there.
 */

import { qualifiedTable, quoteIdent, quoteLiteral } from './quote';
import { readString } from './rows';
import { queryWithStableFormat } from './session-format';
import type { TableInfo, TenantSql } from './types';

export const DEFAULT_HASH_LIMIT_ROWS = 1_000_000;

export interface TableChecksum {
  count: number;
  /** Sum of the row hashes as a decimal string (it can exceed 2^53), or null when the table was above `hashLimitRows`. */
  hash: string | null;
}

/** Checksums keyed by table name. Plain JSON, safe to persist as Workflow state. */
export type ChecksumMap = Record<string, TableChecksum>;

export interface ChecksumOptions {
  /** Hash tables with at most this many rows; count-only above. Default {@link DEFAULT_HASH_LIMIT_ROWS}. */
  hashLimitRows?: number;
}

const COUNT_BRANCHES_PER_QUERY = 600;
/** Cap on the SQL text of one hash statement (the per-table column lists make branches long). */
const HASH_QUERY_MAX_CHARS = 200_000;

function chunkByLength(branches: readonly string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const branch of branches) {
    if (current.length > 0 && size + branch.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(branch);
    size += branch.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Count (and, up to `hashLimitRows`, checksum) the given tables. Pass a subset
 * to spread the work over several Workflow steps; results merge by table name.
 */
export async function tableChecksums(
  sql: TenantSql,
  tables: ReadonlyArray<Pick<TableInfo, 'name' | 'columns'>>,
  options: ChecksumOptions = {},
): Promise<ChecksumMap> {
  const hashLimit = options.hashLimitRows ?? DEFAULT_HASH_LIMIT_ROWS;
  const result: ChecksumMap = {};

  for (let start = 0; start < tables.length; start += COUNT_BRANCHES_PER_QUERY) {
    const chunk = tables.slice(start, start + COUNT_BRANCHES_PER_QUERY);
    const text = chunk
      .map((t) => `SELECT ${quoteLiteral(t.name)} AS t, count(*)::text AS n FROM ${qualifiedTable(t.name)}`)
      .join('\nUNION ALL\n');
    for (const row of await sql.query(text)) {
      const count = Number(readString(row, 'n'));
      if (!Number.isSafeInteger(count)) throw new Error(`Row count of "${readString(row, 't')}" is not a safe integer`);
      result[readString(row, 't')] = { count, hash: null };
    }
  }

  const toHash: Array<Pick<TableInfo, 'name' | 'columns'>> = [];
  for (const table of tables) {
    const entry = result[table.name];
    if (!entry) throw new Error(`No count returned for "${table.name}"`);
    if (entry.count === 0) entry.hash = '0';
    else if (entry.count <= hashLimit) toHash.push(table);
  }

  const branches = toHash.map((t) => {
    const row = `ROW(${t.columns.map((c) => `r.${quoteIdent(c.name)}`).join(', ')})::text`;
    return `SELECT ${quoteLiteral(t.name)} AS t, coalesce(sum(hashtextextended(${row}, 0)), 0)::text AS h FROM ${qualifiedTable(t.name)} r`;
  });
  for (const chunk of chunkByLength(branches, HASH_QUERY_MAX_CHARS)) {
    for (const row of await queryWithStableFormat(sql, chunk.join('\nUNION ALL\n'))) {
      const entry = result[readString(row, 't')];
      if (entry) entry.hash = readString(row, 'h');
    }
  }
  return result;
}

export type MismatchReason = 'missing-on-source' | 'missing-on-target' | 'count' | 'hash';

export interface TableComparison {
  table: string;
  ok: boolean;
  reason: MismatchReason | null;
  source: TableChecksum | null;
  target: TableChecksum | null;
  /** False when a side had no hash (table above the limit), so only counts were compared. */
  hashCompared: boolean;
}

export interface ChecksumComparison {
  ok: boolean;
  tables: TableComparison[];
  /** Names of the tables that differ. */
  mismatched: string[];
}

/** Compare two checksum maps table by table. Tables present on only one side count as mismatches. */
export function compareChecksums(source: ChecksumMap, target: ChecksumMap): ChecksumComparison {
  const names = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  const tables = names.map((table): TableComparison => {
    const s = source[table] ?? null;
    const t = target[table] ?? null;
    if (!s) return { table, ok: false, reason: 'missing-on-source', source: s, target: t, hashCompared: false };
    if (!t) return { table, ok: false, reason: 'missing-on-target', source: s, target: t, hashCompared: false };
    if (s.count !== t.count) return { table, ok: false, reason: 'count', source: s, target: t, hashCompared: false };
    const hashCompared = s.hash !== null && t.hash !== null;
    if (hashCompared && s.hash !== t.hash) return { table, ok: false, reason: 'hash', source: s, target: t, hashCompared };
    return { table, ok: true, reason: null, source: s, target: t, hashCompared };
  });
  const mismatched = tables.filter((c) => !c.ok).map((c) => c.table);
  return { ok: mismatched.length === 0, tables, mismatched };
}

export interface SourceUnchangedResult {
  unchanged: boolean;
  /** Tables whose count or checksum differ between the two readings. */
  changedTables: string[];
}

/**
 * Compare two readings of the SOURCE taken before and after the copy. Any
 * difference means something wrote to it while it was supposed to be locked,
 * and the copy must not be switched in.
 */
export function sourceUnchanged(before: ChecksumMap, after: ChecksumMap): SourceUnchangedResult {
  const comparison = compareChecksums(before, after);
  return { unchanged: comparison.ok, changedTables: comparison.mismatched };
}
