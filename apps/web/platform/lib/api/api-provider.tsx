import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setWeldbooksTokenGetter } from './weldbooks-client';
import { setAppApiTokenGetter } from './app-api-browser-client';
import { setProjectsApiTokenProvider } from '@/app/weldflow/lib/api-client';

/**
 * Wires the module-level API client singletons to Clerk's `getToken`.
 *
 * The platform is a Vite SPA, so the server-side `getAccessToken()` returns null
 * in a browser context — each singleton needs the token pushed in from a React
 * context instead. This component supplies no context of its own; it exists
 * purely for that wiring.
 *
 * (It previously also vended a `useApiClient()` hook over two api-worker
 * clients. Those are gone with the worker.)
 */
export function ApiClientProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();

  // Without the `appApi` line every domain client falls back to polling
  // `window.Clerk`. That fallback is correct for route loaders that fire before
  // this provider mounts, but it should not be the steady-state path once
  // Clerk's own cached `getToken` is available here.
  useEffect(() => {
    setWeldbooksTokenGetter(() => getToken());
    setAppApiTokenGetter(() => getToken());
    return () => {
      setWeldbooksTokenGetter(null);
      setAppApiTokenGetter(null);
    };
  }, [getToken]);

  // The WeldFlow api-client otherwise reads `window.Clerk.session.getToken()`,
  // which races the Clerk bootstrap and can briefly return null on first paint,
  // blanking the project sidebar and project-name header on a fresh load.
  useEffect(() => {
    setProjectsApiTokenProvider(() => getToken());
  }, [getToken]);

  return <>{children}</>;
}
