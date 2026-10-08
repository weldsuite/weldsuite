import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, type LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useI18n } from '@/lib/i18n/provider';
import { isSalesTaxRequestError } from '@/lib/api/domains/weldbooks-sales-tax-center';

interface ErrorStateProps {
  onRetry?: () => void;
  title?: string;
  /** The error that failed the load: its message is shown when it came from the server. */
  error?: unknown;
}

/** A load that failed: what happened and a retry. */
export function ErrorState({ onRetry, title, error }: Readonly<ErrorStateProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center.common;
  const detail = isSalesTaxRequestError(error) && error.message ? error.message : tc.loadFailedDescription;
  return (
    <Card role="alert">
      <CardContent className="space-y-3 py-10 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
        <p className="font-medium">{title ?? tc.loadFailed}</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{detail}</p>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            {tc.retry}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** Buttons under the text. */
  action?: ReactNode;
}

/** Nothing to show yet, and what to do about it. */
export function EmptyState({ title, description, icon: Icon = Inbox, action }: Readonly<EmptyStateProps>) {
  return (
    <Card>
      <CardContent className="space-y-3 py-10 text-center">
        <Icon className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{title}</p>
        {description ? <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p> : null}
        {action ? <div className="flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

/** Placeholder rows while a table loads. */
export function RowsSkeleton({ rows = 5, label }: Readonly<{ rows?: number; label?: string }>) {
  const { t } = useI18n();
  return (
    <div className="space-y-2" role="status" aria-label={label ?? t.weldbooksUs.salesTax.center.common.loading}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** Placeholder cards while a summary loads. */
export function CardsSkeleton({ count = 3 }: Readonly<{ count?: number }>) {
  const { t } = useI18n();
  return (
    <div
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      role="status"
      aria-label={t.weldbooksUs.salesTax.center.common.loading}
    >
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}
