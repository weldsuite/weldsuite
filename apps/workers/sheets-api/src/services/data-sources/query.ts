/**
 * Connected tables — a definition turned into rows of cells.
 *
 * One query per listing: the object's live, visible rows (catalog.ts), the
 * definition's filters, its sort (newest first when unset) and its limit, all
 * in SQL. Values come back as sheet cells: text as text, numbers (Postgres
 * `numeric` arrives as a string) as numbers, dates as spreadsheet serial day
 * numbers so the sheet shows them as dates, booleans as booleans.
 *
 * Filter values come from the editor as text, numbers or booleans and are read
 * per field type: dates as `yyyy-mm-dd` (a whole UTC day) or an ISO date-time
 * (that instant), or a spreadsheet serial number. A value that does not fit
 * the field makes its filter match nothing; dropping the filter instead would
 * list MORE than was asked for.
 */

import { and, asc, desc, eq, gt, gte, ilike, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  MAX_SHEET_DATA_ROWS,
  SHEET_DATA_OBJECTS,
  checkSheetDataDefinition,
  type SheetDataDefinition,
  type SheetDataFieldType,
  type SheetDataFilter,
  type SheetDataObjectKey,
} from '@weldsuite/app-api-client/schemas/sheet-data';
import { DATA_SOURCES, visibilityConditions, type DataSource, type DataViewer } from './catalog';

export type { DataViewer } from './catalog';

export type DataCell = string | number | boolean | null;

/** The viewer may not list this object at all (no read permission). */
export class SheetDataPermissionError extends Error {
  constructor(readonly permission: string) {
    super(`Listing these records needs '${permission}'`);
    this.name = 'SheetDataPermissionError';
  }
}

const DAY_MS = 86_400_000;
/** Days from the spreadsheet epoch (1899-12-30) to the Unix epoch (1970-01-01). */
const SERIAL_EPOCH_OFFSET = 25_569;

/** A Unix time in ms as a spreadsheet serial: whole days for a date, with the time of day as a fraction for a date-time. */
export function toSerial(ms: number, withTime: boolean): number {
  const days = ms / DAY_MS;
  return (withTime ? days : Math.floor(days)) + SERIAL_EPOCH_OFFSET;
}

/**
 * The records of `objectType` that `viewer` may see, as rows of cells in
 * `def.columns` order (no header row).
 *
 * Throws `SheetDataPermissionError` when the viewer lacks the object's read
 * permission, and a plain Error when the definition does not fit the object
 * (callers check with `checkSheetDataDefinition` first).
 */
export async function listRecords(
  db: Database,
  objectType: SheetDataObjectKey,
  def: SheetDataDefinition,
  viewer: DataViewer,
): Promise<DataCell[][]> {
  const object = SHEET_DATA_OBJECTS[objectType];
  const source = DATA_SOURCES[objectType];
  if (!object || !source) throw new Error(`Unknown object '${String(objectType)}'`);
  const problem = checkSheetDataDefinition(objectType, def);
  if (problem) throw new Error(problem);
  if (!(await viewer.hasPermission(object.permission))) throw new SheetDataPermissionError(object.permission);

  const types = new Map(object.fields.map((field) => [field.key, field.type]));
  const typeOf = (key: string): SheetDataFieldType => types.get(key)!;

  const conditions = await visibilityConditions(source, viewer);
  for (const filter of def.filters ?? []) {
    conditions.push(filterCondition(columnOf(source, filter.field), typeOf(filter.field), filter));
  }

  const selection: Record<string, AnyPgColumn> = {};
  def.columns.forEach((key, i) => {
    selection[`c${i}`] = columnOf(source, key);
  });

  const rows = (await db
    .select(selection)
    .from(source.table)
    .where(and(...conditions))
    .orderBy(...ordering(source, def, typeOf))
    .limit(Math.min(def.limit, MAX_SHEET_DATA_ROWS))) as Array<Record<string, unknown>>;

  const columnTypes = def.columns.map(typeOf);
  return rows.map((row) => columnTypes.map((type, i) => toCell(row[`c${i}`], type)));
}

function columnOf(source: DataSource, key: string): AnyPgColumn {
  const accessor = source.columns[key];
  if (!accessor) throw new Error(`[sheets-api/data-sources] no column for field '${key}'`);
  return accessor(source.table);
}

/** ORDER BY: the sort field (text case-insensitively, empty values last), then id; newest first without a sort. */
function ordering(source: DataSource, def: SheetDataDefinition, typeOf: (key: string) => SheetDataFieldType): SQL[] {
  const { table } = source;
  if (!def.sort) return [desc(table.createdAt), desc(table.id)];
  const column = columnOf(source, def.sort.field);
  const value = typeOf(def.sort.field) === 'text' ? sql`lower(${column})` : sql`${column}`;
  return def.sort.descending
    ? [sql`${value} desc nulls last`, desc(table.id)]
    : [sql`${value} asc nulls last`, asc(table.id)];
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** A filter that can only match nothing. */
const NOTHING = sql`false`;

function filterCondition(column: AnyPgColumn, type: SheetDataFieldType, filter: SheetDataFilter): SQL {
  const { op, value } = filter;
  if (op === 'empty') return type === 'text' ? sql`coalesce(btrim(${column}), '') = ''` : isNull(column);
  if (op === 'notEmpty') return type === 'text' ? sql`coalesce(btrim(${column}), '') <> ''` : isNotNull(column);
  switch (type) {
    case 'text':
      return textCondition(column, op, value);
    case 'number':
    case 'currency':
      return numberCondition(column, op, value);
    case 'boolean':
      return booleanCondition(column, op, value);
    case 'date':
    case 'datetime':
      return dateCondition(column, op, readDate(value, type));
  }
}

type FilterValue = SheetDataFilter['value'];
type FilterOp = SheetDataFilter['op'];

/** Text compares case-insensitively; `neq` keeps empty values (they are not equal to the text). */
function textCondition(column: AnyPgColumn, op: FilterOp, value: FilterValue): SQL {
  const text = readText(value);
  if (text === null) return NOTHING;
  switch (op) {
    case 'eq':
      return sql`lower(${column}) = lower(${text}::text)`;
    case 'neq':
      return sql`(${column} is null or lower(${column}) <> lower(${text}::text))`;
    case 'contains':
      return ilike(column, `%${escapeLike(text)}%`);
    default:
      return NOTHING;
  }
}

/** Compared as `numeric`, so a fraction against an integer column neither fails nor rounds. */
function numberCondition(column: AnyPgColumn, op: FilterOp, value: FilterValue): SQL {
  const n = readNumber(value);
  if (n === null) return NOTHING;
  const v = sql`cast(${String(n)} as numeric)`;
  switch (op) {
    case 'eq':
      return sql`${column} = ${v}`;
    case 'neq':
      return sql`(${column} is null or ${column} <> ${v})`;
    case 'gt':
      return sql`${column} > ${v}`;
    case 'gte':
      return sql`${column} >= ${v}`;
    case 'lt':
      return sql`${column} < ${v}`;
    case 'lte':
      return sql`${column} <= ${v}`;
    default:
      return NOTHING;
  }
}

function booleanCondition(column: AnyPgColumn, op: FilterOp, value: FilterValue): SQL {
  const b = readBoolean(value);
  if (b === null) return NOTHING;
  if (op === 'eq') return eq(column, b);
  if (op === 'neq') return or(isNull(column), ne(column, b))!;
  return NOTHING;
}

/** A filter date: a whole UTC day, or one instant. */
type DateValue = { kind: 'day'; start: Date; end: Date } | { kind: 'instant'; at: Date };

function dateCondition(column: AnyPgColumn, op: FilterOp, value: DateValue | null): SQL {
  if (!value) return NOTHING;
  if (value.kind === 'day') {
    const { start, end } = value;
    switch (op) {
      case 'eq':
        return and(gte(column, start), lt(column, end))!;
      case 'neq':
        return or(isNull(column), lt(column, start), gte(column, end))!;
      case 'gt':
        return gte(column, end);
      case 'gte':
        return gte(column, start);
      case 'lt':
        return lt(column, start);
      case 'lte':
        return lt(column, end);
      default:
        return NOTHING;
    }
  }
  const { at } = value;
  switch (op) {
    case 'eq':
      return eq(column, at);
    case 'neq':
      return or(isNull(column), ne(column, at))!;
    case 'gt':
      return gt(column, at);
    case 'gte':
      return gte(column, at);
    case 'lt':
      return lt(column, at);
    case 'lte':
      return lte(column, at);
    default:
      return NOTHING;
  }
}

/** `%`, `_` and `\` match themselves; only the surrounding `%` is a wildcard. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function readText(value: FilterValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

const TRUE_WORDS = new Set(['true', 'yes', '1']);
const FALSE_WORDS = new Set(['false', 'no', '0']);

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function dayOf(ms: number): DateValue {
  const start = Math.floor(ms / DAY_MS) * DAY_MS;
  return { kind: 'day', start: new Date(start), end: new Date(start + DAY_MS) };
}

/**
 * A filter value as a date: `yyyy-mm-dd` is that UTC day, an ISO date-time
 * (UTC unless it names a zone) is that instant, a number is a spreadsheet
 * serial (whole = a day). On a `date` field an instant widens to its day.
 */
function readDate(value: FilterValue, type: 'date' | 'datetime'): DateValue | null {
  let parsed: DateValue | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round((value - SERIAL_EPOCH_OFFSET) * DAY_MS);
    parsed = Number.isInteger(value) ? dayOf(ms) : { kind: 'instant', at: new Date(ms) };
  } else if (typeof value === 'string') {
    parsed = readDateText(value.trim());
  }
  if (!parsed || Number.isNaN(parsed.kind === 'day' ? parsed.start.getTime() : parsed.at.getTime())) return null;
  return type === 'date' && parsed.kind === 'instant' ? dayOf(parsed.at.getTime()) : parsed;
}

/** `yyyy-mm-dd` as that UTC day, an ISO date-time as that instant; null for anything else. */
function readDateText(text: string): DateValue | null {
  const day = ISO_DAY.exec(text);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const ms = Date.UTC(y, m - 1, d);
    const check = new Date(ms);
    // Date.UTC rolls 2026-02-30 over to March; a date that does not exist is not a date.
    return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? dayOf(ms) : null;
  }
  if (!ISO_DATE_TIME.test(text)) return null;
  const iso = text.replace(' ', 'T');
  const ms = Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? { kind: 'instant', at: new Date(ms) } : null;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function toCell(value: unknown, type: SheetDataFieldType): DataCell {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'text':
      return typeof value === 'string' ? value : String(value);
    case 'number':
    case 'currency':
      return readNumber(value);
    case 'boolean':
      return readBoolean(value);
    case 'date':
    case 'datetime': {
      const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
      return Number.isFinite(ms) ? toSerial(ms, type === 'datetime') : null;
    }
  }
}
