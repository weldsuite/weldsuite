/** Signal: which events, done early, go with reaching a goal. */

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { PanelSignalSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelSignal } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { ChartCard } from '../components/chart-card';
import { DateRangePicker } from '../components/date-range-picker';
import { PanelDefinitionsProvider } from '../components/definitions';
import { FilterBuilder } from '../components/filter-builder';
import { FreshnessBadge } from '../components/freshness-badge';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { ReportActions } from '../components/report-actions';
import { SignalResultView } from '../components/results/signal-result';
import { SavedReportNotices } from '../components/saved-report-notices';
import { useSavedReport } from '../components/use-saved-report';
import { defaultReportName, emptySignalDraft, isSignalReady, signalDraftFromSpec, type SignalDraft } from '../lib/builders';
import { csvFilename } from '../lib/csv';
import { parseRange, useDateRange } from '../lib/date-range';
import { signalCsvRows } from '../lib/explore-csv';

const MAX_CANDIDATES = 20;
const TOP_N = [5, 10, 15, 20] as const;
const WINDOWS = [1, 3, 7, 14, 30, 60, 90] as const;

function Builder({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.signal;
  const [range, setRange] = useDateRange();
  const [draft, setDraft] = useState<SignalDraft>(emptySignalDraft);

  const saved = useSavedReport({
    kind: 'signal',
    apply: (spec, savedRange) => {
      const next = signalDraftFromSpec(spec);
      if (!next) return false;
      setDraft(next);
      if (savedRange) setRange(parseRange(savedRange));
      return true;
    },
  });

  const ready = isSignalReady(draft);
  const candidates = draft.candidates ?? [];
  const spec = useMemo<PanelSignalSpec>(
    () => ({ ...draft, projectId, dateRange: range, candidates: draft.candidates && draft.candidates.length > 0 ? draft.candidates : undefined }),
    [draft, projectId, range],
  );
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelSignal(spec, { enabled: ready });
  const setCandidates = (next: string[]) => setDraft((d) => ({ ...d, candidates: next.length > 0 ? next : undefined }));

  if (saved.isLoading) return <PageLoader fullScreen={false} label={t.weldpanel.analytics.insights.loadingReport} />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReportActions projectId={projectId} spec={ready ? spec : null} report={saved.wrongKindPath ? null : saved.report} defaultName={defaultReportName(draft.goal.event)} onSaved={saved.open} />
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <SavedReportNotices saved={saved} />

      <SectionCard title={tx.title}>
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <LabeledField label={tx.goal} htmlFor="weldpanel-signal-goal">
              <EventPicker id="weldpanel-signal-goal" projectId={projectId} value={draft.goal.event} onChange={(event) => setDraft((d) => ({ ...d, goal: { ...d.goal, event } }))} ariaLabel={tx.goal} />
            </LabeledField>
            <LabeledField label={tx.windowDays} htmlFor="weldpanel-signal-window">
              <Select value={String(draft.windowDays ?? 7)} onValueChange={(next) => setDraft((d) => ({ ...d, windowDays: Number(next) }))}>
                <SelectTrigger id="weldpanel-signal-window">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {format(tx.windowDaysValue, { count: n })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            {candidates.length === 0 && (
              <LabeledField label={tx.topN} htmlFor="weldpanel-signal-top">
                <Select value={String(draft.topN ?? 10)} onValueChange={(next) => setDraft((d) => ({ ...d, topN: Number(next) }))}>
                  <SelectTrigger id="weldpanel-signal-top">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOP_N.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {format(tx.topNValue, { count: n })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </LabeledField>
            )}
          </div>
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">{tx.goalFilters}</p>
            <FilterBuilder compact projectId={projectId} filters={draft.goal.filters ?? []} onChange={(filters) => setDraft((d) => ({ ...d, goal: { ...d.goal, filters } }))} />
          </div>

          <div className="grid gap-2" role="group" aria-label={tx.candidates}>
            <p className="text-sm font-medium">{tx.candidates}</p>
            <p className="text-xs text-muted-foreground">{tx.candidatesHint}</p>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {candidates.map((candidate, index) => (
                <li key={index} className="flex items-center gap-1">
                  <EventPicker
                    projectId={projectId}
                    value={candidate}
                    onChange={(event) => setCandidates(candidates.map((c, i) => (i === index ? event : c)))}
                    ariaLabel={format(tx.candidate, { n: index + 1 })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0"
                    aria-label={format(tx.removeCandidate, { n: index + 1 })}
                    onClick={() => setCandidates(candidates.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
            {candidates.length < MAX_CANDIDATES && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setDraft((d) => ({ ...d, candidates: [...(d.candidates ?? []), ''] }))}>
                  <Plus />
                  {tx.addCandidate}
                </Button>
              </div>
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
        csv={data ? () => ({ filename: csvFilename(saved.report?.name ?? tx.title), rows: signalCsvRows(data.result) }) : undefined}
      >
        {data && (
          <div className="grid gap-4">
            <SignalResultView result={data.result} />
            <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} onRefresh={() => void refetch()} clampedToRetention={data.result.range.clampedToRetention} />
          </div>
        )}
      </ChartCard>
    </div>
  );
}

export default function SignalPage() {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.signal;
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
