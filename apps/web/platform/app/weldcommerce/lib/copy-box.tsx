/**
 * A read-only value with a copy button, shared by the dialogs that show a
 * secret or a link once (the storefront key, a payment link).
 *
 * The button follows the Modern Web Guidance copy-button guide: it names what
 * it copies, stays enabled while it confirms, swaps its icon and says "Copied"
 * or "Copy failed" in a status region next to it (not inside it). A
 * `@weldsuite/ui` copy field would replace this; until it exists, this is the
 * one copy in WeldCommerce.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { fill } from '@/app/weldcommerce/lib/text';

type CopyState = 'idle' | 'copied' | 'failed';

export interface CopyLabels {
  copy: string;
  /** `Copy {label}`: the button's accessible name. */
  copyLabel: string;
  copied: string;
  copyFailed: string;
}

/** Copies `text` and reports it; one place for the timer so repeated clicks restart it. */
export function useCopy(text: string, labels: Pick<CopyLabels, 'copied' | 'copyFailed'>) {
  const [state, setState] = useState<CopyState>('idle');
  // The status region says the same thing twice in a row on a second click: VoiceOver skips an identical message.
  const [repeat, setRepeat] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef<CopyState>('idle');

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    let next: CopyState = 'copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'failed';
    }
    const same = last.current === next;
    setRepeat((current) => (same ? !current : false));
    last.current = next;
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState('idle');
      last.current = 'idle';
    }, 2000);
  };

  const base = { idle: '', copied: labels.copied, failed: labels.copyFailed }[state];
  // A repeated message gets a no-break space so VoiceOver announces it again.
  return { state, message: repeat && base ? `${base}\u00A0` : base, copy };
}

export function CopyBox({
  value,
  label,
  labels,
  rows = 2,
  testId,
}: Readonly<{ value: string; label: string; labels: CopyLabels; rows?: number; testId?: string }>) {
  const { state, message, copy } = useCopy(value, labels);
  const Icon = state === 'copied' ? Check : Copy;

  return (
    <div className="flex items-stretch gap-2">
      {/* A read-only field: focusable and selectable, and it wraps instead of being cut off. */}
      <textarea
        readOnly
        rows={rows}
        value={value}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onFocus={(event) => event.currentTarget.select()}
        data-testid={testId}
        className="min-w-0 flex-1 resize-none break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <span className="relative flex">
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-6 min-w-6 gap-1.5 px-3 shadow-none"
          aria-label={fill(labels.copyLabel, { label })}
          onClick={() => void copy()}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          <span aria-hidden="true">{labels.copy}</span>
        </Button>
        {/* The live region sits next to the button, not in it, and stays in the DOM so its text change is announced. */}
        <span role="status" className="sr-only">
          {message}
        </span>
      </span>
      {state !== 'idle' && (
        <span aria-hidden="true" className={state === 'failed' ? 'self-center text-xs text-destructive' : 'self-center text-xs text-muted-foreground'}>
          {state === 'copied' ? labels.copied : labels.copyFailed}
        </span>
      )}
    </div>
  );
}
