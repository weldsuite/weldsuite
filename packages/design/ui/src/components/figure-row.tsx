/**
 * A row of figures, as under the WeldBooks dashboard's chart (Stripe's
 * "balance / payouts" row): per figure a title, the value in larger tabular
 * numbers and one muted line under it. No boxes: the figures sit on the page
 * and wrap into fewer columns on narrow screens. A title can be a link.
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
  /** Columns on wide screens: 4 (the default; 2 on small screens) or 2 (for a narrow column). */
  columns?: 2 | 4;
  /** Shows a placeholder in place of each value. */
  loading?: boolean;
  className?: string;
}

const COLUMNS = { 2: 'grid-cols-2', 4: 'sm:grid-cols-2 lg:grid-cols-4' } as const;

export function FigureRow({ items, columns = 4, loading = false, className }: Readonly<FigureRowProps>) {
  return (
    <div className={cn('grid gap-x-8 gap-y-6', COLUMNS[columns], className)}>
      {items.map((item) => (
        <div key={item.key} className="min-w-0 space-y-1">
          <div className="text-sm font-medium">{item.label}</div>
          {loading ? <Skeleton className="h-7 w-16" /> : <p className="text-xl tabular-nums">{item.value}</p>}
          {item.note && <p className={cn('text-xs', item.warn ? 'text-destructive' : 'text-muted-foreground')}>{item.note}</p>}
        </div>
      ))}
    </div>
  );
}
