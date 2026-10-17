import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { formatSsnInput, maskedSsn } from '@/lib/weldbooks/us-entity';

/** How long a revealed SSN stays on screen. */
export const SSN_REVEAL_SECONDS = 30;

interface SsnFieldProps {
  id: string;
  /** The entity whose stored SSN can be revealed; absent while creating one. */
  entityId?: string;
  hasSsn: boolean;
  last4: string | null;
  /** A new SSN typed into the field; empty keeps the stored one. */
  value: string;
  /** The stored SSN is removed when the form is saved. */
  clearSsn: boolean;
  onChange: (patch: { ssn?: string; clearSsn?: boolean }) => void;
  error?: string;
  disabled?: boolean;
  /** The member holds `tax_ids:reveal`. */
  canReveal: boolean;
}

/**
 * Write-only SSN input. A stored SSN shows as `•••-••-1234`; the full number
 * comes back only on an explicit Reveal (logged by the server), is held in
 * this component's state alone, and disappears after 30 seconds.
 */
export function SsnField({
  id,
  entityId,
  hasSsn,
  last4,
  value,
  clearSsn,
  onChange,
  error,
  disabled,
  canReveal,
}: Readonly<SsnFieldProps>) {
  const { t } = useI18n();
  const te = t.weldbooksUs.setup.entity;
  const [replacing, setReplacing] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [revealing, setRevealing] = useState(false);
  // A reveal answered after the user hid it, left the entity or unmounted is dropped.
  const requestId = useRef(0);

  const hide = useCallback(() => {
    requestId.current += 1;
    setRevealed(null);
    setSecondsLeft(0);
    setRevealing(false);
  }, []);

  useEffect(() => hide, [hide, entityId]);

  // One timer hides the number after 30 seconds whatever else happens; the other only updates the countdown.
  useEffect(() => {
    if (revealed === null) return;
    const expiresAt = Date.now() + SSN_REVEAL_SECONDS * 1000;
    const hideTimer = setTimeout(hide, SSN_REVEAL_SECONDS * 1000);
    const countdown = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => {
      clearTimeout(hideTimer);
      clearInterval(countdown);
    };
  }, [revealed, hide]);

  const reveal = async () => {
    if (!entityId) return;
    const mine = ++requestId.current;
    setRevealing(true);
    try {
      const res = await accountingApi.revealEntitySsn(entityId);
      if (mine !== requestId.current) return;
      setRevealed(res.data.ssn);
      setSecondsLeft(SSN_REVEAL_SECONDS);
    } catch (err) {
      if (mine === requestId.current) {
        toast.error(te.ssnRevealFailed, { description: err instanceof Error ? err.message : undefined });
      }
    } finally {
      if (mine === requestId.current) setRevealing(false);
    }
  };

  const showInput = !hasSsn || replacing;
  const describedBy = `${id}-help`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{te.ssn}</Label>

      {showInput ? (
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            placeholder={te.ssnPlaceholder}
            value={value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onChange({ ssn: formatSsnInput(e.target.value) })}
          />
          {hasSsn ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setReplacing(false);
                onChange({ ssn: '' });
              }}
            >
              {te.ssnCancelNew}
            </Button>
          ) : null}
        </div>
      ) : clearSsn ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{te.ssnWillBeRemoved}</span>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ clearSsn: false })}>
            {te.ssnKeep}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span
            id={id}
            className="inline-flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 font-mono text-sm"
            data-testid="ssn-display"
          >
            <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {revealed ?? maskedSsn(last4)}
          </span>
          {canReveal && entityId ? (
            revealed === null ? (
              <Button type="button" variant="outline" size="sm" disabled={revealing || disabled} onClick={() => void reveal()}>
                <Eye className="mr-1 h-4 w-4" aria-hidden />
                {revealing ? te.ssnRevealing : te.ssnReveal}
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={hide}>
                <EyeOff className="mr-1 h-4 w-4" aria-hidden />
                {te.ssnHide}
              </Button>
            )
          ) : null}
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setReplacing(true)}>
            {te.ssnReplace}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ clearSsn: true })}>
            {te.ssnRemove}
          </Button>
        </div>
      )}

      {revealed !== null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {te.ssnRevealedHint.replace('{seconds}', String(secondsLeft))}
        </p>
      ) : null}
      <p id={describedBy} className="text-xs text-muted-foreground">
        {hasSsn && !showInput ? te.ssnStored : te.ssnHelp}
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
