/** A copy-to-clipboard icon button whose value can be fetched on demand. */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';

export function CopyButton({
  resolve,
  label,
  onError,
}: Readonly<{
  /**
   * The text to copy. May be async: copying a password reveals it first, and
   * that request only happens when the user presses the button.
   */
  resolve: () => string | Promise<string>;
  label: string;
  onError?: (err: unknown) => void;
}>) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    setState('busy');
    try {
      await navigator.clipboard.writeText(await resolve());
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), 1500);
    } catch (err) {
      setState('idle');
      onError?.(err);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={state === 'busy'}
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      {state === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
      {state === 'copied' && <Check className="h-4 w-4 text-emerald-500" />}
      {state === 'idle' && <Copy className="h-4 w-4" />}
    </Button>
  );
}
