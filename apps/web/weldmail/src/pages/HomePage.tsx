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
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-primary" />
        <span className="text-sm">Setting up your inbox…</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex h-full flex-col items-start gap-4 p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
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
