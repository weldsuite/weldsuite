import { Fragment } from 'react';
import type { RaidMatrix } from '@weldsuite/app-api-client/domains/project-control';
import { Button } from '@weldsuite/ui/components/button';
import { CountBadge } from '@weldsuite/ui/components/count-badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { impactName, probabilityName } from '../_lib/copy';
import { RATINGS, matrixCount, riskBand, riskScore, sameCell, type MatrixCellRef } from '../_lib/risk';
import { BAND_STYLES } from '../_lib/styles';

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

/**
 * The axis labels of the table, in the colours of an outline toolbar button (the RAID sub-tabs): its input tint
 * mixed into the page background in dark mode (solid, so the grid lines do not show through), muted text.
 */
const LABEL_CELL =
  'flex items-center justify-center bg-background text-[11px] text-muted-foreground dark:bg-[color-mix(in_oklab,var(--input)_30%,var(--background))]';
/** The axis titles: a bar in the page background with the matrix's small uppercase titles. */
const AXIS_BAR = 'flex items-center justify-center bg-background text-[11px] font-semibold uppercase tracking-wider text-foreground';

/**
 * The 5 x 5 probability and impact matrix, drawn as the classic risk matrix
 * table: axis bars and labels around square cells in flat band colours, each
 * named by its band. A click on a cell filters the register.
 */
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
    <section aria-labelledby="raid-matrix-title">
      <h2 id="raid-matrix-title" className="sr-only">
        {copy.matrix.title}
      </h2>
      {isError ? (
        <div role="alert" className="m-3 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs md:m-4">
          <span>{copy.matrix.loadFailed}</span>
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            {copy.states.retry}
          </Button>
        </div>
      ) : null}

      {/*
        One grid, its 1px gaps the cell borders in the colour of the sidebar's vertical line: an empty corner, impact bar and labels
        on top; probability bar and labels on the left. It fills its column, so only the bottom edge draws a border:
        the toolbar above and the column divider beside it are the other edges.
      */}
      <div className="grid grid-cols-[2rem_2rem_repeat(5,minmax(0,1fr))] gap-px border-b border-sidebar-border bg-sidebar-border">
        {/* The two header rows are as tall as the two side columns are wide (2rem each), so the corner is square. */}
        <div aria-hidden className="col-span-2 row-span-2 bg-background" />
        <div className={cn(AXIS_BAR, 'col-span-5 h-8')}>{copy.impact.label}</div>
        {RATINGS.map((impact) => (
          <div key={impact} className={cn(LABEL_CELL, 'h-8 truncate px-1')}>
            {impactName(copy, impact)}
          </div>
        ))}

        <div className={cn(AXIS_BAR, 'col-start-1 row-span-5 row-start-3')}>
          <span className="rotate-180 [writing-mode:vertical-rl]">{copy.probability.label}</span>
        </div>
        {rows.map((probability) => (
          <Fragment key={probability}>
            <div className={LABEL_CELL}>
              <span className="rotate-180 whitespace-nowrap [writing-mode:vertical-rl]">{probabilityName(copy, probability)}</span>
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
                    'flex aspect-square flex-col items-center justify-center gap-1 text-[11px] font-medium text-black outline-none transition-[filter] hover:brightness-95',
                    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black',
                    BAND_STYLES[band].cell,
                    isSelected && 'ring-[3px] ring-inset ring-black',
                  )}
                >
                  <span>{copy.bands[band]}</span>
                  {isLoading ? <Skeleton className="h-4 w-4 rounded-full opacity-40" /> : null}
                  {!isLoading && count > 0 ? (
                    // The app rail's count badge; the cell's label already says how many risks it holds.
                    <CountBadge aria-hidden count={count} />
                  ) : null}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>

      <div className="px-3 pt-3 md:px-4">
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
    </section>
  );
}
