
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useTranslations } from '@weldsuite/i18n/client';

interface EntityGridSkeletonProps {
  /** Placeholder columns after the name column. */
  columns?: number;
  rows?: number;
}

// Varied so the placeholder rows read as text of different lengths, not a stripe.
const CELL_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5'];

/**
 * Placeholder for an entity grid whose first fetch is still pending. Shown
 * instead of the empty state: "No companies yet" must only appear once the
 * request has completed with zero results.
 */
export function EntityGridSkeleton({ columns = 6, rows = 12 }: Readonly<EntityGridSkeletonProps>) {
  const t = useTranslations();
  const columnSlots = Array.from({ length: columns }, (_, i) => `col-${i}`);
  const rowSlots = Array.from({ length: rows }, (_, i) => `row-${i}`);

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('common.labels.loading')}
      data-testid="entity-grid-skeleton"
      className="flex flex-col bg-background h-full overflow-hidden"
    >
      {/* Toolbar */}
      <div className="w-full border-b border-border py-[10px]">
        <div className="flex items-center gap-2 px-3 md:px-4">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-28" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="hidden md:block h-8 w-28" />
            <Skeleton className="h-8 w-28" />
          </div>
        </div>
      </div>

      {/* Header row */}
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-border px-4">
        <Skeleton className="h-3.5 w-28 md:w-60" />
        {columnSlots.map((slot) => (
          <Skeleton key={slot} className="hidden md:block h-3.5 w-20" />
        ))}
      </div>

      {/* Body rows */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {rowSlots.map((slot, rowIndex) => (
          <div key={slot} className="flex h-10 items-center gap-4 border-b border-border px-4">
            <div className="flex w-28 md:w-60 shrink-0 items-center gap-2.5">
              <Skeleton className="size-6 rounded-full shrink-0" />
              <Skeleton className={`h-3.5 ${CELL_WIDTHS[rowIndex % CELL_WIDTHS.length]}`} />
            </div>
            {columnSlots.map((columnSlot, columnIndex) => (
              <div key={columnSlot} className="hidden md:block w-20 shrink-0">
                <Skeleton className={`h-3.5 ${CELL_WIDTHS[(rowIndex + columnIndex) % CELL_WIDTHS.length]}`} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
