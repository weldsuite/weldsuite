import { useMemo, useState } from 'react';
import type { PanelFlowsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelFlows } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { FlowsResultView } from '../components/results/flows-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyFlowsDraft, flowsDraftFromSpec, isFlowsReady, type FlowsDraft } from '../lib/builders';
import { parseRange, useDateRange } from '../lib/date-range';

const DEPTHS = [1, 2, 3, 4, 5] as const;
const LIMITS = [10, 20, 30, 50] as const;

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.flows;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<FlowsDraft>(emptyFlowsDraft);

  const saved = useSavedReport({
    kind: 'flows',
    apply: (spec, savedRange) => {
      const next = flowsDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const ready = isFlowsReady(draft);
  const spec = useMemo<PanelFlowsSpec>(() => ({ ...draft, projectId, dateRange: range }), [draft, projectId, range]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelFlows(spec, { enabled: ready });

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  const direction = draft.direction ?? 'after';

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.anchor.event)} onSaved={saved.open} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <SectionCard title={tf.title}>
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <LabeledField label={tf.anchor} htmlFor="weldpanel-flows-anchor" hint={tf.anchorHint} className="lg:col-span-2">
              <EventPicker
                id="weldpanel-flows-anchor"
                projectId={projectId}
                value={draft.anchor.event}
                onChange={(event) => setDraft((d) => ({ ...d, anchor: { ...d.anchor, event } }))}
                ariaLabel={tf.anchor}
              />
            </LabeledField>
            <LabeledField label={tf.direction} htmlFor="weldpanel-flows-direction">
              <Select value={direction} onValueChange={(next) => setDraft((d) => ({ ...d, direction: next as 'after' | 'before' }))}>
                <SelectTrigger id="weldpanel-flows-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="after">{tf.directions.after}</SelectItem>
                  <SelectItem value="before">{tf.directions.before}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={tf.depth} htmlFor="weldpanel-flows-depth">
              <Select value={String(draft.depth ?? 3)} onValueChange={(next) => setDraft((d) => ({ ...d, depth: Number(next) }))}>
                <SelectTrigger id="weldpanel-flows-depth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPTHS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {tf.depthValue.replace('{count}', String(n))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={tf.scope} htmlFor="weldpanel-flows-scope">
              <Select value={draft.scope ?? 'all'} onValueChange={(next) => setDraft((d) => ({ ...d, scope: next as FlowsDraft['scope'] }))}>
                <SelectTrigger id="weldpanel-flows-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['all', 'pageviews', 'custom'] as const).map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {tf.scopes[scope]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <LabeledField label={tf.limit} htmlFor="weldpanel-flows-limit">
              <Select value={String(draft.limit ?? 20)} onValueChange={(next) => setDraft((d) => ({ ...d, limit: Number(next) }))}>
                <SelectTrigger id="weldpanel-flows-limit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMITS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
          </div>
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">{tf.globalFilters}</p>
            <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
          </div>
        </div>
      </SectionCard>

      <ChartCard
        title={direction === 'before' ? tf.columnsTitleBefore : tf.columnsTitle}
        loading={ready && isLoading}
        error={ready ? error : undefined}
        onRetry={() => void refetch()}
        empty={!ready}
        emptyText={tf.completeHint}
      >
        {data && (
          <div className="grid gap-4">
            <FlowsResultView result={data.result} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </div>
  );
}

export default function FlowsPage() {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.flows;
  return (
    <AnalyticsPage title={tf.title} description={tf.description}>
      {(project) => <Builder key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}
