import { useProject } from '@/hooks/queries/use-projects-queries';
import { useFinanceSnapshots, useProjectFinance } from '@/hooks/queries/use-project-finance-queries';
import { BreakdownTable } from './_components/breakdown-table';
import { CurveChart } from './_components/curve-chart';
import { FinanceErrorState, FinanceLoadingState, PercentOnlyNotice, useFinanceEnv } from './_components/finance-parts';
import { KpiStrip } from './_components/kpi-strip';
import { PendingChangeCard } from './_components/pending-change-card';
import { RecentCosts } from './_components/recent-costs';

/** Finance › Overview: the figures, the S-curve, the cost by deliverable and the latest costs. */
export default function FinanceOverviewPage() {
  const { projectId, copy, format, intlLocale } = useFinanceEnv();
  const finance = useProjectFinance(projectId);
  const snapshots = useFinanceSnapshots(projectId);
  const project = useProject(projectId);

  if (finance.isLoading) return <FinanceLoadingState />;
  if (finance.isError || !finance.data) return <FinanceErrorState onRetry={() => void finance.refetch()} />;

  const data = finance.data;
  const endDate = project.data?.data?.endDate ?? null;
  const updated = new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.asOf));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {data.baseline ? format(copy.overview.baseline, { version: data.baseline.version }) : copy.overview.noBaseline}
        </span>
        <span>{format(copy.overview.source, { time: updated })}</span>
      </div>

      {data.canSeeAmounts ? null : <PercentOnlyNotice />}
      {data.excludedLines > 0 ? <PercentOnlyNotice message={format(copy.states.excluded, { count: data.excludedLines })} /> : null}

      <KpiStrip finance={data} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <CurveChart finance={data} snapshots={snapshots.data ?? []} endDate={endDate} />
        <div className="flex min-w-0 flex-col gap-4">
          <PendingChangeCard finance={data} />
          {data.canSeeAmounts ? <RecentCosts currency={data.currency} /> : null}
        </div>
      </div>

      <BreakdownTable finance={data} />
    </div>
  );
}
