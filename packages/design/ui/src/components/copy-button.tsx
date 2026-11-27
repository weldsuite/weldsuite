import * as React from 'react';
import { Check, Copy, X } from 'lucide-react';

import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';

export interface CopyButtonProps {
  /** The text written to the clipboard. */
  value: string;
  /** Names what is copied ("Copy CNAME value"): several bare "Copy" buttons are indistinguishable to screen readers. */
  label: string;
  /** Feedback shown and announced after a successful copy. */
  copiedLabel: string;
  /** Feedback shown and announced when the clipboard is unavailable or denied. */
  failedLabel: string;
  className?: string;
  /** Feedback stays this long, in milliseconds. */
  feedbackMs?: number;
}

type CopyState = 'idle' | 'copied' | 'failed';

const ICONS: Record<CopyState, typeof Copy> = { idle: Copy, copied: Check, failed: X };

/**
 * An icon button that copies `value` with the Async Clipboard API. The
 * confirmation bubble is a sibling `<output>` (role status, a live region; a button's
 * children are presentational, so a region inside it is not reliably
 * announced). It shows both outcomes, fades with opacity so it stays in the
 * accessibility tree, and the button is never disabled while feedback shows.
 */
export function CopyButton({ value, label, copiedLabel, failedLabel, className, feedbackMs = 2000 }: Readonly<CopyButtonProps>) {
  const [state, setState] = React.useState<CopyState>('idle');
  const [message, setMessage] = React.useState('');
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastMessage = React.useRef('');

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const report = (next: Exclude<CopyState, 'idle'>) => {
    clearTimeout(timer.current);
    let text = next === 'copied' ? copiedLabel : failedLabel;
    // VoiceOver skips a message identical to the previous one; a no-break space makes it differ.
    if (text === lastMessage.current) text += ' ';
    lastMessage.current = text;
    setState(next);
    setMessage(text);
    timer.current = setTimeout(() => {
      setState('idle');
      setMessage('');
    }, feedbackMs);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      report('copied');
    } catch {
      report('failed');
    }
  };

  const Icon = ICONS[state];

  return (
    <span className={cn('relative inline-flex', className)}>
      <Button type="button" variant="ghost" size="icon-xs" className="min-h-6 min-w-6" aria-label={label} onClick={() => void copy()}>
        <Icon aria-hidden="true" />
      </Button>
      <output
        className={cn(
          'pointer-events-none absolute end-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md transition-opacity motion-reduce:transition-none',
          state === 'idle' ? 'opacity-0' : 'opacity-100',
        )}
      >
        {message}
      </output>
    </span>
  );
}
