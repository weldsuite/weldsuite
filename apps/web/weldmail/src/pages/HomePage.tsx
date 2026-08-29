import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { MeResponse } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';

/**
 * Bootstrap: me → onboard if needed → claim if no mail accounts → inbox.
 */
export function HomePage() {
  const [state, setState] = useState<'loading' | 'claim' | 'inbox' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        let me: MeResponse = (await personalApi.me()).data;
        if (!me.account) {
          await personalApi.onboard();
          me = (await personalApi.me()).data;
        }
        if (cancelled) return;
        if (!me.mailAccounts?.length) {
          setState('claim');
        } else {
          setState('inbox');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load account');
        setState('error');
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') {
    return (
      <div className="center-state">
        <div className="spinner" />
        <span>Setting up your inbox…</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="panel">
        <div className="status-banner error">{error}</div>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  if (state === 'claim') {
    return <Navigate to="/claim" replace />;
  }

  return <Navigate to="/inbox" replace />;
}
