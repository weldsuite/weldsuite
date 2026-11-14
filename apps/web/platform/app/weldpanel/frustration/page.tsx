/**
 * Frustration: rage clicks, dead clicks, quick backs, excessive scrolling and
 * errors over time, the pages and elements with the most of the chosen
 * signal, and a link from each to the recordings that show it. All numbers
 * come from the trends query; nothing here needs a recording.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, MousePointerClick, MousePointerBan, ScrollText } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelDateRange, PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Button } from '@weldsuite/ui/components/button';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useWeldPanelTrends } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { TimeSeriesChart, type ChartDatum, type ChartSeries } from '../components/charts/time-series-chart';
import { DateRangePicker } from '../components/date-range-picker';
import { FreshnessBadge } from '../components/freshness-badge';
import { browserTimezone, defaultInterval, useDateRange } from '../lib/date-range';
import { formatBucket, formatNumber } from '../lib/format';
import { frustrationHref } from '../lib/observe-links';

export const FRUSTRATION_TYPES = ['rage', 'dead', 'quickback', 'excessive_scroll', 'errors'] as const;
export type FrustrationKind = (typeof FRUSTRATION_TYPES)[number];

export const FRUSTRATION_EVENTS: Record<FrustrationKind, string> = {
  rage: '$rageclick',
  dead: '$deadclick',
  quickback: '$quickback',
  excessive_scroll: '$excessivescroll',
  errors: '$exception',
};

const ICONS = { rage: MousePointerClick, dead: MousePointerBan, quickback: ArrowLeftRight, excessive_scroll: ScrollText, errors: AlertTriangle } as const;

/** Only click-based signals carry the element that was clicked. */
const HAS_ELEMENT: Record<FrustrationKind, boolean> = { rage: true, dead: true, quickback: false, excessive_scroll: false, errors: false };

export default function FrustrationPage() {
  const { t } = useI18n();
  const tf = t.weldpanel.observe.frustration;
  return (
    <AnalyticsPage title={tf.title} description={tf.description}>
      {(project) => <Frustration key={project.id} project={project} />}
    </AnalyticsPage>
  );
}

function trendsSpec(projectId: string, range: PanelDateRange, events: string[], breakdown?: 'path' | 'el_selector'): PanelTrendsSpec {
  return {
    kind: 'trends',
    projectId,
    dateRange: range,
    timezone: browserTimezone(),
    interval: defaultInterval(range),
    series: events.map((event) => ({ event, math: 'total' as const, filters: [] })),
    breakdown: breakdown ? { source: 'column', field: breakdown, limit: 10 } : undefined,
    compare: false,
    filters: [],
  };
}

function Frustration({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language, format } = useI18n();
  const tf = t.weldpanel.observe.frustration;
  const canWatch = useCan('panel_recordings:read');
  const [range, setRange] = useDateRange();
  const [selected, setSelected] = useState<FrustrationKind>('rage');

  const overviewSpec = useMemo(() => trendsSpec(project.id, range, FRUSTRATION_TYPES.map((k) => FRUSTRATION_EVENTS[k])), [project.id, range]);
  const pagesSpec = useMemo(() => trendsSpec(project.id, range, [FRUSTRATION_EVENTS[selected]], 'path'), [project.id, range, selected]);
  const elementsSpec = useMemo(() => trendsSpec(project.id, range, [FRUSTRATION_EVENTS[selected]], 'el_selector'), [project.id, range, selected]);

  const overview = useWeldPanelTrends(overviewSpec);
  const pages = useWeldPanelTrends(pagesSpec);
  const elements = useWeldPanelTrends(elementsSpec, { enabled: HAS_ELEMENT[selected] });

  const totals = overview.data?.result.series ?? [];
  const totalOf = (kind: FrustrationKind) => totals.find((s) => s.seriesIndex === FRUSTRATION_TYPES.indexOf(kind))?.total ?? 0;
  const anything = totals.some((s) => s.total > 0);

  const interval = overview.data?.result.interval ?? 'day';
  const { chartData, chartSeries } = useMemo(() => {
    const series: ChartSeries[] = FRUSTRATION_TYPES.map((kind) => ({ key: kind, label: tf.types[kind] }));
    const byBucket = new Map<string, ChartDatum>();
    for (const s of overview.data?.result.series ?? []) {
      const kind = FRUSTRATION_TYPES[s.seriesIndex];
      if (!kind) continue;
      for (const point of s.points) {
        const row = byBucket.get(point.bucket) ?? ({ label: formatBucket(point.bucket, interval, language) } as ChartDatum);
        row[kind] = point.value;
        byBucket.set(point.bucket, row);
      }
    }
    return { chartData: [...byBucket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row), chartSeries: series };
  }, [overview.data, interval, language, tf.types]);

  const rows = (data: typeof pages.data) =>
    (data?.result.series ?? [])
      .filter((s) => s.breakdownValue && s.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((s) => ({ value: s.breakdownValue as string, count: s.total }));
  const pageRows = rows(pages.data);
  const elementRows = rows(elements.data);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FreshnessBadge dataAsOf={overview.data?.dataAsOf} cached={overview.data?.cached} fetching={overview.isFetching} onRefresh={() => void overview.refetch()} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      <KpiGrid className="sm:grid-cols-2 lg:grid-cols-5">
        {FRUSTRATION_TYPES.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={selected === kind}
            aria-label={tf.types[kind]}
            onClick={() => setSelected(kind)}
            className={`rounded-xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${selected === kind ? 'ring-2 ring-primary' : ''}`}
          >
            <KpiCard
              interactive
              label={tf.types[kind]}
              icon={ICONS[kind]}
              loading={overview.isLoading}
              value={formatNumber(totalOf(kind), language)}
              tone={kind === 'errors' && totalOf(kind) > 0 ? 'danger' : totalOf(kind) > 0 ? 'warning' : 'default'}
            />
          </button>
        ))}
      </KpiGrid>

      <ChartCard title={tf.trend} loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()} empty={!anything} emptyText={tf.trendEmpty}>
        <TimeSeriesChart data={chartData} series={chartSeries} type="line" locale={language} legend />
      </ChartCard>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{tf.types[selected]}</p>
          <p className="text-sm text-muted-foreground">{tf.typeHelp[selected]}</p>
        </div>
        {canWatch ? (
          <Button asChild size="sm">
            <Link href={frustrationHref(selected, { range, project: project.id })}>{tf.watch}</Link>
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{tf.noRecordingsPermission}</p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title={tf.topPages} loading={pages.isLoading} error={pages.error} onRetry={() => void pages.refetch()} empty={pageRows.length === 0} emptyText={tf.emptyDescription}>
          <SignalTable heading={tf.page} rows={pageRows} canWatch={canWatch} watchLabel={(value) => format(tf.watchPage, { value })} hrefFor={(value) => frustrationHref(selected, { range, page: value, project: project.id })} />
        </ChartCard>
        <ChartCard
          title={tf.topElements}
          loading={HAS_ELEMENT[selected] && elements.isLoading}
          error={HAS_ELEMENT[selected] ? elements.error : undefined}
          onRetry={() => void elements.refetch()}
          empty={!HAS_ELEMENT[selected] || elementRows.length === 0}
          emptyText={HAS_ELEMENT[selected] ? tf.emptyDescription : tf.elementsHint}
        >
          <SignalTable heading={tf.element} rows={elementRows} canWatch={false} watchLabel={() => ''} hrefFor={() => ''} mono />
        </ChartCard>
      </div>
    </div>
  );
}

function SignalTable({
  heading,
  rows,
  canWatch,
  watchLabel,
  hrefFor,
  mono,
}: Readonly<{ heading: string; rows: { value: string; count: number }[]; canWatch: boolean; watchLabel: (value: string) => string; hrefFor: (value: string) => string; mono?: boolean }>) {
  const { t, language } = useI18n();
  const tf = t.weldpanel.observe.frustration;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{heading}</TableHead>
            <TableHead className="text-right">{tf.count}</TableHead>
            {canWatch && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.value}>
              <TableCell className={`max-w-72 truncate ${mono ? 'font-mono text-xs' : ''}`} title={row.value}>
                {row.value}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(row.count, language)}</TableCell>
              {canWatch && (
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm" aria-label={watchLabel(row.value)}>
                    <Link href={hrefFor(row.value)}>{tf.watch}</Link>
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
