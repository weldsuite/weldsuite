import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useRevealAccountNumber } from '@/hooks/queries/use-weldbooks-banking-queries';
import { maskedAccountNumber } from './routing-number';

/** The full account number hides again after this long. */
export const REVEAL_SECONDS = 30;

interface RevealAccountNumberProps {
  bankAccountId: string;
  last4: string | null | undefined;
}

/**
 * "•••• 1234" with a Reveal button for people who may see the full number
 * (`tax_ids:reveal`). Every reveal is logged by the server; the number sits in
 * component state only, hides after 30 seconds and is never cached.
 */
export function RevealAccountNumber({ bankAccountId, last4 }: Readonly<RevealAccountNumberProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.banking.accountDetails;
  const { can } = usePermissions();
  const reveal = useRevealAccountNumber();
  // The number and the moment it hides again. Hiding is decided by the clock, so a throttled background tab still hides it on time.
  const [revealed, setRevealed] = useState<{ accountNumber: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { reset } = reveal;

  useEffect(() => {
    if (revealed === null) return;
    const timer = setInterval(() => {
      const current = Date.now();
      if (current >= revealed.expiresAt) {
        setRevealed(null);
        reset();
      } else {
        setNow(current);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [revealed, reset]);

  const secondsLeft = revealed ? Math.max(0, Math.ceil((revealed.expiresAt - now) / 1000)) : 0;

  const hide = () => {
    setRevealed(null);
    reset();
  };

  const show = () => {
    reveal.mutate(
      { id: bankAccountId },
      {
        onSuccess: (res) => {
          const started = Date.now();
          setNow(started);
          setRevealed({ accountNumber: res.data.accountNumber, expiresAt: started + REVEAL_SECONDS * 1000 });
        },
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm" data-testid="account-number-value">
        {revealed?.accountNumber ?? maskedAccountNumber(last4)}
      </span>
      {can('tax_ids:reveal') ? (
        revealed === null ? (
          <Button type="button" variant="ghost" size="sm" onClick={show} disabled={reveal.isPending}>
            {reveal.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
            {tr.reveal}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={hide}>
              <EyeOff className="mr-1 h-4 w-4" />
              {tr.hide}
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {tr.hidesIn.replace('{seconds}', String(secondsLeft))}
            </span>
          </>
        )
      ) : null}
      {reveal.isError ? (
        <span className="text-xs text-destructive" role="alert">
          {(reveal.error as Error).message || tr.revealFailed}
        </span>
      ) : null}
    </div>
  );
}
