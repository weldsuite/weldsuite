import { useMemo, useState } from 'react';
import type { PanelFlowsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelFlows } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsListPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { ReportSaveButtons, ReportTools } from '../components/report-actions';
import { ReportLayout } from '../components/report-layout';
import { FlowsResultView, flowsCsvRows } from '../components/results/flows-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyFlowsDraft, flowsDraftFromSpec, isFlowsReady, type FlowsDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
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
    <ReportLayout
      title={tf.title}
      actions={<ReportTools projectId={projectId} report={saved.wrongKindPath ? null : saved.report} />}
      controls={<ReportSaveButtons projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.anchor.event)} onSaved={saved.open} />}
      dateRange={{ value: range, onChange: setRange }}
      sidebar={{
        title: t.common.labels.settings,
        content: (
          <div className="grid gap-5">
            <LabeledField label={tf.anchor} htmlFor="weldpanel-flows-anchor" hint={tf.anchorHint}>
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
            <div className="grid grid-cols-2 gap-4">
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
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{tf.globalFilters}</p>
              <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
            </div>
          </div>
        ),
      }}
    >
      <SavedReportNotices saved={saved} />

      <ChartCard
        bare
        title={direction === 'before' ? tf.columnsTitleBefore : tf.columnsTitle}
        loading={ready && isLoading}
        error={ready ? error : undefined}
        onRetry={() => void refetch()}
        empty={!ready}
        emptyText={tf.completeHint}
        csv={data ? () => ({ filename: csvFilename(saved.report?.name ?? tf.title), rows: flowsCsvRows(data.result, tf.left) }) : undefined}
      >
        {data && (
          <div className="grid gap-4">
            <FlowsResultView result={data.result} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </ReportLayout>
  );
}

export default function FlowsPage() {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.flows;
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
