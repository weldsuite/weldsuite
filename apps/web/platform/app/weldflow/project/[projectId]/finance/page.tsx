import { useProject } from '@/hooks/queries/use-projects-queries';
import { useFinanceSnapshots, useProjectFinance } from '@/hooks/queries/use-project-finance-queries';
import { BreakdownTable } from './_components/breakdown-table';
import { CurveChart } from './_components/curve-chart';
import { FinanceErrorState, FinanceLoadingState, PercentOnlyNotice, useFinanceEnv } from './_components/finance-parts';

/** Finance › Overview: the S-curve and the cost by deliverable. */
export default function FinanceOverviewPage() {
  const { projectId, copy, format } = useFinanceEnv();
  const finance = useProjectFinance(projectId);
  const snapshots = useFinanceSnapshots(projectId);
  const project = useProject(projectId);

  if (finance.isLoading) return <FinanceLoadingState />;
  if (finance.isError || !finance.data) return <FinanceErrorState onRetry={() => void finance.refetch()} />;

  const data = finance.data;
  const startDate = project.data?.data?.startDate ?? null;
  const endDate = project.data?.data?.endDate ?? null;

  return (
    <div className="flex flex-col gap-4">
      {data.canSeeAmounts ? null : <PercentOnlyNotice />}
      {data.excludedLines > 0 ? <PercentOnlyNotice message={format(copy.states.excluded, { count: data.excludedLines })} /> : null}

      <CurveChart finance={data} snapshots={snapshots.data ?? []} startDate={startDate} endDate={endDate} />

      <BreakdownTable finance={data} />
    </div>
  );
}
