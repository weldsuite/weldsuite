import { X } from 'lucide-react';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '../_lib/locale';
import { categoryLabel, strategyLabel } from '../_lib/copy';
import { formatShortDate } from '../_lib/raid';
import type { MatrixCellRef } from '../_lib/risk';
import { DueLabel, ItemCode, OwnerCell, ScoreBadge, StatusPill, TaskProgress } from './raid-parts';
import { useRaid } from './raid-context';

interface RiskRegisterProps {
  /** The risks to list, already filtered and in register order. */
  risks: RaidItem[];
  residual: boolean;
  /** The matrix cell the register is filtered to, if any. */
  cell: MatrixCellRef | null;
  onClearCell: () => void;
  /** True when some filter or cell narrows the list (for the empty message). */
  narrowed: boolean;
}

/** The risk table next to the matrix. */
export function RiskRegister({ risks, residual, cell, onClearCell, narrowed }: Readonly<RiskRegisterProps>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { selectedId, select, now } = useRaid();
  const intlLocale = intlLocaleOf(language);

  return (
    <section aria-labelledby="raid-register-title" className="min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3.5">
        <h2 id="raid-register-title" className="text-sm font-semibold">
          {copy.register.title}
        </h2>
        <span className="text-xs text-muted-foreground">{copy.register.sortedByScore}</span>
        {cell ? (
          <button
            type="button"
            onClick={onClearCell}
            className="inline-flex items-center gap-1.5 rounded-full border bg-muted py-0.5 pr-2 pl-2.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2.5 font-medium">{copy.columns.risk}</th>
              <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.score}</th>
              <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.owner}</th>
              <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.status}</th>
              <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.mitigation}</th>
              <th scope="col" className="py-2.5 pr-4 pl-2 font-medium">{copy.columns.nextReview}</th>
            </tr>
          </thead>
          <tbody>
            {risks.map((risk) => {
              const secondary = [categoryLabel(copy, risk.category), strategyLabel(copy, risk.strategy)].filter(Boolean).join(' · ');
              const selected = risk.id === selectedId;
              return (
                <tr
                  key={risk.id}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => select(risk.id)}
                  className={cn('cursor-pointer border-t align-top transition-colors hover:bg-accent/40', selected && 'bg-accent/60')}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ItemCode code={risk.code} />
                      <button type="button" className="text-left font-medium outline-none hover:underline focus-visible:underline">
                        {risk.title}
                      </button>
                    </div>
                    {secondary ? <div className="mt-0.5 text-xs text-muted-foreground">{secondary}</div> : null}
                  </td>
                  <td className="px-2 py-3 whitespace-nowrap">
                    {risk.score !== null && risk.band !== null ? <ScoreBadge score={risk.score} band={risk.band} /> : null}
                    <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {risk.probability} × {risk.impact}
                      {risk.residualScore !== null ? ` · ${format(copy.register.target, { score: risk.residualScore })}` : ''}
                    </div>
                  </td>
                  <td className="px-2 py-3">
                    <OwnerCell ownerId={risk.ownerId} />
                  </td>
                  <td className="px-2 py-3">
                    <StatusPill kind="risk" status={risk.status} />
                  </td>
                  <td className="w-40 px-2 py-3">
                    {risk.taskProgress.total > 0 ? (
                      <TaskProgress progress={risk.taskProgress} />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {risk.strategy === 'accept' ? copy.register.noTasksAccepted : copy.register.noTasks}
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 pl-2">
                    <DueLabel
                      dueAt={risk.dueAt}
                      closedText={risk.closedAt ? format(copy.due.closedOn, { date: formatShortDate(risk.closedAt, intlLocale, now) }) : null}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {risks.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          {cell && !narrowed ? copy.register.noRisksInCell : copy.register.noMatches}
        </div>
      ) : null}
    </section>
  );
}
