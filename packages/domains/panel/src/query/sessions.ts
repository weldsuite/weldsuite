/**
 * `sessions`: the recordings list. There is no session table, so a session is
 * an aggregate of `events_v1` by `session_id` (duration, pages, clicks,
 * frustration counts, errors, entry and exit page, device, country, person),
 * and the sessions that have recording chunks are marked from
 * `replay_chunks_v1` in a second statement for the ids on the page.
 *
 * Only consented visits have a session id (a cookieless visit has none and no
 * recording), so those are not listed.
 *
 * Pagination: the cursor is an offset. The statement asks for `offset + limit
 * + 1` rows and the rest is cut here, so no `OFFSET` reaches the engine; the
 * reach is capped at {@link MAX_SESSIONS_REACH}.
 */

import type { PanelSessionRow, PanelSessionsResult, ParsedSessionsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { cohortMembership, eventsScope, replayChunksTable, scopeConds, historyBounds } from './scope';
import { PanelQueryError, eventName, inList, int, likeContains, lit, LIKE_ESCAPE, num, ts } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toIso, toNullableText, toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

export const MAX_SESSIONS_REACH = 500;

const COLUMNS = [
  'session_id',
  'started',
  'ended',
  'duration_seconds',
  'pageviews',
  'clicks',
  'events',
  'rage',
  'dead',
  'quickback',
  'excessive',
  'errors',
  'entry_page',
  'exit_page',
  'device',
  'browser',
  'os',
  'country',
  'person',
  'user_id',
] as const;

const FRUSTRATION_NAMES: Record<string, string> = {
  rage: '$rageclick',
  dead: '$deadclick',
  quickback: '$quickback',
  excessive_scroll: '$excessivescroll',
};

/** `SUM(CASE WHEN <cond> THEN 1 ELSE 0 END)` over the session's events. */
function count(cond: string): string {
  return `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
}

const named = (name: string) => `name = ${eventName(name)}`;
const DURATION = 'to_unixtime(MAX(ts)) - to_unixtime(MIN(ts))';

function havingConditions(spec: ParsedSessionsSpec): string[] {
  const having: string[] = [];
  if (spec.minDurationSeconds !== undefined) having.push(`${DURATION} >= ${num(spec.minDurationSeconds)}`);
  if (spec.maxDurationSeconds !== undefined) having.push(`${DURATION} <= ${num(spec.maxDurationSeconds)}`);
  for (const page of spec.pagesVisited ?? []) {
    const visited = `name = ${lit('$pageview')} AND LOWER(path) LIKE ${likeContains(page)}${LIKE_ESCAPE}`;
    having.push(`${count(visited)} > 0`);
  }
  if (spec.entryPage) having.push(`MAX(CASE WHEN rn_first = 1 THEN LOWER(path) END) LIKE ${likeContains(spec.entryPage)}${LIKE_ESCAPE}`);
  if (spec.exitPage) having.push(`MAX(CASE WHEN rn_last = 1 THEN LOWER(path) END) LIKE ${likeContains(spec.exitPage)}${LIKE_ESCAPE}`);
  if (spec.countries?.length) having.push(`MAX(country) IN ${inList(spec.countries)}`);
  if (spec.devices?.length) having.push(`MAX(device_type) IN ${inList(spec.devices)}`);
  if (spec.browsers?.length) having.push(`MAX(browser) IN ${inList(spec.browsers)}`);
  for (const event of spec.didEvents ?? []) having.push(`${count(named(event))} > 0`);
  for (const event of spec.notDidEvents ?? []) having.push(`${count(named(event))} = 0`);
  for (const type of spec.frustration ?? []) {
    const name = FRUSTRATION_NAMES[type];
    if (!name) throw new PanelQueryError('Unknown frustration type');
    having.push(`${count(named(name))} > 0`);
  }
  if (spec.hasErrors) having.push(`${count(named('$exception'))} > 0`);
  return having;
}

function orderBy(spec: ParsedSessionsSpec): string {
  switch (spec.sort) {
    case 'duration_desc':
      return `${DURATION} DESC`;
    case 'pages_desc':
      return `${count(named('$pageview'))} DESC`;
    case 'frustration_desc':
      return `${count('name IN ' + inList(Object.values(FRUSTRATION_NAMES)))} DESC, MIN(ts) DESC`;
    case 'errors_desc':
      return `${count(named('$exception'))} DESC, MIN(ts) DESC`;
    default:
      return 'MIN(ts) DESC';
  }
}

/** The offset a cursor stands for. A cursor this module did not issue is refused. */
export function parseSessionsCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^o(\d{1,4})$/.exec(cursor);
  if (!match) throw new PanelQueryError('Invalid cursor');
  return Number(match[1]);
}

export function sessionsQuery(spec: ParsedSessionsSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery {
  const offset = parseSessionsCursor(spec.cursor);
  if (offset + spec.limit + 1 > MAX_SESSIONS_REACH + 1) throw new PanelQueryError('Narrow the filters to see further back');

  const scope = eventsScope(ctx, range, range);
  const extra = ['e.session_id IS NOT NULL'];

  if (spec.favoritesOnly) {
    const favourites = [...new Set(ctx.favoriteSessionIds ?? [])];
    // No favourites: the list is empty, but still a scoped, bounded statement.
    extra.push(favourites.length > 0 ? `e.session_id IN ${inList(favourites.slice(0, 1000))}` : '1 = 0');
  }
  if (spec.sessionIds?.length) extra.push(`e.session_id IN ${inList(spec.sessionIds)}`);
  if (spec.distinctId) extra.push(`${scope.person} = ${lit(spec.distinctId)}`);
  if (spec.cohortId) {
    const cohort = ctx.cohorts?.[spec.cohortId];
    if (!cohort) throw new PanelQueryError('That cohort does not exist');
    extra.push(`(${cohortMembership(cohort, ctx, range, scope.person)})`);
  }
  if (spec.hasRecording !== undefined) {
    const chunks =
      `SELECT session_id FROM ${replayChunksTable} WHERE ${[...scopeConds(ctx), ...historyBounds(ctx, range, 'ts_start')].join(' AND ')}`;
    extra.push(`e.session_id ${spec.hasRecording ? 'IN' : 'NOT IN'} (${chunks})`);
  }

  const inner =
    `SELECT e.session_id AS session_id, e.ts AS ts, e.name AS name, e.path AS path, e.device_type AS device_type, e.browser AS browser, ` +
    `e.os AS os, e.country AS country, e.user_id AS user_id, ${scope.person} AS person, ` +
    `json_get_str(e.properties, '$action') AS act, ` +
    `ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts ASC, e.event_id ASC) AS rn_first, ` +
    `ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts DESC, e.event_id DESC) AS rn_last ` +
    `FROM ${scope.from} ${scope.where(...extra)}`;

  const having = havingConditions(spec);
  const havingSql = having.length > 0 ? ` HAVING ${having.join(' AND ')}` : '';
  const clicks = count(`${named('$autocapture')} AND act = 'click'`);
  const sql =
    `SELECT session_id, MIN(ts) AS started, MAX(ts) AS ended, ${DURATION} AS duration_seconds, ` +
    `${count(named('$pageview'))} AS pageviews, ` +
    `${clicks} AS clicks, COUNT(*) AS events, ` +
    `${count(named('$rageclick'))} AS rage, ${count(named('$deadclick'))} AS dead, ${count(named('$quickback'))} AS quickback, ` +
    `${count(named('$excessivescroll'))} AS excessive, ${count(named('$exception'))} AS errors, ` +
    `MAX(CASE WHEN rn_first = 1 THEN path END) AS entry_page, MAX(CASE WHEN rn_last = 1 THEN path END) AS exit_page, ` +
    `MAX(device_type) AS device, MAX(browser) AS browser, MAX(os) AS os, MAX(country) AS country, MAX(person) AS person, MAX(user_id) AS user_id ` +
    `FROM (${inner}) AS ev GROUP BY session_id` +
    `${havingSql} ` +
    `ORDER BY ${orderBy(spec)} LIMIT ${int(offset + spec.limit + 1, MAX_SESSIONS_REACH + 1)}`;
  return { name: 'sessions.list', sql, columns: COLUMNS };
}

/** Which of `sessionIds` have recording chunks, and how many. Scoped and time-bounded like every statement. */
export function chunkCountsQuery(ctx: PanelQueryContext, range: ResolvedRange, sessionIds: readonly string[]): PanelSqlQuery {
  const conds = [
    ...scopeConds(ctx),
    `ts_start >= ${ts(range.floor)}`,
    `ts_start <= ${ts(range.now)}`,
    `session_id IN ${inList(sessionIds)}`,
  ];
  return {
    name: 'sessions.chunks',
    sql: `SELECT session_id, COUNT(*) AS chunks FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} GROUP BY session_id`,
    columns: ['session_id', 'chunks'],
  };
}

function deviceOf(value: unknown): PanelSessionRow['deviceType'] {
  return value === 'desktop' || value === 'mobile' || value === 'tablet' ? value : null;
}

export function sessionRowFrom(row: Row, chunks: number): PanelSessionRow {
  return {
    sessionId: toText(row.session_id),
    startedAt: toIso(row.started),
    endedAt: toIso(row.ended),
    durationSeconds: Math.max(Math.round(toNumber(row.duration_seconds)), 0),
    pageviews: toNumber(row.pageviews),
    clicks: toNumber(row.clicks),
    events: toNumber(row.events),
    rageClicks: toNumber(row.rage),
    deadClicks: toNumber(row.dead),
    quickBacks: toNumber(row.quickback),
    excessiveScrolls: toNumber(row.excessive),
    errors: toNumber(row.errors),
    entryPage: toNullableText(row.entry_page),
    exitPage: toNullableText(row.exit_page),
    deviceType: deviceOf(row.device),
    browser: toNullableText(row.browser),
    os: toNullableText(row.os),
    country: toNullableText(row.country),
    distinctId: toText(row.person),
    userId: toNullableText(row.user_id),
    hasRecording: chunks > 0,
    chunkCount: chunks,
    favorite: false,
  };
}

export async function runSessions(
  spec: ParsedSessionsSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelSessionsResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const offset = parseSessionsCursor(spec.cursor);
  const rows = (await run([sessionsQuery(spec, ctx, range)]))[0] ?? [];
  const page = rows.slice(offset, offset + spec.limit);
  const hasMore = rows.length > offset + spec.limit;

  const ids = page.map((r) => toText(r.session_id)).filter((id) => id !== '');
  const chunkRows = ids.length > 0 ? ((await run([chunkCountsQuery(ctx, range, ids)]))[0] ?? []) : [];
  const chunks = new Map(chunkRows.map((r) => [toText(r.session_id), toNumber(r.chunks)]));

  return {
    range: toResolvedRange(range, null),
    sessions: page.map((r) => sessionRowFrom(r, chunks.get(toText(r.session_id)) ?? 0)),
    hasMore,
    nextCursor: hasMore ? `o${offset + spec.limit}` : null,
  };
}
