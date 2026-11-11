/**
 * CSV export of WeldDesk reports (TASK-1228): the overview as one flat table,
 * and a saved report as the points of all its charts. The same builders feed
 * the CSV routes and the CSV attached to a scheduled report email.
 *
 * Layouts (see the route docs in routes/helpdesk-analytics/index.ts):
 *
 * - overview: `section,label,metric,value,previous`
 * - saved report: `chart,label,value`
 *
 * Durations are whole seconds, exactly as the overview returns them; chart
 * values are in the chart's own unit (minutes, hours, percent, counts).
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { toCsv, type CsvCell } from '@weldsuite/worker-kit/csv';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  deskChartData,
  deskChartMetric,
  type DeskChartPoint,
  type DeskReportPair,
  type DeskReportPerson,
  type DeskReportsOverview,
} from './desk-reports';

export const OVERVIEW_CSV_HEADER = ['section', 'label', 'metric', 'value', 'previous'] as const;
export const REPORT_CSV_HEADER = ['chart', 'label', 'value'] as const;

/** The KPIs in the order the overview CSV (and the email) lists them, with how each is measured. */
export const OVERVIEW_KPIS = [
  ['created', 'count'],
  ['resolved', 'count'],
  ['firstResponseAvg', 'seconds'],
  ['firstResponseMedian', 'seconds'],
  ['resolutionAvg', 'seconds'],
  ['resolutionMedian', 'seconds'],
  ['slaCompliance', 'percent'],
  ['csat', 'percent'],
] as const satisfies ReadonlyArray<readonly [keyof DeskReportsOverview['kpis'], string]>;

type Row = CsvCell[];

function personRows(section: 'agent' | 'team', people: DeskReportPerson[]): Row[] {
  return people.flatMap((person): Row[] => [
    [section, person.name, 'created', person.created, null],
    [section, person.name, 'resolved', person.resolved, null],
    [section, person.name, 'firstResponseAvg', person.firstResponseAvg, null],
    [section, person.name, 'resolutionAvg', person.resolutionAvg, null],
    [section, person.name, 'ratings', person.ratings, null],
    [section, person.name, 'csat', person.csat, null],
  ]);
}

/**
 * The overview as `section,label,metric,value,previous`:
 *
 * - `period`: `range` (the range key), `start` and `end` (UTC dates, `end` exclusive), metric `text` / `date`
 * - `kpi`: one row per KPI (label = the KPI key), metric `count` / `seconds` / `percent`, with `previous`
 * - `count`: the counts behind the KPIs (`firstResponses`, `resolutions`, `slaMet`, `slaBreached`, `ratings`, `ratingAverage`)
 * - `backlog`: `open`, `unassigned`, `waiting` right now
 * - `series`: per bucket (label = the bucket label) the metrics `created`, `resolved`, `firstResponseAvg`, `resolutionAvg`
 * - `channel`, `priority`: conversations created per key (label), metric `created`
 * - `agent`, `team`: per person (label = name) the metrics `created`, `resolved`, `firstResponseAvg`, `resolutionAvg`, `ratings`, `csat`
 *
 * Empty `value` / `previous` means there is no data.
 */
export function overviewCsv(overview: DeskReportsOverview): string {
  const rows: Row[] = [
    ['period', 'range', 'text', overview.range.key, null],
    ['period', 'start', 'date', overview.range.start, null],
    ['period', 'end', 'date', overview.range.end, null],
  ];
  for (const [key, metric] of OVERVIEW_KPIS) {
    const pair: DeskReportPair<number | null> = overview.kpis[key];
    rows.push(['kpi', key, metric, pair.value, pair.previous]);
  }
  const counts = overview.counts;
  rows.push(
    ['count', 'firstResponses', 'count', counts.firstResponses, null],
    ['count', 'resolutions', 'count', counts.resolutions, null],
    ['count', 'slaMet', 'count', counts.slaMet, null],
    ['count', 'slaBreached', 'count', counts.slaBreached, null],
    ['count', 'ratings', 'count', counts.ratings, null],
    ['count', 'ratingAverage', 'rating', counts.ratingAverage, null],
    ['backlog', 'open', 'count', overview.backlog.open, null],
    ['backlog', 'unassigned', 'count', overview.backlog.unassigned, null],
    ['backlog', 'waiting', 'count', overview.backlog.waiting, null],
  );
  for (const point of overview.series) {
    rows.push(
      ['series', point.label, 'created', point.created, null],
      ['series', point.label, 'resolved', point.resolved, null],
      ['series', point.label, 'firstResponseAvg', point.firstResponseAvg, null],
      ['series', point.label, 'resolutionAvg', point.resolutionAvg, null],
    );
  }
  for (const item of overview.byChannel) rows.push(['channel', item.key, 'created', item.count, null]);
  for (const item of overview.byPriority) rows.push(['priority', item.key, 'created', item.count, null]);
  rows.push(...personRows('agent', overview.agents), ...personRows('team', overview.teams));
  return toCsv(OVERVIEW_CSV_HEADER, rows);
}

export interface SavedReportChartData {
  id: string;
  title: string;
  /** The chart's metric is a breakdown (by channel, agent, …) rather than a time series. */
  breakdown: boolean;
  points: DeskChartPoint[];
}

export interface SavedReportData {
  id: string;
  title: string;
  charts: SavedReportChartData[];
}

/**
 * A saved report with every chart's data as of `now`; null when the report
 * does not exist or was deleted.
 */
export async function loadSavedReport(db: Database, reportId: string, now: Date): Promise<SavedReportData | null> {
  const { helpdeskAnalyticsReports, helpdeskAnalyticsCharts } = schema;
  const [report] = await db
    .select({ id: helpdeskAnalyticsReports.id, title: helpdeskAnalyticsReports.title })
    .from(helpdeskAnalyticsReports)
    .where(and(eq(helpdeskAnalyticsReports.id, reportId), isNull(helpdeskAnalyticsReports.deletedAt)))
    .limit(1);
  if (!report) return null;
  const charts = await db
    .select()
    .from(helpdeskAnalyticsCharts)
    .where(and(eq(helpdeskAnalyticsCharts.reportId, reportId), isNull(helpdeskAnalyticsCharts.deletedAt)))
    .orderBy(asc(helpdeskAnalyticsCharts.sortIndex), asc(helpdeskAnalyticsCharts.createdAt));
  const withData = await Promise.all(
    charts.map(async (chart): Promise<SavedReportChartData> => {
      const points = await deskChartData(
        db,
        {
          entity: chart.entity,
          metric: chart.metric,
          timeRange: chart.timeRange ?? 'last_30_days',
          groupBy: chart.groupBy ?? 'day',
          aggregation: chart.aggregation ?? 'sum',
          sortOrder: chart.sortOrder ?? undefined,
          limit: chart.limit ?? undefined,
        },
        now,
      );
      return { id: chart.id, title: chart.title, breakdown: !!deskChartMetric(chart.metric)?.dimension, points };
    }),
  );
  return { id: report.id, title: report.title, charts: withData };
}

/**
 * A saved report as `chart,label,value`: one row per point of every chart, in
 * the report's chart order. A chart without data still gets one row (its
 * title, empty label and value) so it does not vanish from the file.
 */
export function savedReportCsv(report: SavedReportData): string {
  const rows: Row[] = report.charts.flatMap((chart): Row[] =>
    chart.points.length > 0
      ? chart.points.map((point): Row => [chart.title, point.label, point.value])
      : [[chart.title, null, null]],
  );
  return toCsv(REPORT_CSV_HEADER, rows);
}

/** `YYYY-MM-DD` of a moment, in UTC. */
export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function overviewCsvFilename(range: string, now: Date): string {
  return `welddesk-overview-${range}-${dateKeyOf(now)}.csv`;
}

/** `text` without the dashes at its start and end. */
function trimDashes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '-') start += 1;
  while (end > start && text[end - 1] === '-') end -= 1;
  return text.slice(start, end);
}

/**
 * `welddesk-report-<slug>-<YYYY-MM-DD>.csv`, the slug being the title in lower
 * case with every run of characters other than a-z and 0-9 turned into `-`,
 * trimmed of dashes and cut at 40 characters (the report id when nothing is left).
 */
export function reportCsvFilename(report: { id: string; title: string }, now: Date): string {
  const dashed = trimDashes(report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  // The cut can land right after a dash.
  const slug = trimDashes(dashed.slice(0, 40));
  return `welddesk-report-${slug || report.id}-${dateKeyOf(now)}.csv`;
}
