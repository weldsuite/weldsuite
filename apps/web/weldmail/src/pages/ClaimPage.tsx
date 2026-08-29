import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { personalApi } from '@/lib/api';

const fieldClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40';
const labelClass = 'mb-1.5 block text-xs font-medium text-muted-foreground';

export function ClaimPage() {
  const navigate = useNavigate();
  const [domain, setDomain] = useState('weldmail.com');
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [availability, setAvailability] = useState<{
    available: boolean;
    message: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void personalApi.weldmail
      .domain()
      .then(({ data }) => {
        if (data.domain) setDomain(data.domain);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setAvailability(null);
    const local = address.trim().toLowerCase();
    if (local.length < 3) return;

    timerRef.current = setTimeout(() => {
      setChecking(true);
      void personalApi.weldmail
        .check(local)
        .then(({ data }) => {
          if (data.available) {
            setAvailability({ available: true, message: `${local}@${domain} is available` });
          } else {
            const reason = 'reason' in data ? data.reason : 'taken';
            setAvailability({
              available: false,
              message: reason === 'reserved' ? 'This address is reserved' : 'Already taken',
            });
          }
        })
        .catch((err) => {
          setAvailability({
            available: false,
            message: err instanceof Error ? err.message : 'Check failed',
          });
        })
        .finally(() => setChecking(false));
    }, 400);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [address, domain]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const local = address.trim().toLowerCase();
    if (!local || availability?.available !== true) return;

    setSubmitting(true);
    setError(null);
    try {
      const me = (await personalApi.me()).data;
      if (!me.account) {
        await personalApi.onboard({ displayName: displayName || undefined });
      }
      await personalApi.weldmail.reserve({
        address: local,
        displayName: displayName || undefined,
        name: local,
      });
      navigate('/inbox', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim address');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center border-b border-border px-4">
        <h1 className="text-sm font-semibold text-foreground">Claim your address</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <p className="mb-5 text-sm text-muted-foreground">
          Pick a free @{domain} address — one per account for now.
        </p>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {availability && (
          <div
            className={
              availability.available
                ? 'mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
                : 'mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
            }
          >
            {checking ? 'Checking…' : availability.message}
          </div>
        )}

        <form onSubmit={onSubmit} className="max-w-md space-y-4">
          <div>
            <label htmlFor="address" className={labelClass}>
              Address
            </label>
            <div className="flex items-center gap-2">
              <input
                id="address"
                value={address}
                onChange={(e) => setAddress(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
                placeholder="you"
                autoComplete="off"
                autoFocus
                required
                minLength={3}
                className={fieldClass}
              />
              <span className="shrink-0 text-sm text-muted-foreground">@{domain}</span>
            </div>
          </div>

          <div>
            <label htmlFor="displayName" className={labelClass}>
              Display name (optional)
            </label>
            <input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className={fieldClass}
            />
          </div>

          <button
            type="submit"
            disabled={submitting || availability?.available !== true}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Claiming…' : 'Claim address'}
          </button>
        </form>
      </div>
    </div>
  );
}
