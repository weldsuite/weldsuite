import { useMemo, useState } from 'react';
import { Plus, SearchCheck, X } from 'lucide-react';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import {
  PANEL_INTERVALS,
  PANEL_TREND_MATHS,
  PANEL_TRENDS_DISPLAYS,
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
import { BreakdownsPicker, completeBreakdowns } from '../components/breakdown-picker';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { PanelDefinitionsProvider, useDefinitionLabels, usePanelDefinitions } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker, PropertyPicker } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { TrendsResultView, trendLines, type TrendsChartType } from '../components/results/trends-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyTrendsDraft, isTrendsReady, needsProperty, seriesLetter, trendsDraftFromSpec, type TrendsDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { defaultInterval, parseRange, useDateRange } from '../lib/date-range';
import { trendsCsvRows } from '../lib/explore-csv';
import { ExplainPanel, isExplainable } from './explain-panel';
import { FormulasEditor, runnableFormulas } from './formulas-editor';

const MAX_SERIES = 5;

type SeriesDraft = TrendsDraft['series'][number];

function Builder({ project }: Readonly<{ project: PanelProjectDto }>) {
  const projectId = project.id;
  const { t } = useI18n();
  const ti = t.weldpanel.analytics.insights;
  const tx = t.weldpanel.explore.insights;
  const tex = t.weldpanel.explore.explain;
  const { groupTypes } = usePanelDefinitions();
  const labels = useDefinitionLabels();
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<TrendsDraft>(emptyTrendsDraft);
  const [interval, setInterval] = useState<PanelInterval | 'auto'>('auto');
  const [chartType, setChartType] = useState<TrendsChartType>('line');
  const [explainOpen, setExplainOpen] = useState(false);

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
  const formulas = runnableFormulas(draft.formulas, draft.series.length);
  const ready = isTrendsReady(draft) && formulas !== null;

  const spec = useMemo<PanelTrendsSpec>(() => {
    const runFormulas = runnableFormulas(draft.formulas, draft.series.length) ?? [];
    return {
      ...draft,
      projectId,
      dateRange: range,
      interval: effectiveInterval,
      breakdown: undefined,
      breakdowns: completeBreakdowns(draft.breakdowns),
      formulas: runFormulas.length > 0 ? runFormulas : undefined,
      formulaOnly: runFormulas.length > 0 && draft.formulaOnly ? true : undefined,
      // Only `cumulative` changes what the query returns; the other displays are kept with a saved report (below).
      display: chartType === 'cumulative' ? 'cumulative' : undefined,
    };
  }, [draft, projectId, range, effectiveInterval, chartType]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelTrends(spec, { enabled: ready });

  const updateSeries = (index: number, patch: Partial<SeriesDraft>) =>
    setDraft((d) => ({ ...d, series: d.series.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  const setFilters = (filters: PanelFilter[]) => setDraft((d) => ({ ...d, filters }));

  const maths = PANEL_TREND_MATHS.filter((m) => m !== 'unique_groups' || groupTypes.length > 0 || draft.series.some((s) => s.math === 'unique_groups'));
  const mathLabel = (m: PanelTrendMath) => (m === 'unique_groups' ? tx.measures.unique_groups : ti.measures[m]);
  const chartLabel = (type: TrendsChartType) => (type === 'area' || type === 'pie' || type === 'cumulative' ? tx.chartTypes[type] : ti.chartTypes[type]);
  const seriesLabels = draft.series.map((s) => s.label || labels.event(s.event));
  const canExplain = draft.series.some((s) => isExplainable(s.math));

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
                      <Select
                        value={math}
                        onValueChange={(next) =>
                          updateSeries(index, {
                            math: next as PanelTrendMath,
                            groupType: next === 'unique_groups' ? (series.groupType ?? groupTypes[0]?.groupType) : undefined,
                          })
                        }
                      >
                        <SelectTrigger id={`weldpanel-series-${index}-math`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {maths.map((m) => (
                            <SelectItem key={m} value={m}>
                              {mathLabel(m)}
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
                          includeComputed
                        />
                      </LabeledField>
                    )}
                    {math === 'unique_groups' && (
                      <LabeledField label={tx.groupType} htmlFor={`weldpanel-series-${index}-group-type`}>
                        <Select value={series.groupType ?? ''} onValueChange={(groupType) => updateSeries(index, { groupType })}>
                          <SelectTrigger id={`weldpanel-series-${index}-group-type`}>
                            <SelectValue placeholder={t.weldpanel.explore.filters.groupTypePlaceholder} />
                          </SelectTrigger>
                          <SelectContent>
                            {groupTypes.map((g) => (
                              <SelectItem key={g.groupType} value={g.groupType}>
                                {g.namePlural}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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

      <SectionCard title={tx.formulas.title}>
        <FormulasEditor
          formulas={draft.formulas ?? []}
          onChange={(next) => setDraft((d) => ({ ...d, formulas: next }))}
          formulaOnly={draft.formulaOnly ?? false}
          onFormulaOnlyChange={(formulaOnly) => setDraft((d) => ({ ...d, formulaOnly }))}
          seriesCount={draft.series.length}
        />
      </SectionCard>

      <SectionCard title={ti.globalFilters}>
        <div className="grid gap-5">
          <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={setFilters} />
          <BreakdownsPicker projectId={projectId} value={draft.breakdowns ?? []} onChange={(breakdowns) => setDraft((d) => ({ ...d, breakdowns }))} idPrefix="weldpanel-insights-breakdown" />
        </div>
      </SectionCard>

      <ChartCard
        title={ti.resultsTitle}
        loading={ready && isLoading}
        error={ready ? error : undefined}
        onRetry={() => void refetch()}
        empty={!ready}
        emptyText={ti.completeHint}
        csv={data ? () => ({ filename: csvFilename(saved.report?.name ?? ti.title), rows: trendsCsvRows(trendLines(data.result, t.weldpanel.analytics.common.other, labels.event)) }) : undefined}
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
            <ToggleGroup type="single" variant="outline" size="sm" value={chartType} onValueChange={(next) => next && setChartType(next as TrendsChartType)} aria-label={ti.chartType} className="flex-wrap">
              {PANEL_TRENDS_DISPLAYS.map((type) => (
                <ToggleGroupItem key={type} value={type} aria-label={chartLabel(type)} className="px-2.5 text-xs">
                  {chartLabel(type)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex items-center gap-2">
              <Switch id="weldpanel-insights-compare" checked={draft.compare ?? false} onCheckedChange={(compare) => setDraft((d) => ({ ...d, compare }))} />
              <Label htmlFor="weldpanel-insights-compare" className="text-sm font-normal">
                {t.weldpanel.analytics.range.compare}
              </Label>
            </div>
            {ready && canExplain && (
              <Button type="button" variant="outline" size="sm" onClick={() => setExplainOpen(true)}>
                <SearchCheck />
                {tex.button}
              </Button>
            )}
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

      <ExplainPanel
        open={explainOpen}
        onOpenChange={setExplainOpen}
        projectId={projectId}
        spec={spec}
        result={data?.result}
        seriesLabels={seriesLabels}
        aiEnabled={project.settings.aiEnabled}
        initialSeries={Math.max(0, draft.series.findIndex((s) => isExplainable(s.math)))}
      />
    </div>
  );
}

export default function InsightsPage() {
  const { t } = useI18n();
  const ti = t.weldpanel.analytics.insights;
  return (
    <AnalyticsPage title={ti.title} description={ti.description}>
      {(project) => (
        <PanelDefinitionsProvider key={project.id} projectId={project.id}>
          <Builder project={project} />
        </PanelDefinitionsProvider>
      )}
    </AnalyticsPage>
  );
}
