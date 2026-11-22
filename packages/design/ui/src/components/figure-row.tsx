/**
 * A row of figures, as under the WeldBooks dashboard's chart (Stripe's
 * "balance / payouts" row): per figure a title, the value in larger tabular
 * numbers and one muted line under it. No boxes: the figures sit on the page
 * and wrap into fewer columns on narrow screens. A title can be a link.
 *
 * With `onSelect` the figures pick something (a signal, a metric): each is a
 * button, and the picked one is underlined on the line under the row (give
 * the row's container that bottom border and no bottom padding).
 */

import type { ReactNode } from 'react';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';

export interface FigureRowItem {
  key: string;
  /** What the figure is, such as "Cash balance"; may be a link to the list behind it. */
  label: ReactNode;
  /** The figure as shown, such as "€ 1.200,00" or "47". */
  value: ReactNode;
  /** One muted line under it, such as "3 open invoices". */
  note?: ReactNode;
  /** Shows the note in the destructive colour, for something overdue. */
  warn?: boolean;
}

export interface FigureRowProps {
  items: FigureRowItem[];
  /** Columns on wide screens: 4 (the default; 2 on small screens), 5, or 2 (for a narrow column). */
  columns?: 2 | 4 | 5;
  /** Shows a placeholder in place of each value. */
  loading?: boolean;
  /** Makes the figures pick: each is a button, the `selected` one underlined. */
  onSelect?: (key: string) => void;
  /** The picked figure's key. */
  selected?: string;
  /** Names the row of buttons for assistive tech. */
  label?: string;
  className?: string;
}

const COLUMNS = { 2: 'grid-cols-2', 4: 'sm:grid-cols-2 lg:grid-cols-4', 5: 'sm:grid-cols-3 lg:grid-cols-5' } as const;

function FigureContent({ item, loading }: Readonly<{ item: FigureRowItem; loading: boolean }>) {
  return (
    <>
      <div className="text-sm font-medium">{item.label}</div>
      {loading ? <Skeleton className="h-7 w-16" /> : <p className="text-xl tabular-nums">{item.value}</p>}
      {item.note && <p className={cn('text-xs', item.warn ? 'text-destructive' : 'text-muted-foreground')}>{item.note}</p>}
    </>
  );
}

export function FigureRow({ items, columns = 4, loading = false, onSelect, selected, label, className }: Readonly<FigureRowProps>) {
  if (onSelect) {
    return (
      <fieldset className={cn('grid min-w-0 gap-x-8', COLUMNS[columns], className)}>
        {label && <legend className="sr-only">{label}</legend>}
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={selected === item.key}
            onClick={() => onSelect(item.key)}
            className={cn(
              // The underline sits on the container's bottom border.
              '-mb-px min-w-0 space-y-1 border-b-2 pb-4 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected === item.key ? 'border-foreground' : 'border-transparent hover:border-border',
            )}
          >
            <FigureContent item={item} loading={loading} />
          </button>
        ))}
      </fieldset>
    );
  }
  return (
    <div className={cn('grid gap-x-8 gap-y-6', COLUMNS[columns], className)}>
      {items.map((item) => (
        <div key={item.key} className="min-w-0 space-y-1">
          <FigureContent item={item} loading={loading} />
        </div>
      ))}
    </div>
  );
}
