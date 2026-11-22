/**
 * Performance: Core Web Vitals from real page views (`$webvitals`).
 *
 * - First the site's pages as the standard list (`pages-list.tsx`), one row per
 *   page with its LCP, INP and CLS.
 * - A row opens that page's report in place (`?page=`), under the standard
 *   title row with a back arrow.
 * - The report: a metric tab, a percentile, a device toggle (a `device_type`
 *   filter on the spec), the summary with its rating split and chart, and the
 *   worst elements, countries and devices (and pages, when it covers the site).
 *   A saved performance report (`?report=`) opens it for the whole site.
 */

import { useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import {
  PANEL_DEVICE_CLASSES,
  PANEL_VITALS_METRICS,
  PANEL_VITALS_PERCENTILES,
  type PanelDeviceClass,
  type PanelFilter,
  type PanelVitalsMetric,
  type PanelVitalsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { RecordingHeader } from '@weldsuite/ui/components/recording-layout';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { useWeldPanelVitals } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { ReportActions } from '../components/report-actions';
import { ReportLayout } from '../components/report-layout';
import { VitalsList, VitalsSummaryView } from '../components/results/vitals-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { emptyVitalsDraft, vitalsDraftFromSpec, type VitalsDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { defaultInterval, parseRange, useDateRange } from '../lib/date-range';
import { vitalsCsvRows, vitalsListCsvRows } from '../lib/explore-csv';
import { countryName } from '../lib/format';
import { PerformancePagesList } from './pages-list';

const ALL = 'all';
type DeviceChoice = typeof ALL | PanelDeviceClass;

function isDeviceFilter(f: PanelFilter): boolean {
  return f.source === 'column' && f.field === 'device_type' && f.operator === 'eq';
}

/** The device the filters narrow to, if one. */
function deviceOf(filters: readonly PanelFilter[] | undefined): DeviceChoice {
  const f = (filters ?? []).find(isDeviceFilter);
  const value = f && f.source === 'column' ? f.value : undefined;
  return typeof value === 'string' && (PANEL_DEVICE_CLASSES as readonly string[]).includes(value) ? (value as PanelDeviceClass) : ALL;
}

function withDevice(filters: readonly PanelFilter[] | undefined, device: DeviceChoice): PanelFilter[] {
  const others = (filters ?? []).filter((f) => !isDeviceFilter(f));
  return device === ALL ? others : [...others, { source: 'column', field: 'device_type', operator: 'eq', value: device }];
}

/**
 * The report. With `path` it is that one page's report, as a page of its own: the standard
 * title row (back, the path, the report actions) and toolbar row (Filter on the device and the
 * metric tabs; search over the lists, the percentile and period) above it.
 */
function Builder({ projectId, path, onBack }: Readonly<{ projectId: string; path?: string; onBack?: () => void }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.performance;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<VitalsDraft>(emptyVitalsDraft);
  const [search, setSearch] = useState('');
  const [devicePills, setDevicePills] = useState<ActiveFilter[]>([]);

  const saved = useSavedReport({
    kind: 'vitals',
    apply: (spec, savedRange) => {
      const next = vitalsDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const spec = useMemo<PanelVitalsSpec>(() => {
    // A page's report: its path exactly, as the list shows it (paths not cleaned).
    const pageFilters: PanelFilter[] = path ? [{ source: 'column', field: 'path', operator: 'eq', value: path }] : [];
    return {
      ...draft,
      filters: [...(draft.filters ?? []), ...pageFilters],
      ...(path ? { cleanPaths: false } : {}),
      projectId,
      dateRange: range,
      interval: defaultInterval(range),
    };
  }, [draft, projectId, range, path]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelVitals(spec);
  const metric: PanelVitalsMetric = draft.metric ?? 'lcp';
  const device = deviceOf(draft.filters);
  const result = data?.result;
  const noSamples = result !== undefined && result.samples === 0;
  const csvName = saved.report?.name ?? `${tx.title} ${tx.metrics[metric]}`;
  // The device toggle owns the device filter; the chips show the rest.
  const otherFilters = (draft.filters ?? []).filter((f) => !isDeviceFilter(f));

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  const actions = <ReportActions projectId={projectId} spec={spec} report={saved.wrongKindPath ? null : saved.report} defaultName={`${tx.title} ${path ?? tx.metrics[metric]}`} onSaved={saved.open} />;
  const metricTabs = (
    <Tabs value={metric} onValueChange={(next) => setDraft((d) => ({ ...d, metric: next as PanelVitalsMetric }))}>
      <TabsList aria-label={tx.metricLabel}>
        {PANEL_VITALS_METRICS.map((m) => (
          <TabsTrigger key={m} value={m} title={tx.metricNames[m]}>
            {tx.metrics[m]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
  const percentileSelect = (
    <Select value={draft.percentile ?? 'p75'} onValueChange={(next) => setDraft((d) => ({ ...d, percentile: next as VitalsDraft['percentile'] }))}>
      <SelectTrigger size="sm" className="h-8 w-auto min-w-20" aria-label={tx.percentile}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PANEL_VITALS_PERCENTILES.map((p) => (
          <SelectItem key={p} value={p}>
            {p.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const summary = (
    <ChartCard
      title={tx.metricNames[metric]}
      loading={isLoading}
      error={error}
      onRetry={() => void refetch()}
      csv={result && !noSamples ? () => ({ filename: csvFilename(csvName), rows: vitalsCsvRows(result) }) : undefined}
    >
      {result && noSamples && <EmptyState icon={Gauge} title={tx.noSamplesTitle} description={tx.noSamples} />}
      {result && !noSamples && (
        <div className="grid gap-4">
          <VitalsSummaryView result={result} />
          {data && <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={result.range.clampedToRetention} />}
        </div>
      )}
    </ChartCard>
  );

  // Search narrows the lists under the summary, by what each row shows.
  const query = search.trim().toLowerCase();
  const countryLabel = (v: string) => (v ? countryName(v, language) : v);
  const deviceLabel = (v: string) => ((PANEL_DEVICE_CLASSES as readonly string[]).includes(v) ? tx.devices[v as PanelDeviceClass] : v);
  const matching = <T extends { value: string }>(rows: T[], label: (v: string) => string = (v) => v) =>
    query === '' ? rows : rows.filter((row) => label(row.value).toLowerCase().includes(query));
  const lists = result && !noSamples && (
    <div className="grid gap-4 lg:grid-cols-2">
      {!path && (
        <ChartCard title={tx.paths} csv={() => ({ filename: csvFilename(`${csvName} ${tx.paths}`), rows: vitalsListCsvRows(result.paths) })}>
          <VitalsList title={tx.paths} rows={matching(result.paths)} unit={result.unit} />
        </ChartCard>
      )}
      {result.elements.length > 0 && (
        <ChartCard title={tx.elements} csv={() => ({ filename: csvFilename(`${csvName} ${tx.elements}`), rows: vitalsListCsvRows(result.elements) })}>
          <VitalsList title={tx.elements} rows={matching(result.elements)} unit={result.unit} hint={tx.elementsHint} />
        </ChartCard>
      )}
      <ChartCard title={tx.countries} csv={() => ({ filename: csvFilename(`${csvName} ${tx.countries}`), rows: vitalsListCsvRows(result.countries) })}>
        <VitalsList title={tx.countries} rows={matching(result.countries, countryLabel)} unit={result.unit} valueLabel={countryLabel} />
      </ChartCard>
      <ChartCard title={tx.devicesTitle} csv={() => ({ filename: csvFilename(`${csvName} ${tx.devicesTitle}`), rows: vitalsListCsvRows(result.devices) })}>
        <VitalsList title={tx.devicesTitle} rows={matching(result.devices, deviceLabel)} unit={result.unit} valueLabel={deviceLabel} />
      </ChartCard>
    </div>
  );

  if (path) {
    const deviceConfigs: FilterConfig[] = [
      { field: 'device', label: tx.device, operators: ['is'], options: PANEL_DEVICE_CLASSES.map((value) => ({ value, label: tx.devices[value] })) },
    ];
    return (
      <div className="flex h-full flex-col">
        <RecordingHeader onBack={onBack} backLabel={tx.back} title={path} actions={actions} />
        <ListToolbar
          filterSlot={
            <FilterPills
              filters={devicePills}
              filterConfigs={deviceConfigs}
              maxFilters={1}
              onFiltersChange={(next) => {
                setDevicePills(next);
                const value = next.findLast((f) => f.field === 'device' && f.value)?.value;
                setDraft((d) => ({ ...d, filters: withDevice(d.filters, (value as PanelDeviceClass | undefined) ?? ALL) }));
              }}
              labels={{ filter: t.common.actions.filter }}
            />
          }
          leftActionButtons={metricTabs}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={tx.searchLists}
          actionButtons={
            <>
              {percentileSelect}
              <DateRangePicker value={range} onChange={setRange} />
            </>
          }
        />
        <div className="flex-1 overflow-y-auto">
          <div className="container mx-auto grid max-w-[1600px] gap-6 p-6">
            <SavedReportNotices saved={saved} />
            {summary}
            {lists}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ReportLayout title={tx.title} actions={actions} controls={<DateRangePicker value={range} onChange={setRange} />}>
      <SavedReportNotices saved={saved} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {metricTabs}
        <div className="flex flex-wrap items-center gap-3">
          {percentileSelect}
          <ToggleGroup type="single" variant="outline" size="sm" value={device} onValueChange={(next) => next && setDraft((d) => ({ ...d, filters: withDevice(d.filters, next as DeviceChoice) }))} aria-label={tx.device}>
            {([ALL, ...PANEL_DEVICE_CLASSES] as const).map((d) => (
              <ToggleGroupItem key={d} value={d} className="px-2.5 text-xs">
                {tx.devices[d]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <FilterBuilder projectId={projectId} filters={otherFilters} onChange={(filters) => setDraft((d) => ({ ...d, filters: withDevice(filters, device) }))} />

      {summary}
      {lists}
    </ReportLayout>
  );
}

/** One page's report, opened from its row; back goes to the list of pages. */
function PageReport({ projectId, path }: Readonly<{ projectId: string; path: string }>) {
  const router = useRouter();
  return (
    <PanelDefinitionsProvider projectId={projectId}>
      <Builder projectId={projectId} path={path} onBack={() => router.push('/weldpanel/performance')} />
    </PanelDefinitionsProvider>
  );
}

export default function PerformancePage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.performance;
  const params = useSearchParams();
  const page = params.get('page');

  if (page) {
    return <AnalyticsListPage title={tx.title}>{(project) => <PageReport key={`${project.id}:${page}`} projectId={project.id} path={page} />}</AnalyticsListPage>;
  }
  if (params.get('report')) {
    return (
      <AnalyticsListPage title={tx.title}>
        {(project) => (
          <PanelDefinitionsProvider key={project.id} projectId={project.id}>
            <Builder projectId={project.id} />
          </PanelDefinitionsProvider>
        )}
      </AnalyticsListPage>
    );
  }
  return <AnalyticsListPage title={tx.title}>{(project) => <PerformancePagesList key={project.id} projectId={project.id} />}</AnalyticsListPage>;
}
