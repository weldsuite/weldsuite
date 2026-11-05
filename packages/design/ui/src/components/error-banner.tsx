'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ErrorBannerProps {
  /** The message. Nothing renders while it is `null` or empty. */
  error: string | null | undefined;
  /** Shows a close button. */
  onDismiss?: () => void;
  /** Accessible name of the close button. Defaults to the `dismiss` label of `UiLabelsProvider`. */
  dismissLabel?: string;
  className?: string;
}

/** A failed action, shown above a form or in a dialog: red box, warning icon, optional close. */
export function ErrorBanner({ error, onDismiss, dismissLabel, className }: Readonly<ErrorBannerProps>) {
  const labels = useUiLabels();
  if (!error) return null;
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {/* `overflow-wrap:anywhere`: a long unbroken message must wrap, not push a dialog wider. */}
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{error}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel ?? labels.dismiss}
          className="shrink-0 rounded-sm opacity-80 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export interface ErrorStateProps {
  /** Defaults to the `loadError` label of `UiLabelsProvider`. */
  message?: ReactNode;
  /** Shows a retry button. */
  onRetry?: () => void;
  /** Defaults to the `retry` label of `UiLabelsProvider`. */
  retryLabel?: string;
  className?: string;
}

/** A section that failed to load, with an optional retry. */
export function ErrorState({ message, onRetry, retryLabel, className }: Readonly<ErrorStateProps>) {
  const labels = useUiLabels();
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-8 text-center',
        className,
      )}
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="text-sm text-destructive">{message ?? labels.loadError}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel ?? labels.retry}
        </Button>
      )}
    </div>
  );
}

/** A one-line error under a control. */
export function InlineError({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <p className={cn('text-sm text-destructive', className)}>{children}</p>;
}
