/**
 * The card around every chart, list and grid of the analytics pages: a title
 * row with actions, then one of loading skeleton, query error, empty text or
 * the content. Errors go through `QueryErrorState` so a 503 is a calm notice.
 * Pass `csv` and the card gets an "Export CSV" button (shown once there is
 * content to export).
 */

import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { downloadCsv, type CsvExport } from '../lib/csv';
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
  /**
   * The card's data as rows, for "Export CSV" (`lib/csv.ts`). Called on click,
   * so build the rows from the result inside it; name the file with
   * `csvFilename(reportOrPageName)`.
   */
  csv?: () => CsvExport;
  /** No card around it: the title row and the content sit flat on the page, for a report that is the page's whole body (Flows). */
  bare?: boolean;
}

/** The "Export CSV" icon button; also usable outside a card (a table's toolbar, the users list). */
export function CsvExportButton({ csv, disabled }: Readonly<{ csv: () => CsvExport; disabled?: boolean }>) {
  const { t } = useI18n();
  const label = t.weldpanel.collab.csv.export;
  return (
    <Button type="button" variant="ghost" size="icon" className="size-7" disabled={disabled} aria-label={label} title={label} onClick={() => downloadCsv(csv())}>
      <Download className="size-4" />
    </Button>
  );
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
  csv,
  bare = false,
}: Readonly<ChartCardProps>) {
  const { t } = useI18n();
  let body: ReactNode = children;
  if (error) body = <QueryErrorState error={error} onRetry={onRetry} />;
  else if (loading) body = <Skeleton className={cn('h-48 w-full', skeletonClassName)} />;
  else if (empty) body = <EmptyText>{emptyText ?? t.weldpanel.analytics.common.noData}</EmptyText>;
  const showCsv = csv !== undefined && !error && !loading && !empty;
  const toolbar = (actions || showCsv) && (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {actions}
      {showCsv && csv && <CsvExportButton csv={csv} />}
    </div>
  );

  if (bare) {
    return (
      <section className={cn('grid min-w-0 gap-3', className)}>
        {(title || toolbar) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {title && <h2 className="text-sm font-medium">{title}</h2>}
            {toolbar}
          </div>
        )}
        <div className={contentClassName}>{body}</div>
      </section>
    );
  }

  return (
    <Card className={cn('min-w-0 gap-3 py-4', className)}>
      {(title || actions || showCsv) && (
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 px-4 pb-0">
          {title && <CardTitle className="text-sm font-medium">{title}</CardTitle>}
          {toolbar}
        </CardHeader>
      )}
      <CardContent className={cn('px-4', contentClassName)}>{body}</CardContent>
    </Card>
  );
}
