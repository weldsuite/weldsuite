/**
 * `@weldsuite/mobile-platform/api`: the app-api client every mobile app
 * builds its domain clients on, pointed at the booted server. Every path goes
 * to the server's API origin (`MobileRuntime.apiOrigin`): one backend serves
 * all modules.
 *
 * The origin is read on each request, never at import time: modules load
 * before the runtime boots.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { getMobileRuntime } from '../runtime/state';

/** `workspaces.id`, named in `X-Weld-Workspace` in OIDC header mode. */
export const WORKSPACE_HEADER = 'X-Weld-Workspace';

/**
 * `{ X-Weld-Workspace }` for the active workspace, only in OIDC header mode
 * (WeldID in membership mode, plan `weldid-auth-server.md`): the access token
 * names no workspace there, so every request names it instead. `{}` on Clerk,
 * on claim-mode OIDC (the token already names the org) and before a workspace
 * is active. Mirrors the platform's `lib/api/workspace-header.ts`.
 *
 * The auth facade (`../auth`) is imported lazily, and only once this gate
 * passes: it pulls in Clerk and the Expo secure-store/crypto/browser modules,
 * which a plain unit test of a service built on this client never mocks (this
 * module itself stays free of them, like before).
 */
export async function workspaceHeaders(): Promise<Record<string, string>> {
  const { auth } = getMobileRuntime();
  if (auth.provider !== 'oidc' || auth.workspaceSource !== 'header') return {};
  const { getActiveWorkspaceId } = await import('../auth');
  const workspaceId = getActiveWorkspaceId();
  return workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {};
}

export interface MobileApiClientOptions {
  /** Sent as `X-Weld-App`: which app's permissions apply (per-app permission model). */
  appCode: string;
  /** The bearer token; null sends no Authorization header. */
  getToken: () => Promise<string | null>;
  /** Further headers per request (WeldBooks' `X-Accounting-Entity-Id`). */
  getExtraHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}

/** The API origin, which serves every path (`/api/...`, `/public/...`). */
export function apiOrigin(): string {
  return getMobileRuntime().apiOrigin;
}

/** personal-api's base URL (consumer WeldMail and WeldCalendar). */
export function personalApiOrigin(): string {
  return getMobileRuntime().personalApiOrigin;
}

/** The realtime base URL (append `/ws`). */
export function realtimeUrl(): string {
  return getMobileRuntime().realtimeUrl;
}

/** The web app, for links that open it. */
export function platformUrl(): string {
  return getMobileRuntime().platformUrl;
}

export function createMobileApiClient(options: MobileApiClientOptions) {
  const headers = async (): Promise<Record<string, string>> => ({
    ...(await options.getExtraHeaders?.()),
    'X-Weld-App': options.appCode,
    ...(await workspaceHeaders()),
  });
  const client = createClientApi({
    baseUrl: () => apiOrigin(),
    getToken: () => options.getToken(),
    getExtraHeaders: headers,
  });

  /**
   * Absolute URL + auth headers for a binary (non-JSON) endpoint, such as an
   * attachment download. `path` is relative to `/api`, like `client.get`.
   * Throws `Authentication required` without a session, like the client.
   */
  async function requestInit(path: string): Promise<{ url: string; headers: Record<string, string> }> {
    const token = await options.getToken();
    if (!token) throw new Error('Authentication required');
    const fullPath = `/api${path}`;
    return {
      url: `${apiOrigin()}${fullPath}`,
      headers: { Authorization: `Bearer ${token}`, ...(await headers()) },
    };
  }

  return { client, requestInit };
}

/**
 * A client whose base URL comes from the runtime: built on first use (never at
 * import time, before the runtime boots) and rebuilt if `origin()` changes.
 * For clients that only take a fixed base URL, such as personal-api's.
 */
export function lazyClient<T extends object>(origin: () => string, build: (origin: string) => T): T {
  let instance: T | null = null;
  let builtFor = '';
  const current = (): T => {
    const next = origin();
    if (!instance || next !== builtFor) {
      instance = build(next);
      builtFor = next;
    }
    return instance;
  };
  return new Proxy({} as T, {
    get(_target, prop) {
      const client = current();
      const value: unknown = Reflect.get(client, prop, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}
