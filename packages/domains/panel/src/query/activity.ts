/**
 * Raw event reads for the places that show events as they happened: a
 * person's activity feed, a recording's timeline markers, the lexicon's names.
 * Like every statement they are built on {@link eventsScope}, so they carry
 * the workspace and project filters, the time bound and the erased-id
 * exclusion.
 */

import type { PanelActivityEvent, PanelPropertyScalar } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { CUSTOM_EVENT_NAME, PROPERTY_KEY } from '../wire';
import type { PanelQueryContext } from './context';
import { eventsScope, peopleLatest } from './scope';
import { int, lit } from './sql';
import { queryNow, resolveRange, type ResolvedRange } from './time';
import { toIso, toNullableText, toNumber, toText, type PanelSqlQuery, type Row } from './rows';

export interface ActivityOptions {
  /** One recording's events. */
  sessionId?: string;
  /** One person's events (user id or anonymous id, resolved like every query). */
  distinctId?: string;
  /** Look back this many days (default 90), within the plan's retention. */
  days?: number;
  /** Newest first. */
  limit: number;
  /** Leave out the noise a timeline does not need (`$pageleave`). */
  excludeNames?: readonly string[];
}

const ACTIVITY_COLUMNS = ['event_id', 'name', 'ts', 'path', 'url', 'title', 'session_id', 'el_text', 'error_message', 'properties'] as const;

function windowFor(ctx: PanelQueryContext, days: number | undefined): ResolvedRange {
  const preset = (days ?? 90) <= 30 ? '30d' : (days ?? 90) <= 90 ? '90d' : '12m';
  return resolveRange({ preset }, 'UTC', ctx);
}

export function activityQuery(ctx: PanelQueryContext, options: ActivityOptions): PanelSqlQuery {
  const range = windowFor(ctx, options.days);
  const scope = eventsScope(ctx, range, range);
  const extra: string[] = [];
  if (options.sessionId) extra.push(`e.session_id = ${lit(options.sessionId)}`);
  if (options.distinctId) extra.push(`${scope.person} = ${lit(options.distinctId)}`);
  if (options.excludeNames?.length) extra.push(`e.name NOT IN (${options.excludeNames.map(lit).join(', ')})`);
  const sql =
    `SELECT e.event_id AS event_id, e.name AS name, e.ts AS ts, e.path AS path, e.url AS url, e.title AS title, e.session_id AS session_id, ` +
    `e.el_text AS el_text, e.error_message AS error_message, e.properties AS properties ` +
    `FROM ${scope.from} ${scope.where(...extra)} ORDER BY e.ts DESC LIMIT ${int(options.limit, 2000)}`;
  return { name: 'activity.events', sql, columns: ACTIVITY_COLUMNS };
}

/** Events a person has had in the window, for the profile's count. */
export function activityCountQuery(ctx: PanelQueryContext, distinctId: string, days = 90): PanelSqlQuery {
  const range = windowFor(ctx, days);
  const scope = eventsScope(ctx, range, range);
  return {
    name: 'activity.count',
    sql: `SELECT COUNT(*) AS n FROM ${scope.from} ${scope.where(`${scope.person} = ${lit(distinctId)}`)}`,
    columns: ['n'],
  };
}

function scalarProperties(raw: unknown): Record<string, PanelPropertyScalar> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, PanelPropertyScalar> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function activityEventFrom(row: Row): PanelActivityEvent {
  return {
    eventId: toText(row.event_id),
    name: toText(row.name),
    ts: toIso(row.ts),
    path: toNullableText(row.path),
    url: toNullableText(row.url),
    title: toNullableText(row.title),
    sessionId: toNullableText(row.session_id),
    detail: toNullableText(row.error_message) ?? toNullableText(row.el_text),
    properties: scalarProperties(row.properties),
  };
}

// ---------------------------------------------------------------------------
// Lexicon: names seen in the data
// ---------------------------------------------------------------------------

export interface LexiconScan {
  events: { name: string; count: number }[];
  /** Property keys seen on events and on profiles. */
  properties: string[];
}

const SEEN_DAYS = 30;
const MAX_PROPERTY_SAMPLES = 2000;

function validKey(key: string): boolean {
  return PROPERTY_KEY.test(key.startsWith('$') ? key.slice(1) : key);
}

/**
 * The three statements behind the lexicon: event names with counts, the
 * property bags of the most common (event, properties) combinations, and the
 * current profiles. Last 30 days.
 */
export function lexiconQueries(ctx: PanelQueryContext): PanelSqlQuery[] {
  const range = resolveRange({ preset: '30d' }, 'UTC', ctx);
  const scope = eventsScope(ctx, range, range);
  return [
    {
      name: 'lexicon.events',
      sql: `SELECT e.name AS name, COUNT(*) AS n FROM ${scope.from} ${scope.where()} GROUP BY e.name ORDER BY COUNT(*) DESC LIMIT 500`,
      columns: ['name', 'n'],
    },
    {
      name: 'lexicon.eventProperties',
      sql:
        `SELECT e.properties AS properties, COUNT(*) AS n FROM ${scope.from} ${scope.where(`e.properties <> '{}'`)} ` +
        `GROUP BY e.properties ORDER BY COUNT(*) DESC LIMIT ${int(MAX_PROPERTY_SAMPLES, MAX_PROPERTY_SAMPLES)}`,
      columns: ['properties', 'n'],
    },
    {
      name: 'lexicon.personProperties',
      sql: `SELECT user_id, properties FROM ${peopleLatest(ctx, range)} AS latest LIMIT 1000`,
      columns: ['user_id', 'properties'],
    },
  ];
}

export function lexiconFromRows(eventRows: Row[], propertyRows: Row[], personRows: Row[]): LexiconScan {
  const events = eventRows
    .map((r) => ({ name: toText(r.name), count: toNumber(r.n) }))
    .filter((e) => e.name !== '' && (CUSTOM_EVENT_NAME.test(e.name) || /^\$[a-z]{2,32}$/.test(e.name)));
  const keys = new Set<string>();
  for (const row of [...propertyRows, ...personRows]) {
    for (const key of Object.keys(scalarProperties(row.properties))) if (validKey(key)) keys.add(key);
  }
  return { events, properties: [...keys].sort() };
}

export function lexiconWindowDays(): number {
  return SEEN_DAYS;
}

/** Runs the lexicon scan through `run` (the caller caches the result for about an hour). */
export async function runLexiconScan(
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<LexiconScan & { scannedAt: string }> {
  const [events = [], eventProps = [], people = []] = await run(lexiconQueries(ctx));
  return { ...lexiconFromRows(events, eventProps, people), scannedAt: queryNow(ctx).toISOString() };
}
