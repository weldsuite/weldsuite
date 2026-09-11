import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { personalApi } from '@/lib/api';

export function HomePage() {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        let me = (await personalApi.me()).data;
        if (!me.account) {
          await personalApi.onboard();
          me = (await personalApi.me()).data;
        }
        await personalApi.calendars.ensureDefault();
        if (cancelled) return;
        setState('ready');
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
        <span className="text-sm">Setting up your calendar…</span>
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

  return <Navigate to="/calendar" replace />;
}
