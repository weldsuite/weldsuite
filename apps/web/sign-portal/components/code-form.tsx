import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import type { SignPortalSessionResponse } from '@weldsuite/app-api-client/schemas/weldsign';
import { PortalApiError, PortalNetworkError, portalJson } from '@/lib/portal-client';
import { BrandButton } from './brand-button';
import { usePortal } from './portal-context';
import { StatusCard } from './status-card';

interface CodeFormProps {
  token: string;
  method: 'email_code' | 'access_code';
  emailHint: string | null;
  /** The answer to a successful check (ready, or closed in the meantime). */
  onAnswer: (answer: SignPortalSessionResponse) => void;
}

/** Asks for the emailed code or the access code the sender shared. */
export function CodeForm({ token, method, emailHint, onAnswer }: Readonly<CodeFormProps>) {
  const { t } = usePortal();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const isEmail = method === 'email_code';

  function describe(err: unknown, fallback: string): string {
    if (err instanceof PortalNetworkError) return t.error.network;
    if (err instanceof PortalApiError) {
      if (err.code === 'INVALID_CODE') {
        const left = err.details?.attemptsLeft;
        return t.code.wrongCode(typeof left === 'number' ? left : null);
      }
    }
    return fallback;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (!value || busy || locked) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const answer = await portalJson<SignPortalSessionResponse>('/api/verify', { token, code: value });
      onAnswer(answer);
    } catch (err) {
      if (err instanceof PortalApiError && (err.code === 'LOCKED' || err.status === 429)) {
        setLocked(true);
        setError(t.code.locked);
      } else {
        setError(describe(err, t.error.generic));
      }
      setBusy(false);
    }
  }

  async function resend() {
    if (resending || locked) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      await portalJson<{ sent: boolean }>('/api/resend-code', { token });
      setNotice(t.code.resent);
    } catch (err) {
      setError(err instanceof PortalApiError && err.status === 429 ? t.code.tooManyResends : describe(err, t.error.generic));
    } finally {
      setResending(false);
    }
  }

  return (
    <StatusCard
      icon={KeyRound}
      title={isEmail ? t.code.emailTitle : t.code.accessTitle}
      body={isEmail ? t.code.emailBody(emailHint) : t.code.accessBody}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 text-left">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sign-code">{t.code.label}</Label>
          <Input
            id="sign-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            autoComplete="one-time-code"
            inputMode={isEmail ? 'numeric' : 'text'}
            maxLength={64}
            disabled={locked}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'sign-code-error' : undefined}
            className="h-11 text-base tracking-widest"
          />
        </div>
        {error ? (
          <p id="sign-code-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-emerald-700">
            {notice}
          </p>
        ) : null}
        <BrandButton type="submit" size="lg" disabled={busy || locked || !code.trim()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {busy ? t.code.verifying : t.code.submit}
        </BrandButton>
        {isEmail ? (
          <Button type="button" variant="ghost" onClick={resend} disabled={resending || locked}>
            {t.code.resend}
          </Button>
        ) : null}
      </form>
    </StatusCard>
  );
}
