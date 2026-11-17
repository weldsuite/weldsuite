/**
 * Performance: Core Web Vitals from real page views (`$webvitals`). A metric
 * tab, a percentile, a device toggle (a `device_type` filter on the spec), the
 * summary with its rating split and chart, and the worst pages, elements,
 * countries and devices.
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
import { useWeldPanelVitals } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { ReportActions } from '../components/report-actions';
import { VitalsList, VitalsSummaryView } from '../components/results/vitals-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { emptyVitalsDraft, vitalsDraftFromSpec, type VitalsDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { defaultInterval, parseRange, useDateRange } from '../lib/date-range';
import { vitalsCsvRows, vitalsListCsvRows } from '../lib/explore-csv';
import { countryName } from '../lib/format';

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

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.performance;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<VitalsDraft>(emptyVitalsDraft);

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

  const spec = useMemo<PanelVitalsSpec>(() => ({ ...draft, projectId, dateRange: range, interval: defaultInterval(range) }), [draft, projectId, range]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelVitals(spec);
  const metric: PanelVitalsMetric = draft.metric ?? 'lcp';
  const device = deviceOf(draft.filters);
  const result = data?.result;
  const noSamples = result !== undefined && result.samples === 0;
  const csvName = saved.report?.name ?? `${tx.title} ${tx.metrics[metric]}`;
  // The device toggle owns the device filter; the chips show the rest.
  const otherFilters = (draft.filters ?? []).filter((f) => !isDeviceFilter(f));

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions projectId={projectId} spec={spec} report={saved.wrongKindPath ? null : saved.report} defaultName={`${tx.title} ${tx.metrics[metric]}`} onSaved={saved.open} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={metric} onValueChange={(next) => setDraft((d) => ({ ...d, metric: next as PanelVitalsMetric }))}>
          <TabsList aria-label={tx.metricLabel}>
            {PANEL_VITALS_METRICS.map((m) => (
              <TabsTrigger key={m} value={m} title={tx.metricNames[m]}>
                {tx.metrics[m]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-3">
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

      {result && !noSamples && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title={tx.paths} csv={() => ({ filename: csvFilename(`${csvName} ${tx.paths}`), rows: vitalsListCsvRows(result.paths) })}>
            <VitalsList title={tx.paths} rows={result.paths} unit={result.unit} />
          </ChartCard>
          {result.elements.length > 0 && (
            <ChartCard title={tx.elements} csv={() => ({ filename: csvFilename(`${csvName} ${tx.elements}`), rows: vitalsListCsvRows(result.elements) })}>
              <VitalsList title={tx.elements} rows={result.elements} unit={result.unit} hint={tx.elementsHint} />
            </ChartCard>
          )}
          <ChartCard title={tx.countries} csv={() => ({ filename: csvFilename(`${csvName} ${tx.countries}`), rows: vitalsListCsvRows(result.countries) })}>
            <VitalsList title={tx.countries} rows={result.countries} unit={result.unit} valueLabel={(v) => (v ? countryName(v, language) : v)} />
          </ChartCard>
          <ChartCard title={tx.devicesTitle} csv={() => ({ filename: csvFilename(`${csvName} ${tx.devicesTitle}`), rows: vitalsListCsvRows(result.devices) })}>
            <VitalsList
              title={tx.devicesTitle}
              rows={result.devices}
              unit={result.unit}
              valueLabel={(v) => ((PANEL_DEVICE_CLASSES as readonly string[]).includes(v) ? tx.devices[v as PanelDeviceClass] : v)}
            />
          </ChartCard>
        </div>
      )}
    </div>
  );
}

export default function PerformancePage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.performance;
  return (
    <AnalyticsPage title={tx.title} description={tx.description}>
      {(project) => (
        <PanelDefinitionsProvider key={project.id} projectId={project.id}>
          <Builder projectId={project.id} />
        </PanelDefinitionsProvider>
      )}
    </AnalyticsPage>
  );
}
