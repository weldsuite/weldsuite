import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { PANEL_WINDOW_UNITS, type PanelFilter, type PanelFunnelSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useWeldPanelFunnel } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { BreakdownPicker, isBreakdownComplete } from '../components/breakdown-picker';
import { ChartCard } from '../components/chart-card';
import { ClampedNumberInput } from '../components/clamped-number-input';
import { DateRangePicker } from '../components/date-range-picker';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { FunnelResultView } from '../components/results/funnel-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyFunnelDraft, funnelDraftFromSpec, isFunnelReady, type FunnelDraft } from '../lib/builders';
import { parseRange, useDateRange } from '../lib/date-range';

const MAX_STEPS = 10;

type StepDraft = FunnelDraft['steps'][number];

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  const canWatch = useCan('panel_recordings:read');
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<FunnelDraft>(emptyFunnelDraft);

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
  const spec = useMemo<PanelFunnelSpec>(
    () => ({ ...draft, projectId, dateRange: range, breakdown: isBreakdownComplete(draft.breakdown) ? draft.breakdown : undefined }),
    [draft, projectId, range],
  );
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelFunnel(spec, { enabled: ready });

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

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  const conversionWindow = draft.window ?? { value: 7, unit: 'day' as const };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.steps[1]?.event ?? draft.steps[0]?.event)} onSaved={saved.open} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <SectionCard title={tf.steps}>
        <ol className="grid gap-3">
          {draft.steps.map((step, index) => {
            const n = index + 1;
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
                    <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === draft.steps.length - 1} aria-label={tf.moveDown.replace('{n}', String(n))} onClick={() => moveStep(index, 1)}>
                      <ArrowDown />
                    </Button>
                    {draft.steps.length > 2 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={tf.removeStep.replace('{n}', String(n))}
                        onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }))}
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="grid gap-1 pl-8">
                  <p className="text-xs text-muted-foreground">{tf.stepFilters}</p>
                  <FilterBuilder compact projectId={projectId} filters={step.filters ?? []} onChange={(filters: PanelFilter[]) => updateStep(index, { filters })} />
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
      </SectionCard>

      <SectionCard title={tf.globalFilters}>
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
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
            <LabeledField label={tf.order} hint={tf.orderHints[draft.order ?? 'loose']}>
              <ToggleGroup type="single" variant="outline" value={draft.order ?? 'loose'} onValueChange={(order) => order && setDraft((d) => ({ ...d, order: order as 'loose' | 'strict' }))} aria-label={tf.order}>
                <ToggleGroupItem value="loose">{tf.orders.loose}</ToggleGroupItem>
                <ToggleGroupItem value="strict">{tf.orders.strict}</ToggleGroupItem>
              </ToggleGroup>
            </LabeledField>
          </div>
          <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
          <BreakdownPicker projectId={projectId} value={draft.breakdown} onChange={(breakdown) => setDraft((d) => ({ ...d, breakdown }))} idPrefix="weldpanel-funnel-breakdown" />
        </div>
      </SectionCard>

      <ChartCard title={t.weldpanel.analytics.insights.resultsTitle} loading={ready && isLoading} error={ready ? error : undefined} onRetry={() => void refetch()} empty={!ready} emptyText={tf.completeHint}>
        {data && (
          <div className="grid gap-4">
            <FunnelResultView result={data.result} spec={spec} projectId={projectId} canWatch={canWatch} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </div>
  );
}

export default function FunnelsPage() {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.funnels;
  return (
    <AnalyticsPage title={tf.title} description={tf.description}>
      {(project) => <Builder key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}
