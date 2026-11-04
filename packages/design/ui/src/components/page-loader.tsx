'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';

/**
 * A loader stays invisible for this long, so loads that resolve near-instantly
 * (warm query cache, preloaded data) never flash a spinner before content paints.
 */
const DEFAULT_APPEAR_DELAY_MS = 250;

/** `false` until `delayMs` has passed (immediately `true` for a delay of 0). */
function useAppearAfter(delayMs: number): boolean {
  const [visible, setVisible] = React.useState(delayMs <= 0);
  React.useEffect(() => {
    if (delayMs <= 0) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return visible;
}

export interface PageLoaderProps {
  /** Text next to the spinner. Defaults to the `loading` label of `UiLabelsProvider`. */
  label?: string;
  className?: string;
  /** Fill the viewport (route-level loads) or the content area (`false`). */
  fullScreen?: boolean;
  /** How long the loader stays invisible before it fades in. `0` shows it at once. */
  appearDelayMs?: number;
}

/** The loading state of a page or of a page's content area. */
export function PageLoader({
  label,
  className,
  fullScreen = true,
  appearDelayMs = DEFAULT_APPEAR_DELAY_MS,
}: Readonly<PageLoaderProps>) {
  const labels = useUiLabels();
  const visible = useAppearAfter(appearDelayMs);
  return (
    <div
      className={cn(
        'w-full flex items-center justify-center',
        fullScreen ? 'min-h-screen' : 'h-full min-h-[calc(100vh-8rem)] pb-[60px]',
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center gap-3 transition-opacity duration-200 ease-out',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{label ?? labels.loading}</p>
      </div>
    </div>
  );
}

export interface InlineSpinnerProps {
  className?: string;
  /** Screen-reader text. Defaults to the `loading` label of `UiLabelsProvider`. */
  label?: string;
}

/** A centred spinner for a section or card that is still loading (not a whole page). */
export function InlineSpinner({ className, label }: Readonly<InlineSpinnerProps>) {
  const labels = useUiLabels();
  return (
    <div
      role="status"
      className={cn('flex items-center justify-center py-10 text-sm text-muted-foreground', className)}
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label ?? labels.loading}</span>
    </div>
  );
}
