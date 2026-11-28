import * as React from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { VariantProps } from 'class-variance-authority';

import { Button, type buttonVariants } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';

export interface CopyButtonProps {
  /** The text written to the clipboard. */
  value: string;
  /** Names what is copied ("Copy CNAME value"): several bare "Copy" buttons are indistinguishable to screen readers. */
  label: string;
  /** Shows `label` as the button's text next to the icon ("Copy link") instead of an icon-only button. */
  showLabel?: boolean;
  /** Feedback shown and announced after a successful copy. */
  copiedLabel: string;
  /** Feedback shown and announced when the clipboard is unavailable or denied. */
  failedLabel: string;
  /** Defaults to `ghost` for an icon-only button and `outline` with `showLabel`. */
  variant?: VariantProps<typeof buttonVariants>['variant'];
  /** Defaults to `icon-xs` for an icon-only button and `sm` with `showLabel`. */
  size?: VariantProps<typeof buttonVariants>['size'];
  className?: string;
  /** Feedback stays this long, in milliseconds. */
  feedbackMs?: number;
}

type CopyState = 'idle' | 'copied' | 'failed';

const ICONS: Record<CopyState, typeof Copy> = { idle: Copy, copied: Check, failed: X };

/** The legacy path for a page the browser does not give the async clipboard (an insecure context). */
function legacyCopy(text: string): boolean {
  const previous = document.activeElement as HTMLElement | null;
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    previous?.focus({ preventScroll: true });
  }
}

/**
 * A button that copies `value` with the Async Clipboard API (falling back to
 * the legacy copy command where the browser does not offer it). The
 * confirmation bubble is a sibling `<output>` (role status, a live region; a button's
 * children are presentational, so a region inside it is not reliably
 * announced). It shows both outcomes, fades with opacity so it stays in the
 * accessibility tree, and the button is never disabled while feedback shows.
 * It holds no translations.
 */
export function CopyButton({
  value,
  label,
  showLabel = false,
  copiedLabel,
  failedLabel,
  variant,
  size,
  className,
  feedbackMs = 2000,
}: Readonly<CopyButtonProps>) {
  const [state, setState] = React.useState<CopyState>('idle');
  const [message, setMessage] = React.useState('');
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastMessage = React.useRef('');

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const report = (next: Exclude<CopyState, 'idle'>) => {
    clearTimeout(timer.current);
    let text = next === 'copied' ? copiedLabel : failedLabel;
    // VoiceOver skips a message identical to the previous one; a no-break space makes it differ.
    if (text === lastMessage.current) text += ' ';
    lastMessage.current = text;
    setState(next);
    setMessage(text);
    timer.current = setTimeout(() => {
      setState('idle');
      setMessage('');
    }, feedbackMs);
  };

  const copy = async () => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else if (!legacyCopy(value)) throw new Error('copy failed');
      report('copied');
    } catch {
      try {
        report(legacyCopy(value) ? 'copied' : 'failed');
      } catch {
        report('failed');
      }
    }
  };

  const Icon = ICONS[state];

  return (
    <span className={cn('relative inline-flex', className)}>
      <Button
        type="button"
        variant={variant ?? (showLabel ? 'outline' : 'ghost')}
        size={size ?? (showLabel ? 'sm' : 'icon-xs')}
        className="min-h-6 min-w-6"
        aria-label={showLabel ? undefined : label}
        onClick={() => void copy()}
      >
        <Icon aria-hidden="true" />
        {showLabel ? label : null}
      </Button>
      <output
        className={cn(
          'pointer-events-none absolute end-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md transition-opacity motion-reduce:transition-none',
          state === 'failed' && 'text-destructive',
          state === 'idle' ? 'opacity-0' : 'opacity-100',
        )}
      >
        {message}
      </output>
    </span>
  );
}
