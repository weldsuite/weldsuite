/**
 * Tag every app-api request with the module the user is in (`X-Weld-App`), so
 * the server evaluates app-scoped permissions (`weldcrm:companies:read`) for
 * the screen that made the call.
 *
 * The platform reaches app-api through many transports (the shared
 * `createClientApi`, the weldbooks / weldmail / weldflow clients, documents,
 * uploads, direct `fetch`). Wrapping `fetch` once covers all of them, and
 * every future one, instead of threading a header through each. Only requests
 * to the API origins (app-api and the module workers) are touched, and a
 * caller that sets the header itself (e.g. `workspace` for app-less shell
 * widgets) wins.
 */

import { APP_CONTEXT_HEADER } from '@weldsuite/permissions';
import { appFromPathname } from '@/lib/apps/current-app';
import { getApiOrigins } from '@/lib/api/public-env';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let installed = false;

export function installAppContextHeader(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // app-api plus every module worker the SPA calls directly (VITE_API_MODULES).
  const apiOrigins = getApiOrigins();
  const isApiRequest = (url: string) => apiOrigins.some((o) => url === o || url.startsWith(`${o}/`));
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isApiRequest(requestUrl(input))) return originalFetch(input, init);

    const app = appFromPathname(window.location.pathname);
    if (!app) return originalFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has(APP_CONTEXT_HEADER)) return originalFetch(input, init);
    headers.set(APP_CONTEXT_HEADER, app);
    return originalFetch(input, { ...init, headers });
  };
}
