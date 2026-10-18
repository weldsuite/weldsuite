/**
 * The charts of "Your overview", in display order: what each one draws and
 * how. Until the user changes anything they are `DEFAULT_CHARTS` (revenue,
 * expenses and net profit, then receivables, payables and cash); once they
 * add, edit, move or remove one, their whole list is stored per user in
 * `uiPreferences.weldbooksOverviewCharts`. Everything read back is checked
 * here and anything unknown is dropped or replaced by its default.
 */

import type { Compare, Metric } from './dashboard-series';

/** Trend metrics draw over a range of months; breakdowns are as of today. */
export type ChartSource = Metric | 'receivables' | 'payables' | 'cash';
export type ChartType = 'line' | 'area' | 'bar' | 'breakdown';
/** `dashboard` follows the overview's date range and compare menus. */
export type ChartRange = 'dashboard' | '3' | '6' | '12' | '24';
export type ChartCompare = 'dashboard' | Compare | 'off';

export type DashboardChart = {
  id: string;
  title: string;
  description: string;
  source: ChartSource;
  type: ChartType;
  range: ChartRange;
  compare: ChartCompare;
  color: string;
};

export const TREND_SOURCES: Metric[] = ['revenue', 'expenses', 'profit'];
export const BREAKDOWN_SOURCES: Array<Exclude<ChartSource, Metric>> = ['receivables', 'payables', 'cash'];
export const CHART_SOURCES: ChartSource[] = [...TREND_SOURCES, ...BREAKDOWN_SOURCES];
export const CHART_TYPES: ChartType[] = ['line', 'area', 'bar', 'breakdown'];
export const CHART_RANGES: ChartRange[] = ['dashboard', '3', '6', '12', '24'];
export const CHART_COMPARES: ChartCompare[] = ['dashboard', 'previousPeriod', 'previousYear', 'off'];

/** The dashboard's own chart colour first, then the theme's other chart colours. */
export const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/** Where a chart's title links to: the report or list behind its figure. */
export const SOURCE_LINKS = {
  revenue: '/weldbooks/reports/profit-loss',
  expenses: '/weldbooks/reports/profit-loss',
  profit: '/weldbooks/reports/profit-loss',
  receivables: '/weldbooks/reports/aged-receivables',
  payables: '/weldbooks/reports/aged-payables',
  cash: '/weldbooks/banking',
} as const satisfies Record<ChartSource, string>;

const defaultChart = (source: ChartSource): DashboardChart => ({
  id: `default-${source}`,
  title: '',
  description: '',
  source,
  type: TREND_SOURCES.includes(source as Metric) ? 'line' : 'breakdown',
  range: 'dashboard',
  compare: 'dashboard',
  color: 'var(--chart-1)',
});

/** The overview as it ships: an empty title and description fall back to the figure's own name and explanation. */
export const DEFAULT_CHARTS: DashboardChart[] = CHART_SOURCES.map(defaultChart);

/** True when `charts` is the default overview, untouched and in its order. */
export const isDefaultOverview = (charts: DashboardChart[]) => JSON.stringify(charts) === JSON.stringify(DEFAULT_CHARTS);

export const isTrendSource = (source: ChartSource): source is Metric => (TREND_SOURCES as string[]).includes(source);

/** A trend draws as a line, area or bars; a breakdown only as a breakdown. */
export function chartTypesFor(source: ChartSource): ChartType[] {
  return isTrendSource(source) ? ['line', 'area', 'bar'] : ['breakdown'];
}

export function newDashboardChart(): DashboardChart {
  return {
    id: `chart_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title: '',
    description: '',
    source: 'revenue',
    type: 'line',
    range: 'dashboard',
    compare: 'dashboard',
    color: CHART_COLORS[0],
  };
}

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback;

/**
 * The stored list, keeping only well-formed charts; a type that does not fit
 * the source falls back to its first. Nothing stored (or `null`, stored when
 * the list is the default again) is the default overview.
 */
export function parseDashboardCharts(value: unknown): DashboardChart[] {
  if (!Array.isArray(value)) return DEFAULT_CHARTS;
  return value.flatMap((raw): DashboardChart[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) return [];
    const source = oneOf(CHART_SOURCES, r.source, 'revenue');
    const types = chartTypesFor(source);
    return [
      {
        id: r.id,
        title: typeof r.title === 'string' ? r.title : '',
        description: typeof r.description === 'string' ? r.description : '',
        source,
        type: oneOf(types, r.type, types[0]),
        range: oneOf(CHART_RANGES, r.range, 'dashboard'),
        compare: oneOf(CHART_COMPARES, r.compare, 'dashboard'),
        color: oneOf(CHART_COLORS, r.color, CHART_COLORS[0]),
      },
    ];
  });
}
