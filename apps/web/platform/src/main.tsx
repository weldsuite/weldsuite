import { getLocale } from '@weldsuite/i18n';
import { loadLocale } from '@weldsuite/i18n/locales';
import { log, flush, sendToLogtail } from '@/lib/logger';
import { isStaleChunkError, reloadForStaleChunk } from '@/lib/chunk-reload';
import { loadRuntimeConfig, type RuntimeConfig } from '@/lib/runtime-config';
import { setAuthImplementation } from '@/lib/auth';

// Intercept all console.error calls and forward to BetterStack.
// This captures errors from the 222+ files that call console.error directly.
const originalConsoleError = console.error;
const consoleArgText = (a: unknown): string => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  return JSON.stringify(a);
};
console.error = (...args: unknown[]) => {
  originalConsoleError.apply(console, args);

  const message = args.map((a) => consoleArgText(a)).join(' ');
  sendToLogtail(message);
};

// Vite fires `vite:preloadError` when a dynamically imported chunk fails to
// load — almost always a stale tab requesting a hash that a redeploy removed.
// Reload once to boot the latest build instead of surfacing a broken page.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  if (!reloadForStaleChunk()) {
    log.error('Stale chunk preload failed after reload — new build may be broken');
  }
});

// Global error handlers. A stale dynamic-import failure can surface here when it
// escapes both the `vite:preloadError` event and the router error boundary —
// e.g. a lazy `import()` rejected inside an event handler or a prefetch. Recover
// by reloading once (loop-guarded) instead of logging a dead end.
window.addEventListener('error', (event) => {
  if (isStaleChunkError(event.error) && reloadForStaleChunk()) return;
  log.error('Uncaught exception', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error instanceof Error ? event.error.stack : String(event.error),
  });
});

window.addEventListener('unhandledrejection', (event) => {
  if (isStaleChunkError(event.reason) && reloadForStaleChunk()) return;
  log.error('Unhandled promise rejection', {
    reason: event.reason instanceof Error ? event.reason.stack : String(event.reason),
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Best effort: the page may be going away, nothing to do if it fails.
    flush().catch(() => {});
  }
});

/**
 * Pick the identity provider from the runtime config (SEC-012). Clerk is the
 * default; the OIDC client is a separate chunk only the Kubernetes editions
 * download.
 */
async function selectIdentityProvider(config: RuntimeConfig | null): Promise<void> {
  const auth = config?.auth;
  if (auth?.provider !== 'oidc') return;
  const { clientId } = auth;
  if (!clientId) {
    log.error('/config.json names an OIDC provider without a clientId (OIDC_WEB_CLIENT_ID); nobody can sign in');
    return;
  }
  const { createOidcAuth } = await import('@/lib/auth/oidc');
  setAuthImplementation(createOidcAuth({ ...auth, clientId }));
}

// Before the first render:
// - the runtime config (`/config.json`, lib/runtime-config.ts). The app reads
//   API origins and keys at module load, so `./app` is imported only once it
//   has settled. Global serves none and falls back to its `VITE_*` values.
// - the stored locale's bundle. Non-English bundles are lazy chunks and many
//   screens read translations synchronously (`getTranslations()`), which never
//   re-renders when a bundle lands later: a Dutch user would keep seeing the
//   English fallback on those screens until something else re-rendered them.
//   A failed load falls back to English.
void Promise.all([
  loadRuntimeConfig().then(selectIdentityProvider),
  loadLocale(getLocale()).catch(() => undefined),
])
  .then(() => import('./app'))
  .then(({ renderApp }) => renderApp());
