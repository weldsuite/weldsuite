import { useEffect, useState } from 'react';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { DevErrorDetails } from '@/components/root-error-fallback';
import { useStaleChunkReloadState } from '@/hooks/use-hold-stale-chunk-reload';
import { isStaleChunkError, reloadForStaleChunk } from '@/lib/chunk-reload';
import { useI18n } from '@/lib/i18n/provider';
import { log } from '@/lib/logger';

/**
 * The router's default error component: a page that failed renders its error
 * inside the shell, so the sidebar, calls, meetings and other global overlays
 * stay up. (The root route's <RootErrorFallback/> replaces the whole app.)
 *
 * A page whose code was removed by a redeploy reloads into the new build, or,
 * while a call is live, says so and reloads once the call has ended.
 */
export function RouteErrorFallback({ error, info, reset }: Readonly<ErrorComponentProps>) {
  const { t } = useI18n();
  const router = useRouter();
  const stale = isStaleChunkError(error);
  const { held } = useStaleChunkReloadState();
  // The tab reloaded moments ago and the page is still missing: the new build
  // is broken, so show the error instead of waiting for a reload.
  const [brokenBuild, setBrokenBuild] = useState(false);

  useEffect(() => {
    if (stale) {
      if (reloadForStaleChunk() !== 'suppressed') return;
      setBrokenBuild(true);
    }
    log.error('Unhandled route error', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info?.componentStack,
    });
  }, [error, info, stale]);

  if (stale && !brokenBuild) {
    if (!held) {
      return (
        <div className="flex h-full min-h-[50vh] items-center justify-center p-6">
          <p className="text-muted-foreground">{t.common.rootError.updating}</p>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-[50vh] items-center justify-center p-6">
        <EmptyState
          icon={RefreshCw}
          title={t.common.appUpdate.title}
          description={t.common.appUpdate.pageAfterCall}
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button variant="outline" onClick={() => router.history.back()}>
                {t.common.actions.back}
              </Button>
              <Button onClick={() => window.location.reload()}>{t.common.appUpdate.reloadNow}</Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-2xl font-semibold">{t.common.rootError.title}</h1>
        <p className="mt-2 text-muted-foreground">{t.common.rootError.description}</p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button onClick={reset}>{t.common.rootError.tryAgain}</Button>
          <Button variant="outline" onClick={() => void router.navigate({ to: '/' })}>
            {t.common.rootError.goHome}
          </Button>
        </div>

        {import.meta.env.DEV && error instanceof Error && (
          <DevErrorDetails error={error} componentStack={info?.componentStack} />
        )}
      </div>
    </div>
  );
}
