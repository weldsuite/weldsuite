/**
 * Pins the output formats that row text depends on. Both the page reader and
 * the checksum queries render rows as text, and the same database can render
 * the same row differently depending on `TimeZone`, `IntervalStyle` or
 * `extra_float_digits` set at database or role level. Running those statements
 * with these `SET LOCAL`s makes source and target render identically, so a
 * checksum mismatch means different data, never a different server setting.
 *
 * The settings and the query travel in ONE transaction, which on neon-http is
 * one request: no extra subrequest.
 */

import type { SqlParam, SqlRow, SqlStatement, TenantSql } from './types';

export const STABLE_FORMAT_STATEMENTS: readonly SqlStatement[] = [
  { text: `SET LOCAL TimeZone = 'UTC'` },
  { text: `SET LOCAL DateStyle = 'ISO, MDY'` },
  { text: `SET LOCAL IntervalStyle = 'postgres'` },
  { text: 'SET LOCAL extra_float_digits = 1' },
  { text: `SET LOCAL bytea_output = 'hex'` },
];

/** Run one SELECT with the format settings pinned; returns that SELECT's rows. */
export async function queryWithStableFormat(
  sql: TenantSql,
  text: string,
  params?: readonly SqlParam[],
): Promise<SqlRow[]> {
  const results = await sql.transaction([...STABLE_FORMAT_STATEMENTS, { text, params }]);
  return results[results.length - 1] ?? [];
}
