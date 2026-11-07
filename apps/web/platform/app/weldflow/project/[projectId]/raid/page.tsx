import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useRaidMatrix } from '@/hooks/queries/use-project-control-queries';
import { applyRegisterFilters, itemsOfKind } from './_lib/raid';
import { filterRisksByCell, isOpenItem, sortRisks, type MatrixCellRef } from './_lib/risk';
import { RaidEmptyState, RaidErrorState, RaidLoadingState } from './_components/raid-states';
import { RiskMatrix } from './_components/risk-matrix';
import { RiskRegister } from './_components/risk-register';
import { useRaid } from './_components/raid-context';

/** RAID › Risks: the 5 x 5 matrix, then the risk register as the standard list. */
export default function RaidRisksPage() {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { projectId, items, isLoading, isError, filters, showClosed } = useRaid();

  const [residual, setResidual] = useState(false);
  const [cell, setCell] = useState<MatrixCellRef | null>(null);

  const matrixQuery = useRaidMatrix(projectId, residual, !isLoading && !isError);

  const risks = useMemo(() => itemsOfKind(items, 'risk'), [items]);
  const openRisks = useMemo(() => risks.filter(isOpenItem), [risks]);

  const visible = useMemo(() => {
    const pool = showClosed ? risks : openRisks;
    return sortRisks(filterRisksByCell(applyRegisterFilters(pool, filters), cell, residual));
  }, [showClosed, risks, openRisks, filters, cell, residual]);

  const changeResidual = (next: boolean) => {
    setResidual(next);
    setCell(null);
  };

  if (isLoading) return <RaidLoadingState />;
  if (isError) return <RaidErrorState />;
  if (risks.length === 0) return <RaidEmptyState kind="risk" />;

  // Matrix and register side by side when the page is wide enough; measured on the page, so an open detail panel counts.
  return (
    <div className="@container/risks flex flex-1 flex-col">
      <div className="flex flex-1 flex-col @5xl/risks:flex-row">
        <div className="shrink-0 border-b border-border pb-4 @5xl/risks:w-[31rem] @5xl/risks:border-r @5xl/risks:border-b-0">
          <div className="max-w-[31rem]">
            <RiskMatrix
              matrix={matrixQuery.data}
              isLoading={matrixQuery.isLoading}
              isError={matrixQuery.isError}
              onRetry={() => void matrixQuery.refetch()}
              residual={residual}
              onResidualChange={changeResidual}
              selected={cell}
              onSelect={setCell}
            />
          </div>
          {cell ? (
            <button
              type="button"
              onClick={() => setCell(null)}
              className="mx-3 mt-3 inline-flex items-center gap-1.5 rounded-full border bg-muted py-0.5 pr-2 pl-2.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:mx-4"
            >
              {format(residual ? copy.matrix.filterChipResidual : copy.matrix.filterChip, {
                probability: cell.probability,
                impact: cell.impact,
              })}
              <X aria-hidden className="size-3" />
              <span className="sr-only">{copy.matrix.clearFilter}</span>
            </button>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <RiskRegister risks={visible} cell={cell} />
        </div>
      </div>
    </div>
  );
}
