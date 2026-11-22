/**
 * Impact: did launching a feature move a metric? The windows sit around the
 * launch date, so the page has no date range picker (the spec's range is left
 * at its default).
 */

import { useMemo, useState } from 'react';
import { PANEL_IMPACT_MATHS, type PanelImpactSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelImpact } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsListPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker, PropertyPicker } from '../components/pickers';
import { ReportSaveButtons, ReportTools } from '../components/report-actions';
import { ReportLayout } from '../components/report-layout';
import { ImpactResultView } from '../components/results/impact-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyImpactDraft, impactDraftFromSpec, isImpactReady, type ImpactDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { todayYmd } from '../lib/date-range';
import { impactCsvRows } from '../lib/explore-csv';

const WINDOWS = [7, 14, 28, 56, 90] as const;
type ImpactMath = (typeof PANEL_IMPACT_MATHS)[number];

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.impact;
  const [draft, setDraft] = useState<ImpactDraft>(emptyImpactDraft);

  const saved = useSavedReport({
    kind: 'impact',
    apply: (spec) => {
      const next = impactDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      return true;
    },
  });

  const ready = isImpactReady(draft);
  const spec = useMemo<PanelImpactSpec>(() => ({ ...draft, projectId }), [draft, projectId]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelImpact(spec, { enabled: ready });
  const math: ImpactMath = draft.metric.math ?? 'total';
  const setMetric = (patch: Partial<ImpactDraft['metric']>) => setDraft((d) => ({ ...d, metric: { ...d.metric, ...patch } }));
  const windowChoices = WINDOWS.includes((draft.windowDays ?? 28) as (typeof WINDOWS)[number]) ? WINDOWS : [...WINDOWS, draft.windowDays ?? 28].sort((a, b) => a - b);

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  return (
    <ReportLayout
      title={tx.title}
      actions={<ReportTools projectId={projectId} report={saved.wrongKindPath ? null : saved.report} />}
      controls={<ReportSaveButtons projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.launchEvent)} onSaved={saved.open} />}
      sidebar={{
        title: t.common.labels.settings,
        content: (
          <div className="grid gap-5">
            <LabeledField label={tx.launchEvent} htmlFor="weldpanel-impact-launch" hint={tx.launchEventHint}>
              <EventPicker id="weldpanel-impact-launch" projectId={projectId} value={draft.launchEvent} onChange={(launchEvent) => setDraft((d) => ({ ...d, launchEvent }))} ariaLabel={tx.launchEvent} />
            </LabeledField>
            <div className="grid grid-cols-2 gap-4">
              <LabeledField label={tx.launchDate} htmlFor="weldpanel-impact-date">
                <Input
                  id="weldpanel-impact-date"
                  type="date"
                  value={draft.launchDate}
                  max={todayYmd()}
                  onChange={(event) => event.target.value && setDraft((d) => ({ ...d, launchDate: event.target.value }))}
                />
              </LabeledField>
              <LabeledField label={tx.windowDays} htmlFor="weldpanel-impact-window">
                <Select value={String(draft.windowDays ?? 28)} onValueChange={(next) => setDraft((d) => ({ ...d, windowDays: Number(next) }))}>
                  <SelectTrigger id="weldpanel-impact-window">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {windowChoices.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </LabeledField>
            </div>

            <fieldset className="min-w-0">
              <legend className="sr-only">{tx.metric}</legend>
              <div className="grid gap-4 rounded-lg border p-3">
                <p aria-hidden className="text-sm font-medium">
                  {tx.metric}
                </p>
                <LabeledField label={tx.metricEvent} htmlFor="weldpanel-impact-metric-event">
                  <EventPicker id="weldpanel-impact-metric-event" projectId={projectId} value={draft.metric.event} onChange={(event) => setMetric({ event })} ariaLabel={tx.metricEvent} />
                </LabeledField>
                <LabeledField label={tx.math} htmlFor="weldpanel-impact-math">
                  <Select value={math} onValueChange={(next) => setMetric({ math: next as ImpactMath, property: next === 'sum' || next === 'avg' ? draft.metric.property : undefined })}>
                    <SelectTrigger id="weldpanel-impact-math">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PANEL_IMPACT_MATHS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {tx.maths[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LabeledField>
                {(math === 'sum' || math === 'avg') && (
                  <LabeledField label={tx.property} htmlFor="weldpanel-impact-property">
                    <PropertyPicker id="weldpanel-impact-property" projectId={projectId} value={draft.metric.property ?? ''} onChange={(property) => setMetric({ property })} ariaLabel={tx.property} includeComputed />
                  </LabeledField>
                )}
                <div className="grid gap-1.5">
                  <p className="text-sm font-medium">{t.weldpanel.analytics.insights.seriesFilters}</p>
                  <FilterBuilder compact projectId={projectId} filters={draft.metric.filters ?? []} onChange={(filters) => setMetric({ filters })} />
                </div>
              </div>
            </fieldset>

            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t.weldpanel.analytics.retention.globalFilters}</p>
              <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
            </div>
          </div>
        ),
      }}
    >
      <SavedReportNotices saved={saved} />

      <ChartCard
        bare
        title={t.weldpanel.analytics.insights.resultsTitle}
        loading={ready && isLoading}
        error={ready ? error : undefined}
        onRetry={() => void refetch()}
        empty={!ready}
        emptyText={tx.completeHint}
        csv={data ? () => ({ filename: csvFilename(saved.report?.name ?? tx.title), rows: impactCsvRows(data.result) }) : undefined}
      >
        {data && (
          <div className="grid gap-4">
            <ImpactResultView result={data.result} math={math} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </ReportLayout>
  );
}

export default function ImpactPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.impact;
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
