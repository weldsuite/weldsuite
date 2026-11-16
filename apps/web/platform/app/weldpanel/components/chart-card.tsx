/**
 * The card around every chart, list and grid of the analytics pages: a title
 * row with actions, then one of loading skeleton, query error, empty text or
 * the content. Errors go through `QueryErrorState` so a 503 is a calm notice.
 */

import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { QueryErrorState } from './query-error-state';

interface ChartCardProps {
  title?: ReactNode;
  /** Right of the title: tabs, a toggle or a menu. */
  actions?: ReactNode;
  /** Shows a skeleton instead of the content (first load only: keep showing old data while refetching). */
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Shows `emptyText` instead of the content. */
  empty?: boolean;
  emptyText?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  skeletonClassName?: string;
}

export function ChartCard({
  title,
  actions,
  loading,
  error,
  onRetry,
  empty,
  emptyText,
  children,
  className,
  contentClassName,
  skeletonClassName,
}: Readonly<ChartCardProps>) {
  const { t } = useI18n();
  let body: ReactNode = children;
  if (error) body = <QueryErrorState error={error} onRetry={onRetry} />;
  else if (loading) body = <Skeleton className={cn('h-48 w-full', skeletonClassName)} />;
  else if (empty) body = <EmptyText>{emptyText ?? t.weldpanel.analytics.common.noData}</EmptyText>;

  return (
    <Card className={cn('min-w-0 gap-3 py-4', className)}>
      {(title || actions) && (
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 px-4 pb-0">
          {title && <CardTitle className="text-sm font-medium">{title}</CardTitle>}
          {actions}
        </CardHeader>
      )}
      <CardContent className={cn('px-4', contentClassName)}>{body}</CardContent>
    </Card>
  );
}
