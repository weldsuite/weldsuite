'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { Button, type buttonVariants } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import type { VariantProps } from 'class-variance-authority';

export interface CopyButtonProps {
  /** The text that goes on the clipboard. */
  value: string;
  /** Visible text of the button, e.g. "Copy link". Left out, the button is icon-only and `ariaLabel` names it. */
  label?: string;
  /** Names an icon-only button for assistive technology, e.g. "Copy the payment link". */
  ariaLabel?: string;
  /** Said and shown after a copy, e.g. "Copied". */
  copiedLabel: string;
  /** Said and shown when the clipboard refused, e.g. "Copy failed". */
  failedLabel: string;
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  className?: string;
  /** How long the confirmation stays, in milliseconds. */
  feedbackMs?: number;
}

type CopyState = 'idle' | 'copied' | 'failed';

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
 * Copies a text to the clipboard and says so. The confirmation is a
 * `role="status"` bubble next to the button (not inside it, so a screen reader
 * announces it) and is shown for both outcomes, in words and with an icon. The
 * button is never disabled while it shows: copying again is harmless, and a
 * disabled button would drop keyboard focus. It holds no translations.
 */
export function CopyButton({
  value,
  label,
  ariaLabel,
  copiedLabel,
  failedLabel,
  variant = 'outline',
  size = 'sm',
  className,
  feedbackMs = 2000,
}: Readonly<CopyButtonProps>) {
  const [state, setState] = useState<CopyState>('idle');
  const [announced, setAnnounced] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastMessage = useRef('');

  useEffect(() => () => clearTimeout(timer.current), []);

  const report = useCallback(
    (ok: boolean) => {
      clearTimeout(timer.current);
      setState(ok ? 'copied' : 'failed');
      let message = ok ? copiedLabel : failedLabel;
      // A screen reader skips a message identical to the one before: a no-break space makes it differ.
      if (message === lastMessage.current) message += ' ';
      lastMessage.current = message;
      setAnnounced(message);
      timer.current = setTimeout(() => {
        setState('idle');
        setAnnounced('');
      }, feedbackMs);
    },
    [copiedLabel, failedLabel, feedbackMs],
  );

  const copy = async () => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else if (!legacyCopy(value)) throw new Error('copy failed');
      report(true);
    } catch {
      try {
        report(legacyCopy(value));
      } catch {
        report(false);
      }
    }
  };

  const Icon = state === 'copied' ? Check : state === 'failed' ? TriangleAlert : Copy;
  return (
    <span className={cn('relative inline-flex items-center gap-2', className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        aria-label={label ? undefined : ariaLabel}
        data-copied={state === 'copied' ? '' : undefined}
        data-failed={state === 'failed' ? '' : undefined}
        className="min-h-6 min-w-6"
        onClick={() => void copy()}
      >
        <Icon aria-hidden="true" />
        {label}
      </Button>
      <span
        role="status"
        className={cn(
          'text-xs transition-opacity motion-reduce:transition-none',
          state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          state === 'idle' ? 'opacity-0' : 'opacity-100',
        )}
      >
        {announced}
      </span>
    </span>
  );
}
