import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useRaidMatrix } from '@/hooks/queries/use-project-control-queries';
import {
  EMPTY_FILTERS,
  applyRegisterFilters,
  categoriesIn,
  hasActiveFilters,
  itemsOfKind,
  ownerIdsOf,
  statusesOf,
  type RegisterFilters,
} from './_lib/raid';
import { filterRisksByCell, isOpenItem, riskStats, sortRisks, type MatrixCellRef } from './_lib/risk';
import { BAND_STYLES } from './_lib/styles';
import { SummaryTile } from './_components/raid-parts';
import { RaidToolbar } from './_components/raid-toolbar';
import { RaidEmptyState, RaidErrorState, RaidLoadingState } from './_components/raid-states';
import { RiskMatrix } from './_components/risk-matrix';
import { RiskRegister } from './_components/risk-register';
import { useRaid } from './_components/raid-context';

/** RAID › Risks: summary tiles, the 5 x 5 matrix and the risk register. */
export default function RaidRisksPage() {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { projectId, items, isLoading, isError, now } = useRaid();

  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS);
  const [showClosed, setShowClosed] = useState(false);
  const [residual, setResidual] = useState(false);
  const [cell, setCell] = useState<MatrixCellRef | null>(null);

  const matrixQuery = useRaidMatrix(projectId, residual, !isLoading && !isError);

  const risks = useMemo(() => itemsOfKind(items, 'risk'), [items]);
  const openRisks = useMemo(() => risks.filter(isOpenItem), [risks]);
  const closedCount = risks.length - openRisks.length;
  const stats = useMemo(() => riskStats(openRisks, now), [openRisks, now]);

  const visible = useMemo(() => {
    const pool = showClosed ? risks : openRisks;
    return sortRisks(filterRisksByCell(applyRegisterFilters(pool, filters), cell, residual));
  }, [showClosed, risks, openRisks, filters, cell, residual]);

  const changeResidual = (next: boolean) => {
    setResidual(next);
    setCell(null);
  };

  if (isLoading) return <RaidLoadingState tiles={5} />;
  if (isError) return <RaidErrorState />;
  if (risks.length === 0) return <RaidEmptyState kind="risk" />;

  return (
    <div className="flex flex-col gap-4">
      <RaidToolbar
        kind="risk"
        filters={filters}
        onFiltersChange={setFilters}
        statuses={statusesOf('risk')}
        ownerIds={ownerIdsOf(risks)}
        hasUnowned={risks.some((risk) => !risk.ownerId)}
        categories={categoriesIn(risks)}
        closedCount={closedCount}
        showClosed={showClosed}
        onToggleClosed={() => setShowClosed((value) => !value)}
      />

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]">
        <SummaryTile label={copy.tiles.openRisks} value={stats.open} />
        <SummaryTile label={copy.tiles.critical} value={stats.critical} swatch={BAND_STYLES.critical.cell} />
        <SummaryTile label={copy.tiles.high} value={stats.high} swatch={BAND_STYLES.high.cell} />
        <SummaryTile label={copy.tiles.reviewsOverdue} value={stats.reviewsOverdue} tone={stats.reviewsOverdue > 0 ? 'danger' : undefined} />
        <SummaryTile
          label={copy.tiles.mitigationDone}
          value={stats.tasksPercent === null ? '—' : `${stats.tasksPercent}%`}
          hint={stats.tasksPercent === null ? copy.tiles.noTasksLinked : format(copy.tiles.tasksOf, { done: stats.tasksDone, total: stats.tasksTotal })}
        >
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-foreground/80" style={{ width: `${stats.tasksPercent ?? 0}%` }} />
          </div>
        </SummaryTile>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[1_1_22rem] lg:max-w-[28.75rem]">
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
        <div className="min-w-0 flex-[999_1_34rem]">
          <RiskRegister
            risks={visible}
            residual={residual}
            cell={cell}
            onClearCell={() => setCell(null)}
            narrowed={hasActiveFilters(filters)}
          />
        </div>
      </div>
    </div>
  );
}
