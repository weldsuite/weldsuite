/**
 * Frustration: rage clicks, dead clicks, quick backs, excessive scrolling and
 * errors, in the platform's flat style (no cards): full-width sections
 * divided by lines.
 *
 * - The standard toolbar row: Filter (device, page) narrows every number,
 *   search narrows the two lists, the freshness and period on the right.
 * - The five signals as figures that pick (`FigureRow` as tabs), each with
 *   its change on the period before.
 * - The picked signal: what it is, a way to its recordings, and its chart
 *   (this period against the one before, dashed), as on the WeldBooks
 *   dashboard.
 * - Its pages and elements side by side as top lists; a page opens the
 *   recordings that show the signal there.
 *
 * All numbers come from the trends query; nothing here needs a recording.
 */

import { useMemo, useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_DEVICE_CLASSES, type PanelDateRange, type PanelFilter, type PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Button } from '@weldsuite/ui/components/button';
import { ComparisonChart, type ComparisonPoint } from '@weldsuite/ui/components/comparison-chart';
import { FigureRow } from '@weldsuite/ui/components/figure-row';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { useWeldPanelTrends } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { DateRangePicker } from '../components/date-range-picker';
import { FreshnessBadge } from '../components/freshness-badge';
import { QueryErrorState } from '../components/query-error-state';
import { TopList, TopLists } from '../components/top-list';
import { browserTimezone, defaultInterval, useDateRange } from '../lib/date-range';
import { formatBucket, formatCompact, formatNumber, formatSignedPercent, relativeChange } from '../lib/format';
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

/** Only click-based signals carry the element that was clicked. */
const HAS_ELEMENT: Record<FrustrationKind, boolean> = { rage: true, dead: true, quickback: false, excessive_scroll: false, errors: false };

export default function FrustrationPage() {
  const { t } = useI18n();
  const tf = t.weldpanel.observe.frustration;
  return (
    <AnalyticsListPage title={tf.title}>
      {(project) => <Frustration key={project.id} project={project} />}
    </AnalyticsListPage>
  );
}

/** The toolbar's pills as query filters: Device is / is not, Page contains / does not contain. Unfinished pills are left out. */
export function frustrationFilters(active: readonly ActiveFilter[]): PanelFilter[] {
  return active.flatMap((filter): PanelFilter[] => {
    if (!filter.value) return [];
    if (filter.field === 'device') {
      return [{ source: 'column', field: 'device_type', operator: filter.operator === 'is not' ? 'neq' : 'eq', value: filter.value }];
    }
    if (filter.field === 'page') {
      return [{ source: 'column', field: 'path', operator: filter.operator === 'not contains' ? 'not_contains' : 'contains', value: filter.value }];
    }
    return [];
  });
}

function trendsSpec(projectId: string, range: PanelDateRange, events: string[], filters: PanelFilter[], breakdown?: 'path' | 'el_selector'): PanelTrendsSpec {
  return {
    kind: 'trends',
    projectId,
    dateRange: range,
    timezone: browserTimezone(),
    interval: defaultInterval(range),
    series: events.map((event) => ({ event, math: 'total' as const, filters: [] })),
    breakdown: breakdown ? { source: 'column', field: breakdown, limit: 10 } : undefined,
    // The overview compares with the period before (the figures' change and the chart's dashed line).
    compare: breakdown === undefined,
    filters,
  };
}

function Frustration({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t, language, format } = useI18n();
  const tf = t.weldpanel.observe.frustration;
  const router = useRouter();
  const canWatch = useCan('panel_recordings:read');
  const [range, setRange] = useDateRange();
  const [selected, setSelected] = useState<FrustrationKind>('rage');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [search, setSearch] = useState('');
  const filters = useMemo(() => frustrationFilters(activeFilters), [activeFilters]);
  const filterConfigs: FilterConfig[] = [
    { field: 'device', label: tf.device, options: PANEL_DEVICE_CLASSES.map((value) => ({ value, label: t.weldpanel.observe.common.devices[value] })) },
    { field: 'page', label: tf.page, filterType: 'text', operators: ['contains', 'not contains'], options: [] },
  ];

  const overviewSpec = useMemo(() => trendsSpec(project.id, range, FRUSTRATION_TYPES.map((k) => FRUSTRATION_EVENTS[k]), filters), [project.id, range, filters]);
  const pagesSpec = useMemo(() => trendsSpec(project.id, range, [FRUSTRATION_EVENTS[selected]], filters, 'path'), [project.id, range, selected, filters]);
  const elementsSpec = useMemo(() => trendsSpec(project.id, range, [FRUSTRATION_EVENTS[selected]], filters, 'el_selector'), [project.id, range, selected, filters]);

  const overview = useWeldPanelTrends(overviewSpec);
  const pages = useWeldPanelTrends(pagesSpec);
  const elements = useWeldPanelTrends(elementsSpec, { enabled: HAS_ELEMENT[selected] });

  const seriesOf = (kind: FrustrationKind) => overview.data?.result.series.find((s) => s.seriesIndex === FRUSTRATION_TYPES.indexOf(kind));
  const interval = overview.data?.result.interval ?? 'day';
  const bucketLabel = (bucket: string) => formatBucket(bucket, interval, language);

  const figures = FRUSTRATION_TYPES.map((kind) => {
    const series = seriesOf(kind);
    const total = series?.total ?? 0;
    const change = relativeChange(total, series?.previous?.total);
    return {
      key: kind,
      label: tf.types[kind],
      value: formatNumber(total, language),
      note: change === null ? tf.noneBefore : format(tf.versusBefore, { change: formatSignedPercent(change, language) }),
      // More frustration than before is the bad direction.
      warn: change !== null && change > 0,
    };
  });

  const picked = seriesOf(selected);
  const points: ComparisonPoint[] = (picked?.points ?? []).map((point, i) => {
    const before = picked?.previous?.points[i];
    return { month: point.bucket, value: point.value, compareMonth: before?.bucket, compareValue: before?.value };
  });

  const query = search.trim().toLowerCase();
  const rows = (data: typeof pages.data) =>
    (data?.result.series ?? [])
      .filter((s) => s.breakdownValue && s.total > 0 && (query === '' || s.breakdownValue.toLowerCase().includes(query)))
      .sort((a, b) => b.total - a.total)
      .map((s) => ({ value: s.breakdownValue as string, count: s.total }));

  let chart = (
    <ComparisonChart
      variant="card"
      points={points}
      label={tf.types[selected]}
      compareLabel={tf.periodBefore}
      formatTick={bucketLabel}
      formatAxisValue={(value) => formatCompact(value, language)}
      formatValue={(value) => formatNumber(value, language)}
      formatPeriod={bucketLabel}
      className="aspect-auto h-[240px] w-full"
    />
  );
  if (overview.error) chart = <QueryErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  else if (overview.isLoading) chart = <Skeleton className="h-[240px] w-full" />;
  else if (points.length === 0) chart = <p className="py-16 text-center text-sm text-muted-foreground">{tf.trendEmpty}</p>;

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">{tf.title}</h1>
      <ListToolbar
        filterSlot={<FilterPills filters={activeFilters} filterConfigs={filterConfigs} onFiltersChange={setActiveFilters} labels={{ filter: t.common.actions.filter }} />}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={tf.search}
        actionButtons={
          <>
            <FreshnessBadge dataAsOf={overview.data?.dataAsOf} cached={overview.data?.cached} fetching={overview.isFetching} onRefresh={() => void overview.refetch()} />
            <DateRangePicker value={range} onChange={setRange} />
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        {/* The signals as tabs: the picked one's underline sits on the line under the row. */}
        <section className="border-b px-4 pt-4">
          <FigureRow columns={5} items={figures} loading={overview.isLoading} selected={selected} onSelect={(key) => setSelected(key as FrustrationKind)} label={tf.signals} />
        </section>

        <section aria-label={tf.types[selected]} className="grid gap-4 border-b p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-medium">{tf.types[selected]}</h2>
              <p className="text-sm text-muted-foreground">{tf.typeHelp[selected]}</p>
            </div>
            {canWatch ? (
              <Button asChild size="sm" variant="outline">
                <Link href={frustrationHref(selected, { range, project: project.id })}>{tf.watch}</Link>
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{tf.noRecordingsPermission}</p>
            )}
          </div>
          {chart}
        </section>

        <TopLists columns={2}>
          <TopList
            title={tf.topPages}
            dimension={tf.page}
            metric={tf.count}
            rows={rows(pages.data)}
            loading={pages.isLoading}
            error={pages.error}
            onRetry={() => void pages.refetch()}
            emptyText={tf.emptyDescription}
            onSelect={canWatch ? (page) => router.push(frustrationHref(selected, { range, page, project: project.id })) : undefined}
          />
          <TopList
            title={tf.topElements}
            dimension={tf.element}
            metric={tf.count}
            rows={HAS_ELEMENT[selected] ? rows(elements.data) : []}
            loading={HAS_ELEMENT[selected] && elements.isLoading}
            error={HAS_ELEMENT[selected] ? elements.error : undefined}
            onRetry={() => void elements.refetch()}
            emptyText={HAS_ELEMENT[selected] ? tf.emptyDescription : tf.elementsHint}
          />
        </TopLists>
      </div>
    </div>
  );
}
