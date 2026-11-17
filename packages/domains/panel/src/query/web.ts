/**
 * `web`: the Overview. Visitors, visits, pageviews, bounce rate and visit
 * duration, a daily series, top pages, entry and exit pages, channels and the
 * usual dimensions, and conversion goals. One statement per list (each reads
 * the table once), run a few at a time; visits are derived from 30-minute
 * gaps for cookieless visitors. `panels` picks the lists (`PANEL_WEB_DEFAULT_PANELS` by default);
 * paths are cleaned by the project's path rules unless `cleanPaths` is false.
 */

import {
  PANEL_SCREEN_SIZES,
  PANEL_WEB_DEFAULT_PANELS,
  type PanelBreakdownRow,
  type PanelEntryExitRow,
  type PanelInterval,
  type PanelTotals,
  type PanelWebGoalResult,
  type PanelWebPanel,
  type PanelWebResult,
  type ParsedWebSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { cleanedPathSql } from './paths';
import { eventsScope, eventWithFilters, scopeNeeds, type EventsScope } from './scope';
import { int, LIKE_ESCAPE, likePattern, lit } from './sql';
import { bucketLabel, bucketLabels, bucketSql, previousBounds, resolveRange, type ResolvedRange, type TimeBounds } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

const SESSION_GAP_SECONDS = 1800;
const PAGEVIEW = lit('$pageview');

/** Hours make sense for short ranges only; longer ones fall back to days. */
export function webInterval(range: ResolvedRange): PanelInterval {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return days <= 2 ? 'hour' : 'day';
}

type DimensionKey = Exclude<PanelWebPanel, 'entryExitPages'>;

interface DimensionDef {
  key: DimensionKey;
  expr: string;
  /** Rows without a value are left out (utm), or labelled. */
  notNull: boolean;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const SEARCH_HOSTS = ['google.', 'bing.', 'duckduckgo.', 'yahoo.', 'baidu.', 'yandex.', 'ecosia.', 'search.brave.', 'startpage.', 'qwant.'];
const SOCIAL_HOSTS = [
  'facebook.',
  'instagram.',
  't.co',
  'twitter.',
  'x.com',
  'linkedin.',
  'lnkd.in',
  'reddit.',
  'pinterest.',
  'tiktok.',
  'threads.',
  'mastodon.',
  'bsky.',
  'news.ycombinator.',
  'quora.',
];
const VIDEO_HOSTS = ['youtube.', 'youtu.be', 'vimeo.', 'twitch.', 'dailymotion.'];
const MAIL_HOSTS = ['mail.google.', 'outlook.', 'mail.yahoo.', 'webmail.', 'mail.'];

const PAID_SEARCH_MEDIUMS = ['cpc', 'ppc', 'paidsearch', 'paid-search', 'paid_search', 'sem'];
const PAID_SOCIAL_MEDIUMS = ['paid-social', 'paidsocial', 'paid_social', 'social-paid', 'social_paid', 'cpm-social'];
const DISPLAY_MEDIUMS = ['display', 'banner', 'cpm', 'expandable', 'interstitial'];
const SOCIAL_MEDIUMS = ['social', 'social-network', 'social-media', 'sm', 'social network', 'social media'];

function hostLike(hosts: readonly string[]): string {
  // Each host is matched at the start or after a dot (`www.google.nl`, `google.com`).
  return hosts
    .map((h) => {
      const atStart = likePattern(h + '*');
      const afterDot = likePattern('*.' + h + '*');
      return `(e.referrer_host LIKE ${atStart}${LIKE_ESCAPE} OR e.referrer_host LIKE ${afterDot}${LIKE_ESCAPE})`;
    })
    .join(' OR ');
}

function inValues(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(lit).join(', ')})`;
}

/**
 * The channel of an event from its referrer host and `utm_medium` (GA4's
 * default channel grouping, simplified): paid mediums first, then email,
 * affiliate, display and video, then the referrer's kind of site.
 */
export function channelSql(): string {
  const medium = `LOWER(COALESCE(e.utm_medium, ''))`;
  const referrer = `e.referrer_host`;
  const external = `(${referrer} IS NOT NULL AND ${referrer} <> '' AND (e.host IS NULL OR ${referrer} <> e.host))`;
  const whens: Array<[string, string]> = [
    [`(${inValues(medium, PAID_SEARCH_MEDIUMS)} AND NOT (${hostLike(SOCIAL_HOSTS)}))`, 'Paid Search'],
    [`(${inValues(medium, PAID_SOCIAL_MEDIUMS)} OR (${inValues(medium, PAID_SEARCH_MEDIUMS)} AND (${hostLike(SOCIAL_HOSTS)})))`, 'Paid Social'],
    [inValues(medium, DISPLAY_MEDIUMS), 'Display'],
    [`${medium} = 'affiliate'`, 'Affiliate'],
    [`(${inValues(medium, ['email', 'e-mail', 'e_mail', 'newsletter'])} OR LOWER(COALESCE(e.utm_source, '')) IN ('email', 'newsletter'))`, 'Email'],
    [`(${medium} = 'video' OR (${external} AND (${hostLike(VIDEO_HOSTS)})))`, 'Video'],
    [`(${medium} = 'organic' OR (${external} AND (${hostLike(SEARCH_HOSTS)})))`, 'Organic Search'],
    [`(${inValues(medium, SOCIAL_MEDIUMS)} OR (${external} AND (${hostLike(SOCIAL_HOSTS)})))`, 'Organic Social'],
    [`(${external} AND (${hostLike(MAIL_HOSTS)}))`, 'Email'],
    [`(NOT ${external} AND e.utm_source IS NULL AND e.utm_medium IS NULL AND e.utm_campaign IS NULL)`, 'Direct'],
    [`(${external} OR ${medium} = 'referral')`, 'Referral'],
  ];
  const cases = whens.map(([cond, label]) => 'WHEN ' + cond + ' THEN ' + lit(label));
  return `CASE ${cases.join(' ')} ELSE 'Other' END`;
}

/** Viewport width class (see `PANEL_SCREEN_SIZES`). */
export function screenSizeSql(): string {
  const [mobile, tablet, laptop, desktop, wide, unknown] = PANEL_SCREEN_SIZES;
  return (
    `CASE WHEN e.viewport_w IS NULL OR e.viewport_w <= 0 THEN ${lit(unknown)} WHEN e.viewport_w < 768 THEN ${lit(mobile)} ` +
    `WHEN e.viewport_w < 1024 THEN ${lit(tablet)} WHEN e.viewport_w < 1440 THEN ${lit(laptop)} ` +
    `WHEN e.viewport_w < 1920 THEN ${lit(desktop)} ELSE ${lit(wide)} END`
  );
}

function dimensions(ctx: PanelQueryContext, spec: ParsedWebSpec): DimensionDef[] {
  return [
    { key: 'topPages', expr: cleanedPathSql(ctx, spec.cleanPaths), notNull: false },
    { key: 'sources', expr: `COALESCE(e.referrer_host, '(direct)')`, notNull: false },
    { key: 'utmSources', expr: 'e.utm_source', notNull: true },
    { key: 'utmMediums', expr: 'e.utm_medium', notNull: true },
    { key: 'utmCampaigns', expr: 'e.utm_campaign', notNull: true },
    { key: 'countries', expr: `COALESCE(e.country, '(unknown)')`, notNull: false },
    { key: 'devices', expr: `COALESCE(e.device_type, '(unknown)')`, notNull: false },
    { key: 'browsers', expr: `COALESCE(e.browser, '(unknown)')`, notNull: false },
    { key: 'operatingSystems', expr: `COALESCE(e.os, '(unknown)')`, notNull: false },
    { key: 'hostnames', expr: `COALESCE(e.host, '(unknown)')`, notNull: false },
    { key: 'regions', expr: `(COALESCE(e.country, '??') || ' / ' || e.region)`, notNull: true },
    { key: 'cities', expr: `(COALESCE(e.country, '??') || ' / ' || e.city)`, notNull: true },
    { key: 'channels', expr: channelSql(), notNull: false },
    { key: 'screenSizes', expr: screenSizeSql(), notNull: false },
  ];
}

/** Events with their visit key: gaps over 30 minutes start a new visit (cookieless visitors have no session id). */
function visitsSql(scope: EventsScope): string {
  const partition = 'COALESCE(session_id, anon_id)';
  return (
    `WITH ev AS (SELECT ${scope.person} AS person, e.session_id AS session_id, e.anon_id AS anon_id, e.ts AS ts, e.name AS name, e.event_id AS event_id, ` +
    `LAG(e.ts) OVER (PARTITION BY COALESCE(e.session_id, e.anon_id) ORDER BY e.ts, e.event_id) AS prev_ts ` +
    `FROM ${scope.from} ${scope.where()}), ` +
    `seg AS (SELECT person, session_id, anon_id, ts, name, ` +
    `SUM(CASE WHEN prev_ts IS NULL OR to_unixtime(ts) - to_unixtime(prev_ts) > ${SESSION_GAP_SECONDS} THEN 1 ELSE 0 END) ` +
    `OVER (PARTITION BY ${partition} ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_no FROM ev), ` +
    `visit AS (SELECT ${partition} AS visit_key, seg_no, MIN(person) AS person, MIN(ts) AS t0, MAX(ts) AS t1, ` +
    `SUM(CASE WHEN name = ${PAGEVIEW} THEN 1 ELSE 0 END) AS pageviews, ` +
    `SUM(CASE WHEN name NOT IN (${PAGEVIEW}, '$pageleave') THEN 1 ELSE 0 END) AS actions ` +
    `FROM seg GROUP BY ${partition}, seg_no)`
  );
}

const SUMMARY_COLUMNS = ['visitors', 'visits', 'pageviews', 'bounces', 'duration_seconds'] as const;

function summaryQuery(name: string, ctx: PanelQueryContext, range: ResolvedRange, bounds: TimeBounds, spec: ParsedWebSpec): PanelSqlQuery {
  const scope = eventsScope(ctx, range, bounds, { filters: spec.filters });
  const sql =
    `${visitsSql(scope)} SELECT COUNT(DISTINCT person) AS visitors, COUNT(*) AS visits, SUM(pageviews) AS pageviews, ` +
    `SUM(CASE WHEN pageviews <= 1 AND actions = 0 THEN 1 ELSE 0 END) AS bounces, ` +
    `SUM(to_unixtime(t1) - to_unixtime(t0)) AS duration_seconds FROM visit`;
  return { name, sql, columns: SUMMARY_COLUMNS };
}

function seriesQuery(
  name: string,
  ctx: PanelQueryContext,
  range: ResolvedRange,
  bounds: TimeBounds,
  interval: PanelInterval,
  spec: ParsedWebSpec,
): PanelSqlQuery {
  const scope = eventsScope(ctx, range, bounds, { filters: spec.filters });
  const bucket = bucketSql('e.ts', interval, range.offsetMinutes);
  const pvWhere = scope.where(`e.name = ${PAGEVIEW}`);
  const sql =
    `SELECT ${bucket} AS bucket, COUNT(DISTINCT ${scope.person}) AS visitors, COUNT(*) AS pageviews ` +
    `FROM ${scope.from} ${pvWhere} GROUP BY ${bucket} ORDER BY ${bucket} ASC`;
  return { name, sql, columns: ['bucket', 'visitors', 'pageviews'] };
}

function entryExitQuery(ctx: PanelQueryContext, range: ResolvedRange, spec: ParsedWebSpec): PanelSqlQuery {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  const partition = 'COALESCE(session_id, anon_id)';
  const pvWhere = scope.where(`e.name = ${PAGEVIEW}`);
  const sql =
    `WITH pv AS (SELECT ${cleanedPathSql(ctx, spec.cleanPaths)} AS path, e.session_id AS session_id, e.anon_id AS anon_id, e.ts AS ts, e.event_id AS event_id, ` +
    `LAG(e.ts) OVER (PARTITION BY COALESCE(e.session_id, e.anon_id) ORDER BY e.ts, e.event_id) AS prev_ts ` +
    `FROM ${scope.from} ${pvWhere}), ` +
    `seg AS (SELECT path, session_id, anon_id, ts, event_id, ` +
    `SUM(CASE WHEN prev_ts IS NULL OR to_unixtime(ts) - to_unixtime(prev_ts) > ${SESSION_GAP_SECONDS} THEN 1 ELSE 0 END) ` +
    `OVER (PARTITION BY ${partition} ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_no FROM pv), ` +
    `ranked AS (SELECT path, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${partition}, seg_no ORDER BY ts ASC, event_id ASC) AS rn_first, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${partition}, seg_no ORDER BY ts DESC, event_id DESC) AS rn_last FROM seg) ` +
    `SELECT path, SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS entries, SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) AS exits ` +
    `FROM ranked GROUP BY path ORDER BY SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) + SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) DESC LIMIT ${int(spec.limit * 2, 200)}`;
  return { name: 'web.entryExit', sql, columns: ['path', 'entries', 'exits'] };
}

function dimensionQuery(def: DimensionDef, ctx: PanelQueryContext, range: ResolvedRange, spec: ParsedWebSpec): PanelSqlQuery {
  const scope = eventsScope(ctx, range, range, { filters: spec.filters });
  const extra = [`e.name = ${PAGEVIEW}`];
  if (def.notNull) extra.push(`${def.expr} IS NOT NULL`);
  const sql =
    `SELECT ${def.expr} AS value, COUNT(DISTINCT ${scope.person}) AS visitors, COUNT(*) AS events ` +
    `FROM ${scope.from} ${scope.where(...extra)} GROUP BY ${def.expr} ORDER BY COUNT(DISTINCT ${scope.person}) DESC, COUNT(*) DESC LIMIT ${int(spec.limit, 50)}`;
  return { name: `web.${def.key}`, sql, columns: ['value', 'visitors', 'events'] };
}

/** Every goal as a conditional count over one scan of the events that reach any goal. */
function goalsQuery(ctx: PanelQueryContext, range: ResolvedRange, spec: ParsedWebSpec): PanelSqlQuery | null {
  const goals = spec.goals ?? [];
  if (goals.length === 0) return null;
  const needs = scopeNeeds(ctx, { filters: goals.map((g) => g.filters), events: goals.flatMap((g) => (g.event ? [g.event] : [])) });
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, ...needs });
  const conds = goals.map((g) => {
    const reach = g.event
      ? eventWithFilters(g.event, g.filters, ctx, range, scope.person)
      : eventWithFilters('$pageview', g.filters, ctx, range, scope.person) + ` AND e.path LIKE ${likePattern(g.pathPattern ?? '/')}${LIKE_ESCAPE}`;
    return `(${reach})`;
  });
  const selects = conds.flatMap((cond, i) => [
    `COUNT(CASE WHEN ${cond} THEN 1 END) AS g${i}_n`,
    `COUNT(DISTINCT CASE WHEN ${cond} THEN ${scope.person} END) AS g${i}_u`,
  ]);
  const anyGoal = '(' + conds.join(' OR ') + ')';
  const sql = `SELECT ${selects.join(', ')} FROM ${scope.from} ${scope.where(anyGoal)}`;
  return { name: 'web.goals', sql, columns: goals.flatMap((_, i) => [`g${i}_n`, `g${i}_u`]) };
}

function totalsFrom(rows: Row[]): PanelTotals {
  const row = rows[0] ?? {};
  const visits = toNumber(row.visits);
  return {
    visitors: toNumber(row.visitors),
    visits,
    pageviews: toNumber(row.pageviews),
    bounceRate: visits > 0 ? Math.min(toNumber(row.bounces) / visits, 1) : 0,
    avgVisitDurationSeconds: visits > 0 ? Math.round(toNumber(row.duration_seconds) / visits) : 0,
  };
}

function seriesFrom(rows: Row[], bounds: TimeBounds, interval: PanelInterval, offset: number) {
  const byBucket = new Map(rows.map((r) => [bucketLabel(r.bucket, interval), r]));
  return bucketLabels(bounds, interval, offset).map((bucket) => {
    const row = byBucket.get(bucket);
    return { bucket, visitors: toNumber(row?.visitors), pageviews: toNumber(row?.pageviews) };
  });
}

function breakdownFrom(rows: Row[]): PanelBreakdownRow[] {
  return rows.map((r) => ({ value: toText(r.value), visitors: toNumber(r.visitors), events: toNumber(r.events) }));
}

function entryExitFrom(rows: Row[], limit: number): PanelEntryExitRow[] {
  return rows.slice(0, limit).map((r) => ({ value: toText(r.path), entries: toNumber(r.entries), exits: toNumber(r.exits) }));
}

function goalsFrom(spec: ParsedWebSpec, rows: Row[], visitors: number): PanelWebGoalResult[] {
  const row = rows[0] ?? {};
  return (spec.goals ?? []).map((goal, i) => {
    const unique = toNumber(row[`g${i}_u`]);
    return {
      label: goal.label,
      conversions: toNumber(row[`g${i}_n`]),
      uniqueConverters: unique,
      conversionRate: visitors > 0 ? Math.min(unique / visitors, 1) : 0,
    };
  });
}

export async function runWeb(
  spec: ParsedWebSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelWebResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const interval = webInterval(range);
  const previous = spec.compare ? previousBounds(range, range.floor) : null;
  const panels = new Set<PanelWebPanel>(spec.panels ?? PANEL_WEB_DEFAULT_PANELS);
  const defs = dimensions(ctx, spec).filter((def) => panels.has(def.key));

  const queries: PanelSqlQuery[] = [
    summaryQuery('web.summary', ctx, range, range, spec),
    seriesQuery('web.series', ctx, range, range, interval, spec),
    ...(panels.has('entryExitPages') ? [entryExitQuery(ctx, range, spec)] : []),
    ...defs.map((def) => dimensionQuery(def, ctx, range, spec)),
  ];
  const goals = goalsQuery(ctx, range, spec);
  if (goals) queries.push(goals);
  if (previous) {
    queries.push(
      summaryQuery('web.summary.previous', ctx, range, previous, spec),
      seriesQuery('web.series.previous', ctx, range, previous, interval, spec),
    );
  }
  const results = await run(queries);
  const at = (name: string): Row[] => results[queries.findIndex((q) => q.name === name)] ?? [];
  const list = (key: DimensionKey) => breakdownFrom(at(`web.${key}`));

  const totals = totalsFrom(at('web.summary'));
  const result: PanelWebResult = {
    range: toResolvedRange(range, previous),
    interval,
    totals,
    previousTotals: previous ? totalsFrom(at('web.summary.previous')) : null,
    series: seriesFrom(at('web.series'), range, interval, range.offsetMinutes),
    previousSeries: previous ? seriesFrom(at('web.series.previous'), previous, interval, range.offsetMinutes) : null,
    entryExitPages: entryExitFrom(at('web.entryExit'), spec.limit),
    topPages: list('topPages'),
    sources: list('sources'),
    utmSources: list('utmSources'),
    utmMediums: list('utmMediums'),
    utmCampaigns: list('utmCampaigns'),
    countries: list('countries'),
    devices: list('devices'),
    browsers: list('browsers'),
    operatingSystems: list('operatingSystems'),
  };
  for (const key of ['hostnames', 'regions', 'cities', 'channels', 'screenSizes'] as const) {
    if (panels.has(key)) result[key] = list(key);
  }
  if (spec.goals && spec.goals.length > 0) result.goals = goalsFrom(spec, at('web.goals'), totals.visitors);
  return result;
}
