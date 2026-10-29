import { log, flush, sendToLogtail } from '@/lib/logger';
import { isStaleChunkError, reloadForStaleChunk } from '@/lib/chunk-reload';
import { startApp } from '@boot';

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

// Boot: `@boot` is src/boot/global.tsx or src/boot/runtime.tsx, picked at build
// time by VITE_RUNTIME_CONFIG (src/boot/mode.ts, vite.config.ts). Global renders
// straight away; the Kubernetes builds read /config.json first.
void startApp();
