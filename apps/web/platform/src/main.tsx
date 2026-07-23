import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { ClerkProvider } from '@clerk/clerk-react';
import { routeTree } from './routeTree.gen';
import { log, flush, sendToLogtail } from '@/lib/logger';
import { track } from '@/lib/analytics';
import { MixpanelIdentifier } from '@/providers/mixpanel-provider';
import { queryClient } from '@/lib/query-client';
import { isStaleChunkError, reloadForStaleChunk } from '@/lib/chunk-reload';
import { RoutePendingSkeleton } from '@/components/route-pending-skeleton';
import '../app/globals.css';

const router = createRouter({
  routeTree,
  context: { queryClient },
  // Prefetch a route's matches as soon as the user shows intent (hover/touch on
  // a Link) so navigation feels instant instead of starting cold on click.
  defaultPreload: 'intent',
  // Let TanStack Query own data caching — treat preloaded route data as always
  // stale so it isn't double-cached by the router. (Recommended pairing with
  // React Query.)
  defaultPreloadStaleTime: 0,
  // Routes are code-split (autoCodeSplitting), so a cold navigation has to fetch
  // the route's JS chunk. The router's default is to stay frozen on the OLD page
  // for up to 1000ms (defaultPendingMs) before showing anything — that's the
  // "wait a second, then jump" feel. Commit to the new route almost immediately
  // and show a page-shaped skeleton instead, so navigation reads as instant and
  // the data streams in behind it (the SSR feel, without an SSR runtime).
  defaultPendingMs: 100,
  // Once the skeleton shows, keep it up briefly so a near-instant load doesn't
  // flash it on and off.
  defaultPendingMinMs: 200,
  defaultPendingComponent: RoutePendingSkeleton,
  // NOTE: View Transitions (`defaultViewTransition`) deliberately left OFF — the
  // browser's default cross-fade adds a ~250ms opacity animation to every
  // navigation, which reads as "fade in" rather than instant. Content should
  // just appear.
});

// Track page views on navigation
router.subscribe('onResolved', ({ toLocation }) => {
  track('Page View', {
    path: toLocation.pathname,
    url: toLocation.href,
    referrer: document.referrer,
    title: document.title,
  });
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function App() {
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      afterSignInUrl="/"
      afterSignUpUrl="/onboarding"
      signInForceRedirectUrl="/"
      signUpForceRedirectUrl="/onboarding"
    >
      <MixpanelIdentifier />
      <RouterProvider router={router} />
    </ClerkProvider>
  );
}

// Intercept all console.error calls and forward to BetterStack.
// This captures errors from the 222+ files that call console.error directly.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  originalConsoleError.apply(console, args);

  const message = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
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
    flush();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
