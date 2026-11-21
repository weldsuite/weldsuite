/** Stickiness (Mixpanel's Frequency): how often the people who did an event do it. */

import { useMemo, useState } from 'react';
import type { PanelStickinessSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelStickiness } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { AggregateByPicker, EventPicker, useHasGroupTypes } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { StickinessResultView } from '../components/results/stickiness-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyStickinessDraft, isStickinessReady, stickinessDraftFromSpec, type StickinessDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { parseRange, useDateRange } from '../lib/date-range';
import { stickinessCsvRows } from '../lib/explore-csv';

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.stickiness;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<StickinessDraft>(emptyStickinessDraft);
  const hasGroupTypes = useHasGroupTypes(draft.aggregateBy);

  const saved = useSavedReport({
    kind: 'stickiness',
    apply: (spec, savedRange) => {
      const next = stickinessDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const ready = isStickinessReady(draft);
  const spec = useMemo<PanelStickinessSpec>(() => ({ ...draft, projectId, dateRange: range }), [draft, projectId, range]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelStickiness(spec, { enabled: ready });
  const measure = draft.measure ?? 'intervals';

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.event)} onSaved={saved.open} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <SectionCard title={tx.title}>
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <LabeledField label={tx.event} htmlFor="weldpanel-stickiness-event">
              <EventPicker id="weldpanel-stickiness-event" projectId={projectId} value={draft.event} onChange={(event) => setDraft((d) => ({ ...d, event }))} ariaLabel={tx.event} />
            </LabeledField>
            <LabeledField label={tx.measure} htmlFor="weldpanel-stickiness-measure" hint={tx.measureHints[measure]}>
              <Select value={measure} onValueChange={(next) => setDraft((d) => ({ ...d, measure: next as StickinessDraft['measure'] }))}>
                <SelectTrigger id="weldpanel-stickiness-measure">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['intervals', 'count'] as const).map((m) => (
                    <SelectItem key={m} value={m}>
                      {tx.measures[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={tx.interval} htmlFor="weldpanel-stickiness-interval">
              <Select value={draft.interval ?? 'day'} onValueChange={(next) => setDraft((d) => ({ ...d, interval: next as StickinessDraft['interval'] }))}>
                <SelectTrigger id="weldpanel-stickiness-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['day', 'week'] as const).map((i) => (
                    <SelectItem key={i} value={i}>
                      {tx.intervals[i]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            {hasGroupTypes && (
              <LabeledField label={t.weldpanel.explore.countBy.label} htmlFor="weldpanel-stickiness-count-by">
                <AggregateByPicker id="weldpanel-stickiness-count-by" value={draft.aggregateBy} onChange={(aggregateBy) => setDraft((d) => ({ ...d, aggregateBy }))} />
              </LabeledField>
            )}
          </div>
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">{t.weldpanel.analytics.retention.globalFilters}</p>
            <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
          </div>
        </div>
      </SectionCard>

      <ChartCard
        title={t.weldpanel.analytics.insights.resultsTitle}
        loading={ready && isLoading}
        error={ready ? error : undefined}
        onRetry={() => void refetch()}
        empty={!ready}
        emptyText={tx.completeHint}
        csv={data ? () => ({ filename: csvFilename(saved.report?.name ?? tx.title), rows: stickinessCsvRows(data.result) }) : undefined}
      >
        {data && (
          <div className="grid gap-4">
            <StickinessResultView result={data.result} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </div>
  );
}

export default function StickinessPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.stickiness;
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
