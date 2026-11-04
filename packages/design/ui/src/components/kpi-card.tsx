import type { ComponentType, ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';

export type KpiTone = 'default' | 'warning' | 'danger' | 'success';

const TONE_CLASS: Record<KpiTone, string | undefined> = {
  default: undefined,
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive',
  success: 'text-emerald-600 dark:text-emerald-400',
};

/** The row of KPI tiles at the top of a dashboard: 1, 2 or 4 columns by width. */
export function KpiGrid({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>;
}

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  /** A short line under the value ("3 overdue", "vs. last month"). */
  hint?: ReactNode;
  /** Colors the value: amber for warning, red for danger, green for success. */
  tone?: KpiTone;
  /** Shows a skeleton in place of the value. */
  loading?: boolean;
  /**
   * Hover treatment for a tile that is a link or button. The tile renders no
   * link itself (the app's router owns that): wrap it, for example
   * `<Link to="/orders" className="block rounded-xl"><KpiCard interactive … /></Link>`.
   */
  interactive?: boolean;
  className?: string;
}

/** One KPI tile: muted label and icon on top, a large value, an optional hint. */
export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = 'default',
  loading = false,
  interactive = false,
  className,
}: Readonly<KpiCardProps>) {
  return (
    <Card className={cn('h-full', interactive && 'transition-colors hover:bg-accent/40', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className={cn('text-2xl font-bold tabular-nums', TONE_CLASS[tone])}>{value}</div>
        )}
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
