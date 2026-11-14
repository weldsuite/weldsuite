import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  PANEL_INTERVALS,
  PANEL_TREND_MATHS,
  type PanelFilter,
  type PanelInterval,
  type PanelTrendMath,
  type PanelTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { Label } from '@weldsuite/ui/components/label';
import { useWeldPanelTrends } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { BreakdownPicker, isBreakdownComplete } from '../components/breakdown-picker';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker, PropertyPicker } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { TrendsResultView, type TrendsChartType } from '../components/results/trends-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyTrendsDraft, isTrendsReady, needsProperty, seriesLetter, trendsDraftFromSpec, type TrendsDraft } from '../lib/builders';
import { defaultInterval, parseRange, useDateRange } from '../lib/date-range';

const MAX_SERIES = 5;
const CHART_TYPES: TrendsChartType[] = ['line', 'bar', 'table', 'number'];

type SeriesDraft = TrendsDraft['series'][number];

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const ti = t.weldpanel.analytics.insights;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<TrendsDraft>(emptyTrendsDraft);
  const [interval, setInterval] = useState<PanelInterval | 'auto'>('auto');
  const [chartType, setChartType] = useState<TrendsChartType>('line');

  const saved = useSavedReport({
    kind: 'trends',
    apply: (spec, savedRange) => {
      const next = trendsDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      setInterval(next.interval ?? 'day');
      setChartType(next.display ?? 'line');
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const effectiveInterval = interval === 'auto' ? defaultInterval(range) : interval;
  const ready = isTrendsReady(draft);

  const spec = useMemo<PanelTrendsSpec>(
    // `display` only matters when saving (below); leaving it out keeps the query's cache key the same.
    () => ({ ...draft, display: undefined, projectId, dateRange: range, interval: effectiveInterval, breakdown: isBreakdownComplete(draft.breakdown) ? draft.breakdown : undefined }),
    [draft, projectId, range, effectiveInterval],
  );
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelTrends(spec, { enabled: ready });

  const updateSeries = (index: number, patch: Partial<SeriesDraft>) =>
    setDraft((d) => ({ ...d, series: d.series.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  const setFilters = (filters: PanelFilter[]) => setDraft((d) => ({ ...d, filters }));

  if (saved.isLoading) return <PageLoader fullScreen={false} label={ti.loadingReport} />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions
          projectId={projectId}
          spec={ready ? { ...spec, display: chartType } : null}
          report={saved.wrongKindPath ? null : saved.report}
          defaultName={defaultReportName(draft.series[0]?.event)}
          onSaved={saved.open}
        />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <SectionCard title={ti.series}>
        <div className="grid gap-4">
          {draft.series.map((series, index) => {
            const letter = seriesLetter(index);
            const math: PanelTrendMath = series.math ?? 'total';
            return (
              <div key={index} className="grid gap-3 rounded-lg border p-3" role="group" aria-label={ti.seriesN.replace('{letter}', letter)}>
                <div className="flex items-start gap-3">
                  <span className="mt-6 flex size-6 shrink-0 items-center justify-center rounded bg-primary/15 text-xs font-semibold" aria-hidden>
                    {letter}
                  </span>
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <LabeledField label={ti.event} htmlFor={`weldpanel-series-${index}-event`}>
                      <EventPicker id={`weldpanel-series-${index}-event`} projectId={projectId} value={series.event} onChange={(event) => updateSeries(index, { event })} ariaLabel={`${ti.event} ${letter}`} />
                    </LabeledField>
                    <LabeledField label={ti.measure} htmlFor={`weldpanel-series-${index}-math`}>
                      <Select value={math} onValueChange={(next) => updateSeries(index, { math: next as PanelTrendMath })}>
                        <SelectTrigger id={`weldpanel-series-${index}-math`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PANEL_TREND_MATHS.map((m) => (
                            <SelectItem key={m} value={m}>
                              {ti.measures[m]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </LabeledField>
                    {needsProperty(math) && (
                      <LabeledField label={ti.measureProperty} htmlFor={`weldpanel-series-${index}-property`}>
                        <PropertyPicker
                          id={`weldpanel-series-${index}-property`}
                          projectId={projectId}
                          value={series.property ?? ''}
                          onChange={(property) => updateSeries(index, { property })}
                          ariaLabel={`${ti.measureProperty} ${letter}`}
                        />
                      </LabeledField>
                    )}
                  </div>
                  {draft.series.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-6 size-8 shrink-0"
                      aria-label={ti.removeSeries.replace('{letter}', letter)}
                      onClick={() => setDraft((d) => ({ ...d, series: d.series.filter((_, i) => i !== index) }))}
                    >
                      <X />
                    </Button>
                  )}
                </div>
                <div className="grid gap-1 pl-9">
                  <p className="text-xs text-muted-foreground">{ti.seriesFilters}</p>
                  <FilterBuilder compact projectId={projectId} filters={series.filters ?? []} onChange={(filters) => updateSeries(index, { filters })} />
                </div>
              </div>
            );
          })}
          {draft.series.length < MAX_SERIES && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft((d) => ({ ...d, series: [...d.series, { event: '', math: 'total', filters: [] }] }))}
              >
                <Plus />
                {ti.addSeries}
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title={ti.globalFilters}>
        <div className="grid gap-5">
          <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={setFilters} />
          <BreakdownPicker projectId={projectId} value={draft.breakdown} onChange={(breakdown) => setDraft((d) => ({ ...d, breakdown }))} idPrefix="weldpanel-insights-breakdown" />
        </div>
      </SectionCard>

      <ChartCard
        title={ti.resultsTitle}
        loading={ready && isLoading}
        error={ready ? error : undefined}
        onRetry={() => void refetch()}
        empty={!ready}
        emptyText={ti.completeHint}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Select value={interval === 'auto' ? effectiveInterval : interval} onValueChange={(next) => setInterval(next as PanelInterval)}>
              <SelectTrigger size="sm" className="h-8 w-auto min-w-24" aria-label={ti.interval}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PANEL_INTERVALS.map((i) => (
                  <SelectItem key={i} value={i}>
                    {ti.intervals[i]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToggleGroup type="single" variant="outline" size="sm" value={chartType} onValueChange={(next) => next && setChartType(next as TrendsChartType)} aria-label={ti.chartType}>
              {CHART_TYPES.map((type) => (
                <ToggleGroupItem key={type} value={type} aria-label={ti.chartTypes[type]} className="px-2.5 text-xs">
                  {ti.chartTypes[type]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex items-center gap-2">
              <Switch id="weldpanel-insights-compare" checked={draft.compare ?? false} onCheckedChange={(compare) => setDraft((d) => ({ ...d, compare }))} />
              <Label htmlFor="weldpanel-insights-compare" className="text-sm font-normal">
                {t.weldpanel.analytics.range.compare}
              </Label>
            </div>
          </div>
        }
      >
        {data && (
          <div className="grid gap-3">
            <TrendsResultView result={data.result} chartType={chartType} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>

    </div>
  );
}

export default function InsightsPage() {
  const { t } = useI18n();
  const ti = t.weldpanel.analytics.insights;
  return (
    <AnalyticsPage title={ti.title} description={ti.description}>
      {(project) => <Builder key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}
