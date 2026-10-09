import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';

/** A revealed TIN or account number hides again after this long. */
export const REVEAL_SECONDS = 30;

interface RevealSecretProps {
  /** What is shown while hidden: `**-***1234`. */
  masked: string;
  /** False for people without `tax_ids:reveal`: only the masked value shows. */
  canReveal: boolean;
  /** Fetches the full value. One-shot: the result stays in this component's state and nowhere else. */
  reveal: () => Promise<string>;
  labels: {
    reveal: string;
    hide: string;
    /** Uses `{seconds}`. */
    hidesIn: string;
    failed: string;
    /** Accessible name of the value, e.g. "Taxpayer identification number". */
    valueLabel: string;
  };
  testId?: string;
}

/**
 * A masked sensitive value with a Reveal button. The full value is fetched on
 * the click (the server logs it), kept in state only, shown for 30 seconds and
 * dropped on hide or unmount. It never goes through the query cache.
 */
export function RevealSecret({ masked, canReveal, reveal, labels, testId }: Readonly<RevealSecretProps>) {
  const [value, setValue] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (value === null) return;
    if (secondsLeft <= 0) {
      setValue(null);
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [value, secondsLeft]);

  const hide = useCallback(() => {
    setValue(null);
    setSecondsLeft(0);
  }, []);

  const show = async () => {
    setPending(true);
    setFailed(false);
    try {
      const full = await reveal();
      if (!mounted.current) return;
      setValue(full);
      setSecondsLeft(REVEAL_SECONDS);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm" data-testid={testId} aria-label={labels.valueLabel}>
        {value ?? masked}
      </span>
      {canReveal ? (
        value === null ? (
          <Button type="button" variant="ghost" size="sm" onClick={show} disabled={pending}>
            {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Eye className="mr-1 h-4 w-4" aria-hidden />}
            {labels.reveal}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={hide}>
              <EyeOff className="mr-1 h-4 w-4" aria-hidden />
              {labels.hide}
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {labels.hidesIn.replace('{seconds}', String(secondsLeft))}
            </span>
          </>
        )
      ) : null}
      {failed ? (
        <span className="text-xs text-destructive" role="alert">
          {labels.failed}
        </span>
      ) : null}
    </div>
  );
}
