/**
 * The change against the previous period under a KPI, and the chart axis
 * label of a bucket. Same look and rules as the overview's.
 */

import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TranslationsType } from '@/lib/i18n/types';

type ReportsT = TranslationsType['helpdesk']['reports'];

/** "Mar 9" for a day or week bucket, "Mar 26" for a month. `date` is YYYY-MM-DD. */
export function bucketDateLabel(date: string, bucket: 'day' | 'week' | 'month'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const day = new Date(`${date}T00:00:00Z`);
  if (bucket === 'month') return day.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The colour of a change: muted when it is neither good nor bad, else green or red. */
function deltaColour(neutral: boolean, good: boolean): string {
  if (neutral) return 'text-muted-foreground';
  return good ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive';
}

/**
 * The relative change of `value` against `previous`, coloured by whether it is
 * good: fewer missed calls is good. `neutral` leaves the colour out for a
 * number that is neither (handle time).
 */
export function ReportDelta({
  value,
  previous,
  lowerIsBetter = false,
  neutral = false,
  t,
}: Readonly<{
  value: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
  neutral?: boolean;
  t: ReportsT;
}>) {
  if (value == null || previous == null || previous === 0) return null;
  const change = Math.round(((value - previous) / previous) * 100);
  if (change === 0) return <span className="text-muted-foreground">0% {t.vsPrevious}</span>;
  const up = change > 0;
  const good = up !== lowerIsBetter;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-flex items-center', deltaColour(neutral, good))}>
        <Icon className="h-3 w-3" aria-hidden />
        {Math.abs(change)}%
      </span>
      <span className="text-muted-foreground">{t.vsPrevious}</span>
    </span>
  );
}

/** A KPI hint: the change on top, a muted line under it. */
export function ReportHint({ children, delta }: Readonly<{ children?: ReactNode; delta?: ReactNode }>) {
  return (
    <span className="flex flex-col gap-0.5">
      {delta}
      {children && <span className="text-muted-foreground">{children}</span>}
    </span>
  );
}
