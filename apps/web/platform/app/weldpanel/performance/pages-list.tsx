/**
 * Performance's first view: the site's pages as the standard list, one row per page with its
 * Core Web Vitals (LCP, INP and CLS at p75, each with its rating) and page views. Filter on the
 * device, search the path, pick the period; a row opens that page's report (`?page=`).
 *
 * Three vitals queries (one per metric) joined by path. Paths are not cleaned by the path rules
 * here, so a row's path is exactly what the page's report filters on.
 */

import { useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import {
  PANEL_DEVICE_CLASSES,
  type PanelFilter,
  type PanelVitalsRating,
  type PanelVitalsResult,
  type PanelVitalsRow,
  type PanelVitalsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { cn } from '@weldsuite/ui/lib/utils';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/panel-entity-list';
import { useWeldPanelVitals } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { DateRangePicker } from '../components/date-range-picker';
import { formatVital } from '../components/results/vitals-result';
import { emptyVitalsDraft } from '../lib/builders';
import { defaultInterval, useDateRange } from '../lib/date-range';
import { formatNumber } from '../lib/format';

const LIST_METRICS = ['lcp', 'inp', 'cls'] as const;
type ListMetric = (typeof LIST_METRICS)[number];
const UNITS: Record<ListMetric, PanelVitalsResult['unit']> = { lcp: 'ms', inp: 'ms', cls: 'unitless' };
/** The most rows a vitals list answers. */
const MAX_PAGES = 50;

/** Where a page's performance report is. */
export const performancePageHref = (path: string) => `/weldpanel/performance?page=${encodeURIComponent(path)}`;

export interface VitalsPageRow {
  /** The path, so the list can key the row. */
  id: string;
  path: string;
  lcp: PanelVitalsRow | null;
  inp: PanelVitalsRow | null;
  cls: PanelVitalsRow | null;
  /** Page views with a measurement (the most of the three metrics). */
  views: number;
}

/** One row per path from the three metrics' page lists, most viewed first. */
export function joinVitalsPages(lists: Readonly<Record<ListMetric, readonly PanelVitalsRow[]>>): VitalsPageRow[] {
  const byPath = new Map<string, VitalsPageRow>();
  for (const metric of LIST_METRICS) {
    for (const row of lists[metric]) {
      const entry = byPath.get(row.value) ?? { id: row.value, path: row.value, lcp: null, inp: null, cls: null, views: 0 };
      entry[metric] = row;
      entry.views = Math.max(entry.views, row.samples);
      byPath.set(row.value, entry);
    }
  }
  return [...byPath.values()].sort((a, b) => b.views - a.views || a.path.localeCompare(b.path));
}

/** The Device pills as query filters; unfinished pills are left out. */
export function deviceFilters(active: readonly ActiveFilter[]): PanelFilter[] {
  return active.flatMap((filter): PanelFilter[] =>
    filter.field === 'device' && filter.value
      ? [{ source: 'column', field: 'device_type', operator: filter.operator === 'is not' ? 'neq' : 'eq', value: filter.value }]
      : [],
  );
}

const RATING_DOT: Record<PanelVitalsRating, string> = { good: 'bg-emerald-500', needs_improvement: 'bg-amber-500', poor: 'bg-red-500' };

function VitalCell({ row, metric }: Readonly<{ row: PanelVitalsRow | null; metric: ListMetric }>) {
  const { t, language } = useI18n();
  if (row?.metric === undefined || row.metric === null) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      {row.rating && <span aria-hidden className={cn('size-2 shrink-0 rounded-full', RATING_DOT[row.rating])} />}
      {formatVital(row.metric, UNITS[metric], language)}
      {row.rating && <span className="sr-only">{t.weldpanel.explore.performance.ratings[row.rating]}</span>}
    </span>
  );
}

export function PerformancePagesList({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.performance;
  const router = useRouter();
  const [range, setRange] = useDateRange();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const filters = useMemo(() => deviceFilters(activeFilters), [activeFilters]);

  const specs = useMemo(() => {
    const spec = (metric: ListMetric): PanelVitalsSpec => ({
      ...emptyVitalsDraft(),
      metric,
      limit: MAX_PAGES,
      cleanPaths: false,
      filters,
      projectId,
      dateRange: range,
      interval: defaultInterval(range),
    });
    return { lcp: spec('lcp'), inp: spec('inp'), cls: spec('cls') };
  }, [filters, projectId, range]);
  const lcp = useWeldPanelVitals(specs.lcp);
  const inp = useWeldPanelVitals(specs.inp);
  const cls = useWeldPanelVitals(specs.cls);

  const rows = useMemo(
    () =>
      joinVitalsPages({
        lcp: lcp.data?.result.paths ?? [],
        inp: inp.data?.result.paths ?? [],
        cls: cls.data?.result.paths ?? [],
      }),
    [lcp.data, inp.data, cls.data],
  );

  const filterConfigs: FilterConfig[] = [
    { field: 'device', label: tx.device, options: PANEL_DEVICE_CLASSES.map((value) => ({ value, label: tx.devices[value] })) },
  ];

  const columns: ColumnDef<VitalsPageRow>[] = [
    {
      id: 'page',
      header: tx.columns.page,
      width: 'flex-1 min-w-[200px]',
      render: (row) => <span className="block truncate font-medium">{row.path}</span>,
    },
    ...LIST_METRICS.map(
      (metric): ColumnDef<VitalsPageRow> => ({
        id: metric,
        header: tx.metrics[metric],
        width: 'hidden sm:block sm:w-[120px]',
        render: (row) => <VitalCell row={row[metric]} metric={metric} />,
      }),
    ),
    {
      id: 'views',
      header: tx.columns.samples,
      width: 'w-[110px] text-right',
      headerClassName: 'text-right',
      render: (row) => <span className="tabular-nums text-muted-foreground">{formatNumber(row.views, language)}</span>,
    },
  ];

  return (
    <PanelEntityList<VitalsPageRow>
      items={rows}
      isLoading={lcp.isLoading || inp.isLoading || cls.isLoading}
      error={lcp.error ?? inp.error ?? cls.error}
      columns={columns}
      filters={filterConfigs}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      searchPlaceholder={tx.searchPages}
      searchFields={['path']}
      actionButtons={<DateRangePicker value={range} onChange={setRange} />}
      onRowClick={(row) => router.push(performancePageHref(row.path))}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Gauge className="h-16 w-16 text-muted-foreground/50" />
          </EmptyStateIllustration>
        ),
        title: tx.noSamplesTitle,
        description: tx.noSamples,
      }}
      noResultsState={{ title: tx.noMatchTitle, description: tx.noMatchDescription }}
    />
  );
}
