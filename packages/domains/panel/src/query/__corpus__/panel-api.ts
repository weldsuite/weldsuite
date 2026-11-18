/**
 * The statements panel-api writes itself, outside the compiler, rebuilt here
 * from the same helpers so the corpus has them (a worker's code cannot be
 * imported from this package). Each builder mirrors one function and says
 * which; when that function's SQL changes, change the builder with it.
 *
 * Constants are panel-api's (`MAX_SESSIONS`, `CANDIDATE_SESSIONS`, ...).
 */

import type { PanelDeviceClass, PanelFilter } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { groupKeyProperty } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { MOBILE_MAX_WIDTH, TABLET_MAX_WIDTH } from '../../device-class';
import type { PanelQueryContext } from '../context';
import type { PanelSqlQuery } from '../rows';
import { eventsScope, eventsTable, replayChunksTable, scopeConds } from '../scope';
import { lit, ts } from '../sql';
import { resolveRange } from '../time';

const DAY_MS = 86_400_000;
const ACTIVITY_COLUMNS = ['event_id', 'name', 'ts', 'path', 'url', 'title', 'session_id', 'el_text', 'error_message', 'properties'] as const;
const FEED_EXCLUDED = ['$pageleave', '$identify'] as const;

/** recordings.ts `today`. */
function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** recordings.ts `fullRange`. */
function fullRange(now: Date): { from: string; to: string } {
  return { from: '2020-01-01', to: today(now) };
}

function nowOf(ctx: PanelQueryContext): Date {
  return ctx.now ?? new Date();
}

/** usage-projects.ts `projectUsage`: events and recordings per project in one month (`YYYY-MM`). Sent with `basinSql`, read as `project_id, n`. */
export function projectUsageQueries(workspaceId: string, month: string): PanelSqlQuery[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const scope = (column: string) => `workspace_id = ${lit(workspaceId)} AND ${column} >= ${ts(from)} AND ${column} < ${ts(to)}`;
  return [
    {
      name: 'usage.events',
      sql: `SELECT project_id, COUNT(*) AS n FROM ${eventsTable} WHERE ${scope('received_at')} GROUP BY project_id`,
      columns: ['project_id', 'n'],
    },
    {
      name: 'usage.recordings',
      sql: `SELECT project_id, COUNT(*) AS n FROM ${replayChunksTable} WHERE ${scope('ts_start')} AND seq = 0 GROUP BY project_id`,
      columns: ['project_id', 'n'],
    },
  ];
}

/** recordings.ts `chunkManifestQuery`. */
export function chunkManifestQuery(ctx: PanelQueryContext, sessionId: string): PanelSqlQuery {
  const MAX_CHUNKS = 5000;
  const range = resolveRange(fullRange(nowOf(ctx)), 'UTC', ctx);
  const conds = [...scopeConds(ctx), `ts_start >= ${ts(range.floor)}`, `ts_start <= ${ts(range.now)}`, `session_id = ${lit(sessionId)}`];
  return {
    name: 'recordings.manifest',
    sql: `SELECT seq, ts_start, ts_end, bytes, has_full_snapshot, r2_key FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} ORDER BY seq ASC LIMIT ${MAX_CHUNKS}`,
    columns: ['seq', 'ts_start', 'ts_end', 'bytes', 'has_full_snapshot', 'r2_key'],
  };
}

const inList = (values: readonly string[]) => `(${values.map(lit).join(', ')})`;

/** erasure.ts `sessionsOf`: the sessions erased ids took part in (no exclusion, no identity join). */
export function erasureSessionsQuery(base: PanelQueryContext, ids: readonly string[]): PanelSqlQuery {
  const MAX_SESSIONS = 5000;
  const ctx: PanelQueryContext = { ...base, erasedIds: [], hasIdentifiedUsers: false };
  const range = resolveRange(fullRange(nowOf(ctx)), 'UTC', ctx);
  const scope = eventsScope(ctx, range, range);
  const list = inList(ids);
  const idMatch = `(e.anon_id IN ${list} OR e.distinct_id IN ${list} OR COALESCE(e.user_id, '') IN ${list})`;
  const sql =
    `SELECT DISTINCT e.session_id AS session_id FROM ${scope.from} ` +
    `${scope.where('e.session_id IS NOT NULL', idMatch)} ` +
    `LIMIT ${MAX_SESSIONS}`;
  return { name: 'erasure.sessions', sql, columns: ['session_id'] };
}

/** erasure.ts `chunkKeysOf`: one batch (at most 200) of session ids. */
export function erasureChunksQuery(ctx: PanelQueryContext, sessionIds: readonly string[]): PanelSqlQuery {
  const MAX_CHUNK_ROWS = 20000;
  const range = resolveRange(fullRange(nowOf(ctx)), 'UTC', ctx);
  const conds = [...scopeConds(ctx), `ts_start >= ${ts(range.floor)}`, `ts_start <= ${ts(range.now)}`, `session_id IN ${inList(sessionIds)}`];
  return {
    name: 'erasure.chunks',
    sql: `SELECT r2_key FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} LIMIT ${MAX_CHUNK_ROWS}`,
    columns: ['r2_key'],
  };
}

const CANDIDATE_SESSIONS = 30;

/** heatmaps.ts `deviceCondition`. */
function deviceCondition(deviceClass: PanelDeviceClass): string {
  if (deviceClass === 'mobile') return `e.viewport_w < ${MOBILE_MAX_WIDTH}`;
  if (deviceClass === 'tablet') return `(e.viewport_w >= ${MOBILE_MAX_WIDTH} AND e.viewport_w < ${TABLET_MAX_WIDTH})`;
  return `(e.viewport_w IS NULL OR e.viewport_w >= ${TABLET_MAX_WIDTH})`;
}

/** heatmaps.ts `findSnapshotChunks`, first statement: recent sessions that opened a page of the group at the device class. */
export function snapshotVisitsQuery(ctx: PanelQueryContext, pattern: string, deviceClass: PanelDeviceClass): PanelSqlQuery {
  const range = resolveRange({ preset: '30d' }, 'UTC', ctx);
  const scope = eventsScope(ctx, range, range);
  const likePattern = lit(pattern.split('*').map((part) => part.replace(/[!%_]/g, (ch) => '!' + ch)).join('%'));
  const visitWhere = scope.where(
    `e.name = ${lit('$pageview')}`,
    'e.session_id IS NOT NULL',
    `e.path LIKE ${likePattern} ESCAPE '!'`,
    deviceCondition(deviceClass),
  );
  return {
    name: 'heatmaps.snapshot.visits',
    sql:
      `SELECT e.session_id AS session_id, MIN(e.ts) AS visited_at FROM ${scope.from} ` +
      `${visitWhere} ` +
      `GROUP BY e.session_id ORDER BY MIN(e.ts) DESC LIMIT ${CANDIDATE_SESSIONS}`,
    columns: ['session_id', 'visited_at'],
  };
}

/** heatmaps.ts `findSnapshotChunks`, second statement: the full-snapshot chunks of those sessions. */
export function snapshotChunksQuery(ctx: PanelQueryContext, sessionIds: readonly string[]): PanelSqlQuery {
  const range = resolveRange({ preset: '30d' }, 'UTC', ctx);
  const conds = [
    ...scopeConds(ctx),
    `ts_start >= ${ts(range.floor)}`,
    `ts_start <= ${ts(range.now)}`,
    'has_full_snapshot = true',
    `session_id IN (${sessionIds.map((id) => lit(id)).join(', ')})`,
  ];
  return {
    name: 'heatmaps.snapshot.chunks',
    sql: `SELECT session_id, ts_start, r2_key FROM ${replayChunksTable} WHERE ${conds.join(' AND ')} ORDER BY ts_start DESC LIMIT ${CANDIDATE_SESSIONS * 20}`,
    columns: ['session_id', 'ts_start', 'r2_key'],
  };
}

/** people.ts `cohortPeople`: the people of a cohort, most recently seen first (the context holds the cohort). */
export function cohortPeopleQuery(ctx: PanelQueryContext, cohortId: string): PanelSqlQuery {
  const MAX_COHORT_REACH = 500;
  const range = resolveRange(fullRange(nowOf(ctx)), 'UTC', ctx);
  const scope = eventsScope(ctx, range, range, { filters: [{ source: 'cohort', cohortId }] });
  return {
    name: 'people.cohort',
    sql:
      `SELECT ${scope.person} AS person, MAX(e.ts) AS last_seen FROM ${scope.from} ${scope.where()} ` +
      `GROUP BY ${scope.person} ORDER BY MAX(e.ts) DESC LIMIT ${MAX_COHORT_REACH + 1}`,
    columns: ['person', 'last_seen'],
  };
}

/** groups.ts `groupActivityQueries`: a group's recent events, its counts and its most recently seen people. */
export function groupActivityQueries(ctx: PanelQueryContext, groupType: string, groupKey: string, days: number): PanelSqlQuery[] {
  const RECENT_EVENTS = 25;
  const TOP_MEMBERS = 50;
  const now = nowOf(ctx);
  const range = resolveRange({ from: today(new Date(now.getTime() - (days - 1) * DAY_MS)), to: today(now) }, 'UTC', ctx);
  const filter: PanelFilter = { source: 'event', key: groupKeyProperty(groupType), operator: 'eq', value: groupKey };
  const scope = eventsScope(ctx, range, range, { filters: [filter] });
  const feed = `e.name NOT IN (${FEED_EXCLUDED.map(lit).join(', ')})`;
  return [
    {
      name: 'groups.events',
      sql:
        `SELECT e.event_id AS event_id, e.name AS name, e.ts AS ts, e.path AS path, e.url AS url, e.title AS title, e.session_id AS session_id, ` +
        `e.el_text AS el_text, e.error_message AS error_message, e.properties AS properties ` +
        `FROM ${scope.from} ${scope.where(feed)} ORDER BY e.ts DESC LIMIT ${RECENT_EVENTS}`,
      columns: [...ACTIVITY_COLUMNS],
    },
    {
      name: 'groups.stats',
      sql:
        `SELECT COUNT(*) AS n, COUNT(DISTINCT ${scope.person}) AS members, MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen ` +
        `FROM ${scope.from} ${scope.where()}`,
      columns: ['n', 'members', 'first_seen', 'last_seen'],
    },
    {
      name: 'groups.members',
      sql:
        `SELECT ${scope.person} AS person, MAX(e.ts) AS last_seen, COUNT(*) AS n FROM ${scope.from} ${scope.where()} ` +
        `GROUP BY ${scope.person} ORDER BY MAX(e.ts) DESC LIMIT ${TOP_MEMBERS}`,
      columns: ['person', 'last_seen', 'n'],
    },
  ];
}
