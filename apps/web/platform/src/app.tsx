/**
 * The application, imported by `main.tsx` once the runtime config is loaded.
 * Everything below reads its settings at module load (API origins, realtime
 * URL, publishable keys), so it must not be imported before
 * `loadRuntimeConfig()` has settled: `main.tsx` imports this file dynamically.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { track } from '@/lib/analytics';
import { AuthProvider } from '@/lib/auth';
import { MixpanelIdentifier } from '@/providers/mixpanel-provider';
import { queryClient } from '@/lib/query-client';
import { RoutePendingSkeleton } from '@/components/route-pending-skeleton';
import { installAppContextHeader } from '@/lib/api/app-context-header';
import { workspaceUrlRewrite } from '@/lib/workspace-url-rewrite';
import '../app/globals.css';

// Before any request fires: tag app-api calls with the current module so the
// server evaluates app-scoped permissions for the screen that made them.
installAppContextHeader();

const router = createRouter({
  routeTree,
  context: { queryClient },
  // The workspace in the address bar (FE-013): `/w/{slug}/…` in the browser,
  // bare paths inside the router.
  rewrite: workspaceUrlRewrite,
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

function App() {
  return (
    <AuthProvider>
      <MixpanelIdentifier />
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

export function renderApp(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
