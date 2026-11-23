import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import {
  PANEL_FUNNEL_DISPLAYS,
  PANEL_FUNNEL_ORDERS,
  PANEL_INTERVALS,
  PANEL_WINDOW_UNITS,
  type PanelFilter,
  type PanelFunnelCorrelationSpec,
  type PanelFunnelDisplay,
  type PanelFunnelResult,
  type PanelFunnelSpec,
  type PanelInterval,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditorPanelSection } from '@weldsuite/ui/components/editor-side-panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useWeldPanelFunnelCorrelation } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useWeldPanelFunnel } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsListPage } from '../components/analytics-page';
import { BreakdownPicker, BreakdownsPicker, completeBreakdowns, isBreakdownComplete } from '../components/breakdown-picker';
import { ChartCard } from '../components/chart-card';
import { ClampedNumberInput } from '../components/clamped-number-input';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { AggregateByPicker, EventPicker, useHasGroupTypes } from '../components/pickers';
import { ReportSaveButtons, ReportTools } from '../components/report-actions';
import { ReportLayout } from '../components/report-layout';
import { CorrelationResultView } from '../components/results/correlation-result';
import { FunnelResultView } from '../components/results/funnel-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyFunnelDraft, funnelDraftFromSpec, isFunnelReady, type FunnelDraft } from '../lib/builders';
import { csvFilename, type CsvExport, type CsvRow } from '../lib/csv';
import { defaultInterval, parseRange, useDateRange } from '../lib/date-range';
import { correlationCsvRows, funnelCsvRows, funnelTrendCsvRows, timeToConvertCsvRows } from '../lib/explore-csv';

const MAX_STEPS = 10;
const MAX_EXCLUSIONS = 5;

type StepDraft = FunnelDraft['steps'][number];
type ExclusionDraft = NonNullable<FunnelDraft['exclusions']>[number];
type FunnelOrder = (typeof PANEL_FUNNEL_ORDERS)[number];

/**
 * What the query runs: optional steps only in the middle, exclusions inside the
 * steps (and none for `any` order), complete breakdowns only.
 */
function funnelSpecFromDraft(draft: FunnelDraft, projectId: string, range: PanelFunnelSpec['dateRange'], fallbackInterval: PanelInterval): PanelFunnelSpec {
  const last = draft.steps.length - 1;
  const order = draft.order ?? 'loose';
  const exclusions = order === 'any' ? [] : (draft.exclusions ?? []).filter((x) => x.event !== '' && x.fromStep < x.toStep && x.toStep <= last);
  const display = draft.display ?? 'steps';
  return {
    ...draft,
    projectId,
    dateRange: range,
    steps: draft.steps.map((s, i) => ({ ...s, optional: order !== 'any' && i > 0 && i < last && s.optional ? true : undefined })),
    exclusions: exclusions.length > 0 ? exclusions : undefined,
    breakdown: undefined,
    breakdowns: completeBreakdowns(draft.breakdowns),
    holdConstant: draft.holdConstant && isBreakdownComplete(draft.holdConstant) ? draft.holdConstant : undefined,
    display: display === 'steps' ? undefined : display,
    interval: display === 'trends' ? (draft.interval ?? fallbackInterval) : undefined,
  };
}

/** The CSV of the result as it is displayed: the steps, the trend or the time to convert. */
function funnelResultCsvRows(result: PanelFunnelResult, display: PanelFunnelDisplay): CsvRow[] {
  if (display === 'trends') return funnelTrendCsvRows(result);
  if (display === 'time_to_convert') return timeToConvertCsvRows(result);
  return funnelCsvRows(result);
}

/** The results card's "Export CSV", once there is a result. */
function funnelCsvExport(result: PanelFunnelResult | undefined, display: PanelFunnelDisplay, name: string): (() => CsvExport) | undefined {
  if (!result) return undefined;
  return () => ({ filename: csvFilename(name), rows: funnelResultCsvRows(result, display) });
}

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  const tx = t.weldpanel.explore.funnels;
  const canWatch = useCan('panel_recordings:read');
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<FunnelDraft>(emptyFunnelDraft);
  const [tab, setTab] = useState<'funnel' | 'correlation'>('funnel');
  const hasGroupTypes = useHasGroupTypes(draft.aggregateBy);

  const saved = useSavedReport({
    kind: 'funnel',
    apply: (spec, savedRange) => {
      const next = funnelDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const ready = isFunnelReady(draft);
  const fallbackInterval = defaultInterval(range);
  const spec = useMemo<PanelFunnelSpec>(() => funnelSpecFromDraft(draft, projectId, range, fallbackInterval), [draft, projectId, range, fallbackInterval]);
  const { data, error, isLoading, isFetching, isPlaceholderData, refetch } = useWeldPanelFunnel(spec, { enabled: ready });

  const correlationSpec = useMemo<PanelFunnelCorrelationSpec>(
    () => ({ ...spec, kind: 'funnel_correlation', display: undefined, interval: undefined, breakdowns: undefined, limit: 10 }),
    [spec],
  );
  const correlation = useWeldPanelFunnelCorrelation(correlationSpec, { enabled: ready && tab === 'correlation' });

  const updateStep = (index: number, patch: Partial<StepDraft>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  const moveStep = (index: number, by: -1 | 1) =>
    setDraft((d) => {
      const steps = [...d.steps];
      const target = index + by;
      if (target < 0 || target >= steps.length) return d;
      [steps[index], steps[target]] = [steps[target]!, steps[index]!];
      return { ...d, steps };
    });
  const removeStep = (index: number) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.filter((_, i) => i !== index),
      // Exclusions keep pointing at the same steps; one whose steps are gone goes with them.
      exclusions: (d.exclusions ?? [])
        .map((x) => ({ ...x, fromStep: x.fromStep > index ? x.fromStep - 1 : x.fromStep, toStep: x.toStep > index ? x.toStep - 1 : x.toStep }))
        .filter((x) => x.fromStep < x.toStep && x.toStep < d.steps.length - 1),
    }));
  const updateExclusion = (index: number, patch: Partial<ExclusionDraft>) =>
    setDraft((d) => ({ ...d, exclusions: (d.exclusions ?? []).map((x, i) => (i === index ? { ...x, ...patch } : x)) }));

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  const conversionWindow = draft.window ?? { value: 7, unit: 'day' as const };
  const order: FunnelOrder = draft.order ?? 'loose';
  const display: PanelFunnelDisplay = draft.display ?? 'steps';
  const lastStep = draft.steps.length - 1;
  const exclusions = draft.exclusions ?? [];
  const orderLabel = (o: FunnelOrder) => (o === 'any' ? tx.orders.any : tf.orders[o]);
  const orderHint = order === 'any' ? tx.orderHints.any : tf.orderHints[order];
  const csvName = saved.report?.name ?? tf.title;

  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as 'funnel' | 'correlation')} className="h-full gap-0">
    <ReportLayout
      title={tf.title}
      actions={
        <>
          <TabsList className="h-8 shrink-0">
            <TabsTrigger value="funnel">{tx.tabs.funnel}</TabsTrigger>
            <TabsTrigger value="correlation">{tx.tabs.correlation}</TabsTrigger>
          </TabsList>
          {tab === 'funnel' && (
            <div className="flex shrink-0 items-center gap-2">
              <ToggleGroup type="single" variant="outline" size="sm" className="shrink-0" value={display} onValueChange={(next) => next && setDraft((d) => ({ ...d, display: next as PanelFunnelDisplay }))} aria-label={tx.display.label}>
                {PANEL_FUNNEL_DISPLAYS.map((d) => (
                  <ToggleGroupItem key={d} value={d} className="flex-none px-2.5 text-xs">
                    {tx.display[d]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {display === 'trends' && (
                <Select value={draft.interval ?? fallbackInterval} onValueChange={(interval) => setDraft((d) => ({ ...d, interval: interval as PanelInterval }))}>
                  <SelectTrigger size="sm" className="h-8 w-auto min-w-24" aria-label={tx.trendInterval}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PANEL_INTERVALS.map((i) => (
                      <SelectItem key={i} value={i}>
                        {t.weldpanel.analytics.insights.intervals[i]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          <ReportTools projectId={projectId} report={saved.wrongKindPath ? null : saved.report} />
        </>
      }
      controls={<ReportSaveButtons projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.steps[1]?.event ?? draft.steps[0]?.event)} onSaved={saved.open} />}
      dateRange={{ value: range, onChange: setRange }}
      sidebar={{
        title: t.common.labels.settings,
        content: (
          <div className="grid gap-5">
            <EditorPanelSection title={tf.steps} className="border-t-0 pt-0">
              <ol className="grid gap-3">
                {draft.steps.map((step, index) => {
                  const n = index + 1;
                  const canBeOptional = order !== 'any' && index > 0 && index < lastStep;
                  return (
                    <li key={index} className="grid gap-2 rounded-lg border p-3" aria-label={tf.stepN.replace('{n}', String(n))}>
                      <div className="flex items-end gap-2">
                        <span className="mb-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold" aria-hidden>
                          {n}
                        </span>
                        <LabeledField label={tf.stepN.replace('{n}', String(n))} htmlFor={`weldpanel-step-${index}`} className="min-w-0 flex-1">
                          <EventPicker id={`weldpanel-step-${index}`} projectId={projectId} value={step.event} onChange={(event) => updateStep(index, { event })} ariaLabel={tf.stepN.replace('{n}', String(n))} />
                        </LabeledField>
                        <div className="flex shrink-0 gap-0.5">
                          <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === 0} aria-label={tf.moveUp.replace('{n}', String(n))} onClick={() => moveStep(index, -1)}>
                            <ArrowUp />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === lastStep} aria-label={tf.moveDown.replace('{n}', String(n))} onClick={() => moveStep(index, 1)}>
                            <ArrowDown />
                          </Button>
                          {draft.steps.length > 2 && (
                            <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={tf.removeStep.replace('{n}', String(n))} onClick={() => removeStep(index)}>
                              <X />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-start justify-between gap-3 pl-8">
                        <div className="grid gap-1">
                          <p className="text-xs text-muted-foreground">{tf.stepFilters}</p>
                          <FilterBuilder compact projectId={projectId} filters={step.filters ?? []} onChange={(filters: PanelFilter[]) => updateStep(index, { filters })} />
                        </div>
                        {canBeOptional && (
                          <div className="flex items-center gap-2" title={tx.optionalHint}>
                            <Switch id={`weldpanel-step-${index}-optional`} checked={step.optional ?? false} onCheckedChange={(optional) => updateStep(index, { optional })} />
                            <Label htmlFor={`weldpanel-step-${index}-optional`} className="text-sm font-normal">
                              {tx.optional}
                            </Label>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {draft.steps.length < MAX_STEPS && (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, { event: '', filters: [] }] }))}>
                  <Plus />
                  {tf.addStep}
                </Button>
              )}
            </EditorPanelSection>
            <EditorPanelSection title={tx.exclusions.title}>
              <div className="grid gap-3">
                <p className="text-xs text-muted-foreground">{tx.exclusions.hint}</p>
                {order === 'any' && exclusions.length > 0 && <InfoBanner variant="warning">{tx.exclusions.needOrder}</InfoBanner>}
                {exclusions.map((exclusion, index) => {
                  const n = index + 1;
                  return (
                    <div key={index} className="grid gap-3 rounded-lg border p-3" role="group" aria-label={`${tx.exclusions.title} ${n}`}>
                      <div className="flex items-end gap-2">
                        <div className="grid min-w-0 flex-1 gap-3">
                          <LabeledField label={tx.exclusions.event} htmlFor={`weldpanel-exclusion-${index}-event`}>
                            <EventPicker id={`weldpanel-exclusion-${index}-event`} projectId={projectId} value={exclusion.event} onChange={(event) => updateExclusion(index, { event })} ariaLabel={`${tx.exclusions.event} ${n}`} />
                          </LabeledField>
                          <div className="grid grid-cols-2 gap-3">
                          <LabeledField label={tx.exclusions.from} htmlFor={`weldpanel-exclusion-${index}-from`}>
                            <Select value={String(exclusion.fromStep)} onValueChange={(next) => updateExclusion(index, { fromStep: Number(next), toStep: Math.max(Number(next) + 1, exclusion.toStep) })}>
                              <SelectTrigger id={`weldpanel-exclusion-${index}-from`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {draft.steps.slice(0, -1).map((_, i) => (
                                  <SelectItem key={i} value={String(i)}>
                                    {format(tx.exclusions.stepOption, { n: i + 1 })}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </LabeledField>
                          <LabeledField label={tx.exclusions.to} htmlFor={`weldpanel-exclusion-${index}-to`}>
                            <Select value={String(exclusion.toStep)} onValueChange={(next) => updateExclusion(index, { toStep: Number(next) })}>
                              <SelectTrigger id={`weldpanel-exclusion-${index}-to`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {draft.steps.map((_, i) =>
                                  i > exclusion.fromStep ? (
                                    <SelectItem key={i} value={String(i)}>
                                      {format(tx.exclusions.stepOption, { n: i + 1 })}
                                    </SelectItem>
                                  ) : null,
                                )}
                              </SelectContent>
                            </Select>
                          </LabeledField>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label={format(tx.exclusions.remove, { n })}
                          onClick={() => setDraft((d) => ({ ...d, exclusions: (d.exclusions ?? []).filter((_, i) => i !== index) }))}
                        >
                          <X />
                        </Button>
                      </div>
                      <div className="grid gap-1">
                        <p className="text-xs text-muted-foreground">{tf.stepFilters}</p>
                        <FilterBuilder compact projectId={projectId} filters={exclusion.filters ?? []} onChange={(filters) => updateExclusion(index, { filters })} />
                      </div>
                    </div>
                  );
                })}
                {exclusions.length < MAX_EXCLUSIONS && order !== 'any' && (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDraft((d) => ({ ...d, exclusions: [...(d.exclusions ?? []), { event: '', filters: [], fromStep: 0, toStep: d.steps.length - 1 }] }))}
                    >
                      <Plus />
                      {tx.exclusions.add}
                    </Button>
                  </div>
                )}
              </div>
            </EditorPanelSection>
            <EditorPanelSection title={tf.globalFilters}>
              <div className="grid gap-5">
                <div className="grid gap-4">
                  <LabeledField label={tf.window} htmlFor="weldpanel-funnel-window" hint={tf.windowHint}>
                    <div className="flex gap-2">
                      <ClampedNumberInput
                        id="weldpanel-funnel-window"
                        aria-label={tf.window}
                        className="w-24"
                        min={1}
                        max={366}
                        value={conversionWindow.value}
                        onCommit={(value) => setDraft((d) => ({ ...d, window: { ...conversionWindow, value } }))}
                      />
                      <Select value={conversionWindow.unit} onValueChange={(unit) => setDraft((d) => ({ ...d, window: { ...conversionWindow, unit: unit as (typeof PANEL_WINDOW_UNITS)[number] } }))}>
                        <SelectTrigger aria-label={tf.window} className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PANEL_WINDOW_UNITS.map((unit) => (
                            <SelectItem key={unit} value={unit}>
                              {tf.windowUnits[unit]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </LabeledField>
                  <LabeledField label={tf.order} hint={orderHint}>
                    <ToggleGroup type="single" variant="outline" value={order} onValueChange={(next) => next && setDraft((d) => ({ ...d, order: next as FunnelOrder }))} aria-label={tf.order}>
                      {PANEL_FUNNEL_ORDERS.map((o) => (
                        <ToggleGroupItem key={o} value={o}>
                          {orderLabel(o)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </LabeledField>
                  {hasGroupTypes && (
                    <LabeledField label={t.weldpanel.explore.countBy.label} htmlFor="weldpanel-funnel-count-by" hint={t.weldpanel.explore.countBy.hint}>
                      <AggregateByPicker id="weldpanel-funnel-count-by" value={draft.aggregateBy} onChange={(aggregateBy) => setDraft((d) => ({ ...d, aggregateBy }))} />
                    </LabeledField>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <p className="text-sm font-medium">{t.weldpanel.analytics.retention.globalFilters}</p>
                  <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
                </div>
                <BreakdownsPicker projectId={projectId} value={draft.breakdowns ?? []} onChange={(breakdowns) => setDraft((d) => ({ ...d, breakdowns }))} idPrefix="weldpanel-funnel-breakdown" stacked />
                <div className="grid gap-1">
                  <BreakdownPicker
                    projectId={projectId}
                    value={draft.holdConstant}
                    onChange={(holdConstant) => setDraft((d) => ({ ...d, holdConstant }))}
                    idPrefix="weldpanel-funnel-hold"
                    label={tx.holdConstant.label}
                    allowBuckets={false}
                    stacked
                  />
                  <p className="text-xs text-muted-foreground">{tx.holdConstant.hint}</p>
                </div>
              </div>
            </EditorPanelSection>
          </div>
        ),
      }}
    >
      <SavedReportNotices saved={saved} />

        <TabsContent value="funnel">
          <ChartCard
            bare
            title={t.weldpanel.analytics.insights.resultsTitle}
            loading={ready && isLoading}
            error={ready ? error : undefined}
            onRetry={() => void refetch()}
            empty={!ready}
            emptyText={tf.completeHint}
            csv={funnelCsvExport(data?.result, display, csvName)}
          >
            {data && (
              <div className="grid gap-4">
                <FunnelResultView result={data.result} spec={spec} projectId={projectId} canWatch={canWatch && !isPlaceholderData} />
                <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
              </div>
            )}
          </ChartCard>
        </TabsContent>

        <TabsContent value="correlation">
          <ChartCard
            bare
            title={tx.correlation.title}
            loading={ready && correlation.isLoading}
            error={ready ? correlation.error : undefined}
            onRetry={() => void correlation.refetch()}
            empty={!ready}
            emptyText={tx.correlation.needsSteps}
            csv={correlation.data ? () => ({ filename: csvFilename(`${csvName} ${tx.tabs.correlation}`), rows: correlationCsvRows(correlation.data!.result) }) : undefined}
          >
            <p className="mb-4 text-sm text-muted-foreground">{tx.correlation.description}</p>
            {correlation.data && (
              <div className="grid gap-4">
                <CorrelationResultView result={correlation.data.result} spec={spec} projectId={projectId} canWatch={canWatch && !correlation.isPlaceholderData} />
                <FreshnessBadge dataAsOf={correlation.data.dataAsOf} cached={correlation.data.cached} fetching={correlation.isFetching} onRefresh={() => void correlation.refetch()} />
              </div>
            )}
          </ChartCard>
        </TabsContent>
    </ReportLayout>
    </Tabs>
  );
}

export default function FunnelsPage() {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  return (
    <AnalyticsListPage title={tf.title}>
      {(project) => (
        <PanelDefinitionsProvider key={project.id} projectId={project.id}>
          <Builder projectId={project.id} />
        </PanelDefinitionsProvider>
      )}
    </AnalyticsListPage>
  );
}
