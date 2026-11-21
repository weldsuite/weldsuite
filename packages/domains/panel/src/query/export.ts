/**
 * Raw exports (panel-api's export runner): one page of one table for one time
 * window, scoped like every other query (ADR PANEL-003). The workspace and
 * project come from the authenticated {@link PanelQueryContext} through
 * `scopeConds`, erased people are left out like `eventsScope` leaves them out,
 * and every value goes through `lit()` / `num()`.
 *
 * Windows are half-open `[from, to)` on the table's time column:
 * `received_at` for events (so a late event lands in the window it arrived
 * in, and nothing is skipped), `ts` for people, identities and groups. A
 * window is at most an hour.
 *
 * Paging is keyset, never `OFFSET`: rows are ordered by the time column and a
 * tie-break key, and the next page starts after the last row of the previous
 * one ({@link exportCursorOf}). The cursor's timestamp keeps every fractional
 * digit Basin returned, so rows that share a second are neither skipped nor
 * read twice. A page asks for {@link PANEL_EXPORT_PAGE_SIZE} rows, inside Basin
 * SQL's 10,000-row `LIMIT` ceiling.
 */

import { BASIN_NAMESPACE, type PanelQueryContext } from './context';
import { PANEL_TABLES } from '../tables';
import { scopeConds } from './scope';
import { PanelQueryError, inList, int, lit, num } from './sql';
import type { PanelSqlQuery, Row } from './rows';

export const PANEL_EXPORT_TABLE_NAMES = ['events', 'people', 'groups', 'identities'] as const;
export type PanelExportTableName = (typeof PANEL_EXPORT_TABLE_NAMES)[number];

/** Rows per page. Basin SQL's `LIMIT` tops out at 10,000; rows carry JSON properties, so stay well under. */
export const PANEL_EXPORT_PAGE_SIZE = 5000;

/** Longest window one statement reads. */
export const PANEL_EXPORT_MAX_WINDOW_MS = 3_600_000;

const MAX_ERASED_IN_SQL = 5000;

type KeyKind = 'text' | 'number';

interface ExportTableDef {
  table: string;
  /** The window's column. */
  time: string;
  /** Tie-break after the time column, in order. */
  keys: { column: string; kind: KeyKind }[];
  /** Columns written to the file, in this order. */
  columns: readonly string[];
  /** Expressions whose value must not be an erased id. */
  erased: readonly string[];
}

const EVENT_COLUMNS = [
  'event_id',
  'project_id',
  'name',
  'ts',
  'received_at',
  'distinct_id',
  'anon_id',
  'user_id',
  'session_id',
  'cookieless',
  'url',
  'host',
  'path',
  'title',
  'referrer',
  'referrer_host',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'country',
  'region',
  'city',
  'device_type',
  'browser',
  'os',
  'viewport_w',
  'el_tag',
  'el_selector',
  'el_text',
  'x',
  'y',
  'rel_x',
  'rel_y',
  'scroll_depth',
  'error_message',
  'properties',
  'lib',
  'lib_version',
] as const;

const DEFS: Record<PanelExportTableName, ExportTableDef> = {
  events: {
    table: PANEL_TABLES.events,
    time: 'received_at',
    keys: [{ column: 'event_id', kind: 'text' }],
    columns: EVENT_COLUMNS,
    erased: ['anon_id', 'distinct_id', "COALESCE(user_id, '')"],
  },
  people: {
    table: PANEL_TABLES.people,
    time: 'ts',
    keys: [
      { column: 'user_id', kind: 'text' },
      { column: 'version', kind: 'number' },
    ],
    columns: ['project_id', 'user_id', 'version', 'ts', 'properties', 'deleted'],
    erased: ['user_id'],
  },
  identities: {
    table: PANEL_TABLES.identities,
    time: 'ts',
    keys: [
      { column: 'anon_id', kind: 'text' },
      { column: 'user_id', kind: 'text' },
    ],
    columns: ['project_id', 'anon_id', 'user_id', 'ts'],
    erased: ['anon_id', 'user_id'],
  },
  groups: {
    table: PANEL_TABLES.groups,
    time: 'ts',
    keys: [
      { column: 'group_type', kind: 'text' },
      { column: 'group_key', kind: 'text' },
      { column: 'version', kind: 'number' },
    ],
    columns: ['project_id', 'group_type', 'group_key', 'version', 'ts', 'properties', 'deleted'],
    // A group is a company or an account, not a person: nothing to erase.
    erased: [],
  },
};

/** The columns a file of `table` has, in order. */
export function exportColumns(table: PanelExportTableName): readonly string[] {
  return DEFS[table].columns;
}

/** Where the next page starts: the last row's time (as Basin returned it) and tie-break values. */
export interface ExportCursor {
  time: string;
  keys: (string | number)[];
}

const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,9})?(?:Z|[+-]00:?00)?$/;

/** A UTC instant as a `TIMESTAMP` literal with every fractional digit kept. */
export function exactTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new PanelQueryError('Invalid date');
    return exactTimestamp(value.toISOString());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PanelQueryError('Invalid date');
    return exactTimestamp(new Date(value).toISOString());
  }
  const match = typeof value === 'string' ? UTC_TIMESTAMP.exec(value.trim()) : null;
  if (!match) throw new PanelQueryError('Not a UTC timestamp');
  return `TIMESTAMP '${match[1]} ${match[2]}${match[3] ?? ''}'`;
}

function keyLiteral(value: string | number, kind: KeyKind): string {
  if (kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return num(n);
  }
  return lit(String(value));
}

/** `(t > T) OR (t = T AND (k1 > a OR (k1 = a AND …)))`: strictly after the cursor, in sort order. */
function afterCursor(def: ExportTableDef, cursor: ExportCursor): string {
  if (cursor.keys.length !== def.keys.length) throw new PanelQueryError('Malformed export cursor');
  const time = exactTimestamp(cursor.time);
  let tail = '';
  for (let i = def.keys.length - 1; i >= 0; i -= 1) {
    const key = def.keys[i]!;
    const value = keyLiteral(cursor.keys[i]!, key.kind);
    tail = tail ? `(${key.column} > ${value} OR (${key.column} = ${value} AND ${tail}))` : `${key.column} > ${value}`;
  }
  return `(${def.time} > ${time} OR (${def.time} = ${time} AND ${tail}))`;
}

function erasedConds(def: ExportTableDef, ctx: PanelQueryContext): string[] {
  const ids = [...new Set(ctx.erasedIds)];
  if (ids.length === 0 || def.erased.length === 0) return [];
  if (ids.length > MAX_ERASED_IN_SQL) throw new PanelQueryError('Too many erasures are waiting to be applied; try again shortly');
  const list = inList(ids);
  return def.erased.map((expr) => `${expr} NOT IN ${list}`);
}

export interface ExportPageInput {
  table: PanelExportTableName;
  /** Window start (inclusive). */
  from: Date;
  /** Window end (exclusive), at most an hour after `from`. */
  to: Date;
  /** Start after this row (the previous page's last). */
  after?: ExportCursor | null;
  limit?: number;
}

/** One page of a table's rows in a window, scoped to the context's workspace and project. */
export function exportPageQuery(ctx: PanelQueryContext, input: ExportPageInput): PanelSqlQuery {
  const def = DEFS[input.table];
  if (!def) throw new PanelQueryError('Unknown export table');
  const span = input.to.getTime() - input.from.getTime();
  if (Number.isNaN(span) || span <= 0 || span > PANEL_EXPORT_MAX_WINDOW_MS) throw new PanelQueryError('An export window is at most an hour');

  const conds = [
    ...scopeConds(ctx),
    `${def.time} >= ${exactTimestamp(input.from)}`,
    `${def.time} < ${exactTimestamp(input.to)}`,
    ...erasedConds(def, ctx),
  ];
  if (input.after) conds.push(afterCursor(def, input.after));

  const limit = int(input.limit ?? PANEL_EXPORT_PAGE_SIZE, 10_000);
  const order = [def.time, ...def.keys.map((k) => k.column)].map((c) => `${c} ASC`).join(', ');
  return {
    name: `export_${input.table}`,
    sql: `SELECT ${def.columns.join(', ')} FROM ${BASIN_NAMESPACE}.${def.table} WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`,
    columns: def.columns,
  };
}

function timeText(time: unknown): string {
  if (time instanceof Date) return time.toISOString();
  if (typeof time === 'number') return new Date(time).toISOString();
  return String(time ?? '');
}

/** The cursor after `row` (the last row of a page). */
export function exportCursorOf(table: PanelExportTableName, row: Row): ExportCursor {
  const def = DEFS[table];
  const time = row[def.time];
  return {
    time: timeText(time),
    keys: def.keys.map((key) => {
      const value = row[key.column];
      if (key.kind === 'number') return typeof value === 'number' ? value : Number(value);
      return String(value ?? '');
    }),
  };
}
