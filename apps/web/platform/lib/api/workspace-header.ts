/**
 * Tag every WeldSuite API request with the active workspace (`X-Weld-Workspace`,
 * `workspaces.id`) when the deployment's identity provider keeps no workspace
 * claim: `auth.workspaceSource: "header"` in `/config.json` (WeldID in
 * membership mode, plan `weldid-auth-server.md`). The backend then reads the
 * header instead of an OIDC claim, and switching workspace needs no new
 * sign-in (`lib/auth/oidc/session.ts`).
 *
 * Installed only for that mode (`src/boot/runtime.tsx`'s `selectIdentityProvider`):
 * Clerk and `claim`-mode OIDC (Zitadel, the EU edition today) never install
 * it, and the backend keeps reading the org claim exactly as before. Like
 * `app-context-header.ts`, only requests to WeldSuite's own API origins carry
 * the header, never a third-party host, and a caller that already set it wins.
 */

import { getActiveWorkspaceId } from '@/lib/auth';
import { getApiOrigins } from '@/lib/api/public-env';
import { requestUrl } from './app-context-header';

export const WORKSPACE_HEADER = 'X-Weld-Workspace';

let installed = false;

export function installWorkspaceHeader(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const apiOrigins = getApiOrigins();
  const isApiRequest = (url: string) => apiOrigins.some((o) => url === o || url.startsWith(`${o}/`));
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isApiRequest(requestUrl(input))) return originalFetch(input, init);

    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return originalFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has(WORKSPACE_HEADER)) return originalFetch(input, init);
    headers.set(WORKSPACE_HEADER, workspaceId);
    return originalFetch(input, { ...init, headers });
  };
}
