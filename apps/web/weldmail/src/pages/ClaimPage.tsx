import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { personalApi } from '@/lib/api';

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
      // Ensure personal account exists before reserve.
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
    <div className="panel">
      <h1>Claim your address</h1>
      <p className="lead">Pick a free @{domain} address — one per account for now.</p>

      {error && <div className="status-banner error">{error}</div>}
      {availability && (
        <div className={`status-banner ${availability.available ? 'ok' : 'warn'}`}>
          {checking ? 'Checking…' : availability.message}
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="address">Address</label>
          <div className="address-row">
            <input
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
              placeholder="you"
              autoComplete="off"
              autoFocus
              required
              minLength={3}
            />
            <span className="address-suffix">@{domain}</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="displayName">Display name (optional)</label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting || availability?.available !== true}
        >
          {submitting ? 'Claiming…' : 'Claim address'}
        </button>
      </form>
    </div>
  );
}
