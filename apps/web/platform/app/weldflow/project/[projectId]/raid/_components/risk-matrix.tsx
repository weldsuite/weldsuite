import type { RaidMatrix } from '@weldsuite/app-api-client/domains/project-control';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { impactName, probabilityName } from '../_lib/copy';
import { RATINGS, RISK_BANDS, matrixCount, riskBand, riskScore, sameCell, type MatrixCellRef } from '../_lib/risk';
import { BAND_LEGEND_RANGES, BAND_STYLES } from '../_lib/styles';

interface RiskMatrixProps {
  /** Open risks per cell; undefined until loaded. */
  matrix: RaidMatrix | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** True: each risk counted in its after-mitigation cell. */
  residual: boolean;
  onResidualChange: (residual: boolean) => void;
  selected: MatrixCellRef | null;
  onSelect: (cell: MatrixCellRef | null) => void;
}

/** The 5 x 5 probability and impact matrix; a click on a cell filters the register. */
export function RiskMatrix({
  matrix,
  isLoading,
  isError,
  onRetry,
  residual,
  onResidualChange,
  selected,
  onSelect,
}: Readonly<RiskMatrixProps>) {
  const { t, plural, format } = useI18n();
  const copy = t.projects.raid;
  const rows = [...RATINGS].reverse();

  return (
    <section aria-labelledby="raid-matrix-title" className="rounded-lg border bg-card p-4 text-card-foreground">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
        <h2 id="raid-matrix-title" className="text-sm font-semibold">
          {copy.matrix.title}
        </h2>
        <div role="group" aria-label={copy.matrix.scoreShown} className="inline-flex rounded-lg bg-muted p-0.5">
          {[
            { value: false, label: copy.matrix.current },
            { value: true, label: copy.matrix.afterMitigation },
          ].map((option) => (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={residual === option.value}
              onClick={() => onResidualChange(option.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                residual === option.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {isError ? (
        <div role="alert" className="mb-3 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          <span>{copy.matrix.loadFailed}</span>
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            {copy.states.retry}
          </Button>
        </div>
      ) : null}

      <div className="flex gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground [writing-mode:vertical-rl] rotate-180 text-center">
          {copy.probability.label}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {rows.map((probability) => (
            <div key={probability} className="grid grid-cols-[4.25rem_repeat(5,minmax(0,1fr))] items-stretch gap-1 sm:grid-cols-[4.75rem_repeat(5,minmax(0,1fr))]">
              <div className="flex flex-col justify-center text-[11px] leading-tight text-muted-foreground">
                <span className="font-semibold text-foreground/80">{probability}</span>
                {probabilityName(copy, probability)}
              </div>
              {RATINGS.map((impact) => {
                const cell = { probability, impact };
                const count = matrixCount(matrix, cell);
                const isSelected = sameCell(selected, cell);
                const band = riskBand(riskScore(probability, impact));
                return (
                  <button
                    key={impact}
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={plural(count, {
                      one: format(copy.matrix.cellLabel.one, { probability, impact }),
                      other: format(copy.matrix.cellLabel.other, { probability, impact }),
                    })}
                    onClick={() => onSelect(isSelected ? null : cell)}
                    className={cn(
                      'flex h-12 items-center justify-center rounded-md outline-none transition-shadow sm:h-[3.375rem]',
                      'focus-visible:ring-[3px] focus-visible:ring-ring/60',
                      BAND_STYLES[band].cell,
                      isSelected && 'ring-2 ring-foreground ring-offset-1 ring-offset-card',
                    )}
                  >
                    {isLoading ? (
                      <Skeleton className="h-4 w-4 rounded-full opacity-40" />
                    ) : count > 0 ? (
                      <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-white px-1.5 text-xs font-bold text-neutral-900 shadow-sm">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="mt-0.5 grid grid-cols-[4.25rem_repeat(5,minmax(0,1fr))] gap-1 sm:grid-cols-[4.75rem_repeat(5,minmax(0,1fr))]">
            <div />
            {RATINGS.map((impact) => (
              <div key={impact} className="text-center text-[11px] leading-tight text-muted-foreground">
                <div className="font-semibold text-foreground/80">{impact}</div>
                {impactName(copy, impact)}
              </div>
            ))}
          </div>
          <div className="mt-1.5 pl-[4.5rem] text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:pl-[5rem]">
            {copy.impact.label}
          </div>
        </div>
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5 border-t pt-3 text-xs text-muted-foreground">
        {RISK_BANDS.map((band) => (
          <li key={band} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2.5 rounded-[3px]', BAND_STYLES[band].cell)} />
            {format(copy.matrix.legend, {
              band: copy.bands[band],
              range: `${BAND_LEGEND_RANGES[band].min}–${BAND_LEGEND_RANGES[band].max}`,
            })}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{copy.matrix.hint}</p>
    </section>
  );
}
