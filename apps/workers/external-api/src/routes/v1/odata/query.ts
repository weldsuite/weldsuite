/**
 * Query options of the OData feed: parsing (`$top`, `$skip`, `$skiptoken`,
 * `$select`, `$orderby`, `$filter`, `$count`, `$format`), the SELECT built from
 * them, and paging.
 *
 * Paging: with no `$orderby` rows come in key order and the skiptoken is a
 * keyset position (`key > last`); with `$orderby` the key is appended as the
 * tie-breaker and the skiptoken is an offset. A token is base64url JSON,
 * `{"k":"<last key>"}` or `{"o":<offset>}`, and is only ours to read.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../../db';
import {
  ODATA_PAGE_SIZE,
  findProperty,
  isPlainColumn,
  type ODataEntitySet,
  type ODataProperty,
} from './catalog';
import { badRequest, notImplemented, ODataError } from './errors';
import { parseFilter, type FilterNode } from './filter';
import { filterToSql, propExpr } from './filter-sql';

export const MAX_ORDERBY_TERMS = 5;

export interface OrderTerm {
  prop: ODataProperty;
  desc: boolean;
}

export type SkipToken = { k: string } | { o: number };

export interface QueryOptions {
  top?: number;
  skip?: number;
  skiptoken?: SkipToken;
  /** `null`: every property. */
  select: ODataProperty[] | null;
  orderby: OrderTerm[];
  filter?: FilterNode;
  count: boolean;
}

/** Options that are valid OData but not served. */
const UNSUPPORTED = new Set(['$expand', '$apply', '$search', '$compute', '$levels', '$deltatoken', '$schemaversion']);
const KNOWN = new Set(['$top', '$skip', '$skiptoken', '$select', '$orderby', '$filter', '$count', '$format']);

export type Surface = 'collection' | 'count' | 'entity';

const ALLOWED: Record<Surface, ReadonlySet<string>> = {
  collection: KNOWN,
  count: new Set(['$filter', '$format']),
  entity: new Set(['$select', '$format']),
};

function nonNegativeInt(name: string, raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  return Number(raw);
}

export function encodeSkipToken(token: SkipToken): string {
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  // Without the padding it ends on.
  let end = encoded.length;
  while (end > 0 && encoded[end - 1] === '=') end--;
  return encoded.slice(0, end);
}

export function decodeSkipToken(raw: string): SkipToken {
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
    if (typeof value === 'object' && value !== null) {
      const { k, o } = value as { k?: unknown; o?: unknown };
      if (typeof k === 'string' && o === undefined) return { k };
      if (typeof o === 'number' && Number.isSafeInteger(o) && o >= 0 && k === undefined) return { o };
    }
  } catch {
    // falls through to the error below
  }
  throw badRequest('Invalid $skiptoken');
}

function parseSelect(raw: string, set: ODataEntitySet): ODataProperty[] | null {
  const names = raw.split(',').map((n) => n.trim());
  if (names.some((n) => n === '')) throw badRequest('$select has an empty item');
  if (names.includes('*')) return null;
  const wanted = new Set<string>();
  for (const name of names) {
    if (name.includes('/') || name.includes('.')) throw notImplemented(`$select paths are not supported ('${name}')`);
    if (!findProperty(set, name)) throw badRequest(`Unknown property '${name}' in $select`);
    wanted.add(name);
  }
  return set.properties.filter((p) => wanted.has(p.name));
}

function parseOrderBy(raw: string, set: ODataEntitySet): OrderTerm[] {
  const terms = raw.split(',').map((t) => t.trim());
  if (terms.length > MAX_ORDERBY_TERMS) throw badRequest(`$orderby has more than ${MAX_ORDERBY_TERMS} terms`);
  return terms.map((term) => {
    const match = /^([A-Za-z_]\w*)(?:\s+(asc|desc))?$/.exec(term);
    if (!match) {
      if (/[/(]/.test(term)) throw notImplemented('$orderby supports property names only');
      throw badRequest(`Invalid $orderby term '${term}'`);
    }
    const prop = findProperty(set, match[1]!);
    if (!prop) throw badRequest(`Unknown property '${match[1]}' in $orderby`);
    if (!prop.sortable) throw badRequest(`Property '${prop.name}' cannot be used in $orderby`);
    return { prop, desc: match[2] === 'desc' };
  });
}

/** The request's `$` options by name, each one served, given once and allowed on this surface. */
function systemOptions(params: URLSearchParams, surface: Surface): Map<string, string> {
  const seen = new Map<string, string>();
  for (const [name, value] of params) {
    if (!name.startsWith('$')) continue; // custom query options are ignored, as OData allows
    if (UNSUPPORTED.has(name.toLowerCase())) throw notImplemented(`${name} is not supported`);
    if (!KNOWN.has(name)) throw badRequest(`Unknown query option '${name}'`);
    if (seen.has(name)) throw badRequest(`${name} is given more than once`);
    if (!ALLOWED[surface].has(name)) throw badRequest(`${name} is not allowed here`);
    seen.set(name, value);
  }
  return seen;
}

function parseCount(raw: string): boolean {
  if (raw !== 'true' && raw !== 'false') throw badRequest('$count must be true or false');
  return raw === 'true';
}

/** The request's query string as options. Throws `ODataError`. */
export function parseQueryOptions(params: URLSearchParams, set: ODataEntitySet, surface: Surface): QueryOptions {
  const seen = systemOptions(params, surface);

  const format = seen.get('$format');
  if (format !== undefined && !/^(json|application\/json)(;.*)?$/i.test(format.trim())) {
    throw new ODataError(415, `$format=${format} is not supported, only json`);
  }

  const options: QueryOptions = { select: null, orderby: [], count: false };
  const top = seen.get('$top');
  if (top !== undefined) options.top = nonNegativeInt('$top', top);
  const skip = seen.get('$skip');
  if (skip !== undefined) options.skip = nonNegativeInt('$skip', skip);
  const token = seen.get('$skiptoken');
  if (token !== undefined) options.skiptoken = decodeSkipToken(token);
  const select = seen.get('$select');
  if (select !== undefined) options.select = parseSelect(select, set);
  const orderby = seen.get('$orderby');
  if (orderby !== undefined) options.orderby = parseOrderBy(orderby, set);
  const filter = seen.get('$filter');
  if (filter !== undefined) options.filter = parseFilter(filter, set);
  const count = seen.get('$count');
  if (count !== undefined) options.count = parseCount(count);

  if (options.skiptoken) {
    const keyset = 'k' in options.skiptoken;
    if (keyset === (options.orderby.length > 0)) throw badRequest('This $skiptoken does not belong to this query');
  }
  return options;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const TIMESTAMP_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;
/** The format as a SQL string literal. */
const TIMESTAMP_FORMAT_LITERAL = `'${TIMESTAMP_FORMAT}'`;

/** The property as the SELECT list item named after it. */
function selectItem(set: ODataEntitySet, prop: ODataProperty): SQL {
  const column = propExpr(set, prop);
  let value: SQL;
  switch (prop.type) {
    case 'Edm.DateTimeOffset':
      value = sql`to_char(${column}, ${sql.raw(TIMESTAMP_FORMAT_LITERAL)})`;
      break;
    case 'Collection(Edm.String)':
      value = sql`COALESCE(${column}, '[]'::jsonb)::text`;
      break;
    case 'Edm.Int64':
      value = sql`${column}::text`;
      break;
    case 'Edm.Double':
      value = sql`${column}::float8`;
      break;
    default:
      value = column;
  }
  return sql`${value} AS ${sql.identifier(prop.name)}`;
}

function whereOf(set: ODataEntitySet, conditions: SQL[]): SQL {
  const all = [...conditions];
  if (set.softDelete && isPlainColumn(set.softDelete)) {
    all.unshift(sql`${sql.identifier(set.table)}.${sql.identifier(set.softDelete)} IS NULL`);
  }
  if (all.length === 0) return sql``;
  const joined = sql.join(all, sql` AND `);
  return sql`WHERE ${joined}`;
}

type Row = Record<string, unknown>;

async function run(db: Database, statement: SQL): Promise<Row[]> {
  const result = (await db.execute(statement)) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
}

/** A database value as the JSON value of its Edm type. */
export function toJsonValue(prop: ODataProperty, raw: unknown): unknown {
  if (raw === null || raw === undefined) return prop.type === 'Collection(Edm.String)' ? [] : null;
  switch (prop.type) {
    case 'Collection(Edm.String)':
      return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    case 'Edm.Int32':
    case 'Edm.Int64':
    case 'Edm.Double':
      return typeof raw === 'number' ? raw : Number(raw);
    case 'Edm.Boolean':
      return raw === true || raw === 't' || raw === 'true';
    default:
      return raw;
  }
}

export function toEntity(properties: ODataProperty[], row: Row): Record<string, unknown> {
  const entity: Record<string, unknown> = {};
  for (const prop of properties) entity[prop.name] = toJsonValue(prop, row[prop.name]);
  return entity;
}

export interface PageResult {
  rows: Record<string, unknown>[];
  /** Position after the last row served, when there is more. */
  next: SkipToken | null;
  /** `top` left to serve after this page (only when `$top` was given). */
  remainingTop: number | null;
  /** Rows matching the filter (only when `$count=true`). */
  total: number | null;
}

/** The ORDER BY terms: what was asked, then the key as the tie-breaker unless it is one of them. */
function orderTerms(set: ODataEntitySet, orderby: OrderTerm[], keyExpr: SQL): SQL[] {
  const order: SQL[] = orderby.map(
    ({ prop, desc }) => sql`${propExpr(set, prop)} ${desc ? sql.raw('DESC NULLS LAST') : sql.raw('ASC NULLS FIRST')}`,
  );
  if (!orderby.some(({ prop }) => prop.name === set.key)) order.push(sql`${keyExpr} ASC`);
  return order;
}

/** Where the page starts. A skiptoken is the position; `$skip` only applies to the first page. */
function startOffset(options: QueryOptions): number {
  const token = options.skiptoken;
  if (!token) return options.skip ?? 0;
  return 'o' in token ? token.o : 0;
}

/** The position after the last row of a page, when there is more behind it. */
function nextPosition(options: QueryOptions, page: Row[], more: boolean, baseOffset: number): SkipToken | null {
  const last = page[page.length - 1];
  if (!more || !last) return null;
  return options.orderby.length > 0 ? { o: baseOffset + page.length } : { k: String(last.__key) };
}

/** Fetch the page the options ask for. */
export async function fetchPage(db: Database, set: ODataEntitySet, options: QueryOptions): Promise<PageResult> {
  const properties = options.select ?? set.properties;
  const keyProp = findProperty(set, set.key)!;
  const keyExpr = propExpr(set, keyProp);
  const table = sql.identifier(set.table);

  const filters: SQL[] = options.filter ? [filterToSql(options.filter, set)] : [];
  const conditions = [...filters];
  const token = options.skiptoken;
  if (token && 'k' in token) conditions.push(sql`${keyExpr} > ${token.k}::text`);

  const order = orderTerms(set, options.orderby, keyExpr);
  const baseOffset = startOffset(options);
  const wanted = Math.min(options.top ?? ODATA_PAGE_SIZE, ODATA_PAGE_SIZE);
  // One row more than we serve tells whether to link on, unless `$top` ends inside this page.
  const probe = options.top === undefined || options.top > ODATA_PAGE_SIZE ? 1 : 0;

  const list = sql.join(properties.map((p) => selectItem(set, p)), sql`, `);
  // The key is always read, for the position; it is not served unless selected.
  const keyAlias = sql`${keyExpr} AS ${sql.identifier('__key')}`;
  const where = whereOf(set, conditions);
  const orderBy = sql.join(order, sql`, `);
  const statement = sql`SELECT ${list}, ${keyAlias} FROM ${table} ${where} ORDER BY ${orderBy} LIMIT ${wanted + probe}::int OFFSET ${baseOffset}::int`;
  const countStatement = options.count
    ? sql`SELECT count(*)::text AS n FROM ${table} ${whereOf(set, filters)}`
    : null;

  const [fetched, counted] = await Promise.all([
    wanted === 0 ? Promise.resolve<Row[]>([]) : run(db, statement),
    countStatement ? run(db, countStatement) : Promise.resolve<Row[] | null>(null),
  ]);

  const page = fetched.slice(0, wanted);
  const more = fetched.length > wanted;
  return {
    rows: page.map((row) => toEntity(properties, row)),
    next: nextPosition(options, page, more, baseOffset),
    remainingTop: options.top === undefined ? null : Math.max(options.top - page.length, 0),
    total: counted ? Number(counted[0]?.n ?? 0) : null,
  };
}

/** `/$count`: rows matching the filter. */
export async function countRows(db: Database, set: ODataEntitySet, filter?: FilterNode): Promise<number> {
  const conditions = filter ? [filterToSql(filter, set)] : [];
  const rows = await run(db, sql`SELECT count(*)::text AS n FROM ${sql.identifier(set.table)} ${whereOf(set, conditions)}`);
  return Number(rows[0]?.n ?? 0);
}

/** One entity by key, or null. */
export async function fetchEntity(
  db: Database,
  set: ODataEntitySet,
  key: string,
  select: ODataProperty[] | null,
): Promise<Record<string, unknown> | null> {
  const properties = select ?? set.properties;
  const keyExpr = propExpr(set, findProperty(set, set.key)!);
  const list = sql.join(properties.map((p) => selectItem(set, p)), sql`, `);
  const where = whereOf(set, [sql`${keyExpr} = ${key}::text`]);
  const rows = await run(db, sql`SELECT ${list} FROM ${sql.identifier(set.table)} ${where} LIMIT 1`);
  return rows[0] ? toEntity(properties, rows[0]) : null;
}
