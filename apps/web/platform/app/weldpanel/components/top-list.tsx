/**
 * Top lists for the flat WeldPanel pages (Live, Frustration): side by side,
 * divided by lines, no cards. Each shows the #1 with its count and share, a
 * header with what is counted, then every row as a ranked bar (the first
 * five, then "Show all"). A row can be a button (`onSelect`).
 */

import { useState, type ReactNode } from 'react';
import { RankedBars } from '@weldsuite/ui/components/ranked-bars';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber } from '../lib/format';
import { QueryErrorState } from './query-error-state';

/** The lists in one row; the row's gap shows its border colour between them. */
export function TopLists({ columns = 3, children }: Readonly<{ columns?: 2 | 3; children: ReactNode }>) {
  return <div className={cn('grid gap-px border-b bg-border', columns === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3')}>{children}</div>;
}

export interface TopListRow {
  value: string;
  count: number;
}

export interface TopListProps {
  title: string;
  /** The first column's name ("Country", "Page"). */
  dimension: string;
  /** What the numbers count ("Active visitors", "Count"). */
  metric: string;
  /** Biggest first. */
  rows: TopListRow[];
  /** How a value is shown (a country code as its name); the value itself by default. */
  label?: (value: string) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Shown when there are no rows. */
  emptyText: string;
  /** Makes each row a button; gets the row's value. */
  onSelect?: (value: string) => void;
}

const SHOWN = 5;

export function TopList({ title, dimension, metric, rows, label = (value) => value, loading, error, onRetry, emptyText, onSelect }: Readonly<TopListProps>) {
  const { t, language, format } = useI18n();
  const tc = t.weldpanel.observe.common;
  const [all, setAll] = useState(false);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const top = rows[0];
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });

  let body: ReactNode;
  if (error) body = <QueryErrorState error={error} onRetry={onRetry} />;
  else if (loading) body = <Skeleton className="h-40 w-full" />;
  else {
    body = (
      <>
        <div className="grid gap-0.5">
          <p className="truncate text-xs text-muted-foreground">{format(tc.rankTop, { name: top ? label(top.value) : '–' })}</p>
          <p className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{formatNumber(top?.count ?? 0, language)}</span>
            {top && total > 0 && <span className="text-sm text-muted-foreground tabular-nums">{percent.format(top.count / total)}</span>}
          </p>
        </div>
        <div className="flex items-center justify-between border-b pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>{dimension}</span>
          <span>{metric}</span>
        </div>
        {rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <RankedBars
            items={rows.map((row) => ({ key: row.value, label: label(row.value), value: row.count, display: formatNumber(row.count, language) }))}
            limit={all ? undefined : SHOWN}
            onShowAll={() => setAll(true)}
            showAllLabel={format(tc.showAll, { count: rows.length })}
            onSelect={onSelect ? (item) => onSelect(item.key) : undefined}
            label={title}
          />
        )}
      </>
    );
  }

  return (
    <section className="grid content-start gap-3 bg-background p-4" aria-label={title}>
      <h2 className="text-sm font-medium">{title}</h2>
      {body}
    </section>
  );
}
