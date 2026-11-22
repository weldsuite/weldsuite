/** Lifecycle: per period, who did an event for the first time, again, again after a break, or stopped. */

import { useMemo, useState } from 'react';
import type { PanelLifecycleSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelLifecycle } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsListPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { AggregateByPicker, EventPicker, useHasGroupTypes } from '../components/pickers';
import { ReportSaveButtons, ReportTools } from '../components/report-actions';
import { ReportLayout } from '../components/report-layout';
import { LifecycleResultView } from '../components/results/lifecycle-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyLifecycleDraft, isLifecycleReady, lifecycleDraftFromSpec, type LifecycleDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { parseRange, useDateRange } from '../lib/date-range';
import { lifecycleCsvRows } from '../lib/explore-csv';

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.lifecycle;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<LifecycleDraft>(emptyLifecycleDraft);
  const hasGroupTypes = useHasGroupTypes(draft.aggregateBy);

  const saved = useSavedReport({
    kind: 'lifecycle',
    apply: (spec, savedRange) => {
      const next = lifecycleDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const ready = isLifecycleReady(draft);
  const spec = useMemo<PanelLifecycleSpec>(() => ({ ...draft, projectId, dateRange: range }), [draft, projectId, range]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelLifecycle(spec, { enabled: ready });

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  return (
    <ReportLayout
      title={tx.title}
      actions={<ReportTools projectId={projectId} report={saved.wrongKindPath ? null : saved.report} />}
      controls={<ReportSaveButtons projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.event)} onSaved={saved.open} />}
      dateRange={{ value: range, onChange: setRange }}
      sidebar={{
        title: t.common.labels.settings,
        content: (
          <div className="grid gap-5">
            <LabeledField label={tx.event} htmlFor="weldpanel-lifecycle-event">
              <EventPicker id="weldpanel-lifecycle-event" projectId={projectId} value={draft.event} onChange={(event) => setDraft((d) => ({ ...d, event }))} ariaLabel={tx.event} />
            </LabeledField>
            <div className="grid grid-cols-2 gap-4">
              <LabeledField label={tx.interval} htmlFor="weldpanel-lifecycle-interval">
                <Select value={draft.interval ?? 'day'} onValueChange={(next) => setDraft((d) => ({ ...d, interval: next as LifecycleDraft['interval'] }))}>
                  <SelectTrigger id="weldpanel-lifecycle-interval">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['day', 'week', 'month'] as const).map((i) => (
                      <SelectItem key={i} value={i}>
                        {tx.intervals[i]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </LabeledField>
              {hasGroupTypes && (
                <LabeledField label={t.weldpanel.explore.countBy.label} htmlFor="weldpanel-lifecycle-count-by">
                  <AggregateByPicker id="weldpanel-lifecycle-count-by" value={draft.aggregateBy} onChange={(aggregateBy) => setDraft((d) => ({ ...d, aggregateBy }))} />
                </LabeledField>
              )}
            </div>
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
        csv={data ? () => ({ filename: csvFilename(saved.report?.name ?? tx.title), rows: lifecycleCsvRows(data.result) }) : undefined}
      >
        {data && (
          <div className="grid gap-4">
            <LifecycleResultView result={data.result} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </ReportLayout>
  );
}

export default function LifecyclePage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.lifecycle;
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
