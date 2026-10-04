/**
 * The current 2FA code for a login, fetched only when asked for.
 *
 * Every fetch is written to the vault's trail, so there is no polling and no
 * auto-refresh: the code is shown with a countdown, then hidden, and the user
 * asks again if they still need one.
 */

import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { WeldPassTotpCode } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useWeldPassTotp } from '@/hooks/queries/use-weldpass-passwords-queries';
import { errorMessage } from '../../components/shared';
import { formatTotpCode, secondsUntil } from '../lib/items';
import { usePasswordsT } from '../lib/use-passwords-t';
import { CopyButton } from './copy-button';

export function TotpCode({
  vaultId,
  itemId,
}: Readonly<{ vaultId: string; itemId: string }>) {
  const tp = usePasswordsT();
  const totp = useWeldPassTotp();
  const [code, setCode] = useState<WeldPassTotpCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failure, setFailure] = useState<string | null>(null);

  const secondsLeft = code ? secondsUntil(code.expiresAt, now) : 0;
  const visible = code !== null && secondsLeft > 0;
  const expired = code !== null && secondsLeft === 0;

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [visible]);

  async function show() {
    setFailure(null);
    try {
      const result = await totp.mutateAsync({ vaultId, itemId });
      setNow(Date.now());
      setCode(result);
    } catch (err) {
      setCode(null);
      setFailure(errorMessage(err, tp('detail.totpFailed')));
    }
  }

  if (visible && code) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-base font-semibold tracking-widest"
          aria-live="polite"
        >
          {formatTotpCode(code.code)}
        </span>
        <span className="text-xs text-muted-foreground">
          {tp('detail.totpExpires', { seconds: secondsLeft })}
        </span>
        <div
          className="h-1 w-16 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={code.period}
          aria-valuenow={secondsLeft}
        >
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.min(100, (secondsLeft / code.period) * 100)}%` }}
          />
        </div>
        <CopyButton resolve={() => code.code} label={tp('detail.copyCode')} />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={totp.isPending}
        onClick={() => void show()}
      >
        {totp.isPending ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="mr-1.5 h-4 w-4" />
        )}
        {tp('detail.showCode')}
      </Button>
      {expired && (
        <span className="text-xs text-muted-foreground">{tp('detail.totpExpired')}</span>
      )}
      {failure && <span className="text-xs text-destructive">{failure}</span>}
    </div>
  );
}
