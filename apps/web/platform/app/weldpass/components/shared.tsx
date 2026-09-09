/** Small pieces shared across the WeldPass pages. */

import type { ReactNode } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import type { WeldPassAutoSyncOutcome } from '@weldsuite/app-api-client/domains/weldpass';

export function ErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1 break-words">{error}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function InlineSpinner() {
  return (
    <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function statusTone(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'partial' || status === 'running') return 'outline';
  return 'secondary';
}

/** Relative time, with the absolute value on hover. */
export function TimeAgo({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;

  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let amount = seconds;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [candidate, size] of units) {
    unit = candidate;
    if (Math.abs(amount) < size) break;
    amount = Math.round(amount / size);
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return (
    <span title={date.toLocaleString()} className="text-muted-foreground">
      {formatter.format(-amount, unit)}
    </span>
  );
}

/** Shown after a write when auto-sync targets pushed as a side effect. */
export function AutoSyncSummary({
  outcomes,
  onDismiss,
}: {
  outcomes: WeldPassAutoSyncOutcome[];
  onDismiss: () => void;
}) {
  const t = useTranslations();
  if (outcomes.length === 0) return null;

  return (
    <Card className="space-y-1 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">{t('weldpass.secrets.autoSync.title')}</p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('weldpass.secrets.autoSync.dismiss')}
        </Button>
      </div>
      {outcomes.map((outcome) => (
        <p key={outcome.targetId} className="text-xs">
          <Badge variant={statusTone(outcome.status)}>{outcome.status}</Badge>
          <span className="ml-2">{outcome.name}</span>
          <span className="ml-2 text-muted-foreground">
            {outcome.error ?? t('weldpass.secrets.autoSync.pushed', { count: outcome.pushed })}
          </span>
        </p>
      ))}
    </Card>
  );
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
