import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { PANEL_RETENTION_INTERVALS, type PanelRetentionSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelRetention } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { RetentionResultView } from '../components/results/retention-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptyRetentionDraft, isRetentionReady, retentionDraftFromSpec, type RetentionDraft } from '../lib/builders';
import { parseRange, useDateRange } from '../lib/date-range';

const PERIOD_CHOICES = [4, 8, 12, 20, 30] as const;

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const tr = t.weldpanel.analytics.retention;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<RetentionDraft>(emptyRetentionDraft);

  const saved = useSavedReport({
    kind: 'retention',
    apply: (spec, savedRange) => {
      const next = retentionDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const ready = isRetentionReady(draft);
  const spec = useMemo<PanelRetentionSpec>(() => ({ ...draft, projectId, dateRange: range }), [draft, projectId, range]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelRetention(spec, { enabled: ready });

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.firstEvent)} onSaved={saved.open} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <SectionCard title={tr.title}>
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <LabeledField label={tr.firstEvent} htmlFor="weldpanel-retention-first" hint={tr.firstEventHint}>
              <EventPicker id="weldpanel-retention-first" projectId={projectId} value={draft.firstEvent} onChange={(firstEvent) => setDraft((d) => ({ ...d, firstEvent }))} ariaLabel={tr.firstEvent} />
            </LabeledField>
            <LabeledField label={tr.returnEvent} htmlFor="weldpanel-retention-return" hint={tr.returnEventHint}>
              <div className="flex gap-1">
                <EventPicker
                  id="weldpanel-retention-return"
                  projectId={projectId}
                  value={draft.returnEvent ?? ''}
                  placeholder={tr.anyEvent}
                  onChange={(returnEvent) => setDraft((d) => ({ ...d, returnEvent }))}
                  ariaLabel={tr.returnEvent}
                />
                {draft.returnEvent && (
                  <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0" aria-label={tr.anyEvent} onClick={() => setDraft((d) => ({ ...d, returnEvent: undefined }))}>
                    <X />
                  </Button>
                )}
              </div>
            </LabeledField>
            <LabeledField label={tr.interval} htmlFor="weldpanel-retention-interval">
              <Select value={draft.interval ?? 'week'} onValueChange={(interval) => setDraft((d) => ({ ...d, interval: interval as RetentionDraft['interval'] }))}>
                <SelectTrigger id="weldpanel-retention-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PANEL_RETENTION_INTERVALS.map((interval) => (
                    <SelectItem key={interval} value={interval}>
                      {tr.intervals[interval]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label={tr.periods} htmlFor="weldpanel-retention-periods">
              <Select value={String(draft.periods ?? 8)} onValueChange={(periods) => setDraft((d) => ({ ...d, periods: Number(periods) }))}>
                <SelectTrigger id="weldpanel-retention-periods">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_CHOICES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
          </div>
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">{tr.globalFilters}</p>
            <FilterBuilder projectId={projectId} filters={draft.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
          </div>
        </div>
      </SectionCard>

      <ChartCard title={t.weldpanel.analytics.insights.resultsTitle} loading={ready && isLoading} error={ready ? error : undefined} onRetry={() => void refetch()} empty={!ready} emptyText={tr.completeHint}>
        {data && (
          <div className="grid gap-4">
            <RetentionResultView result={data.result} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </div>
  );
}

export default function RetentionPage() {
  const { t } = useI18n();
  const tr = t.weldpanel.analytics.retention;
  return (
    <AnalyticsPage title={tr.title} description={tr.description}>
      {(project) => <Builder key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}
