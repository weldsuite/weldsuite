/**
 * The extension's OIDC session: the same code as the mobile apps
 * (`@weldsuite/mobile-platform/oidc-session`), wired to the browser.
 *
 * It runs in the service worker, never in the popup: `launchWebAuthFlow`
 * opens a window, the popup loses focus and closes, and the PKCE verifier
 * would go with it. The redirect is `chrome.identity.getRedirectURL()`,
 * `https://<extension id>.chromiumapp.org/`, which WeldID's
 * `weldsuite-extension` client lists exactly.
 */

import { parseWorkspaceDirectory, type OidcOrganization } from '@weldsuite/app-api-client/auth/oidc-claims';
import {
  OidcMobileSession,
  storageIdFor,
  type AuthSessionResult,
  type OidcSessionDeps,
} from '@weldsuite/mobile-platform/oidc-session';
import type { ServerProfile } from '../lib/server';
import type { KeyValueStore } from './stores';
import type { SecureStoreLike } from '@weldsuite/mobile-platform/oidc-session';

export interface AuthPlatform {
  fetchImpl: typeof fetch;
  local: KeyValueStore;
  secure: SecureStoreLike;
  /** Memory only: the access token survives a worker restart, not a browser restart. */
  session: KeyValueStore;
  launchWebAuthFlow: (details: { url: string; interactive: boolean }) => Promise<string | undefined>;
  redirectUri: string;
}

/** `chrome.identity` reports a closed window with this message, not an error code. */
const CANCELLED = /did not approve|user cancel|canceled|cancelled/i;

export class AuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

export function openAuthSession(platform: Pick<AuthPlatform, 'launchWebAuthFlow'>) {
  return async (url: string): Promise<AuthSessionResult> => {
    try {
      const result = await platform.launchWebAuthFlow({ url, interactive: true });
      return result ? { type: 'success', url: result } : { type: 'cancel' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (CANCELLED.test(message)) return { type: 'cancel' };
      // "Authorization page could not be loaded" and the like: the sign-in
      // server is down or refused the redirect.
      throw new AuthFlowError(message);
    }
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** WeldSuite's list of the person's workspaces (`header` mode: the token names none). */
export async function loadWorkspaces(
  apiOrigin: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<OidcOrganization[] | null> {
  try {
    const res = await fetchImpl(`${apiOrigin}/api/workspaces`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'omit',
    });
    if (!res.ok) return null;
    return parseWorkspaceDirectory(await res.json());
  } catch {
    return null;
  }
}

export function sessionDeps(profile: ServerProfile, platform: AuthPlatform): OidcSessionDeps {
  return {
    fetchImpl: (input, init) => platform.fetchImpl(input, { ...init, credentials: 'omit' }),
    secureStore: platform.secure,
    cacheStore: platform.local,
    accessTokenStore: platform.session,
    openAuthSession: openAuthSession(platform),
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    sha256Base64: async (input) =>
      base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))),
    loadWorkspaces:
      profile.workspaceSource === 'header'
        ? (token) => loadWorkspaces(profile.apiOrigin, token, platform.fetchImpl)
        : undefined,
  };
}

export function createSession(profile: ServerProfile, platform: AuthPlatform): OidcMobileSession {
  return new OidcMobileSession(
    {
      issuer: profile.issuer,
      clientId: profile.clientId,
      redirectUri: platform.redirectUri,
      audience: profile.audience,
      orgClaim: profile.orgClaim,
      scopes: profile.scopes ?? undefined,
      audienceScope: profile.audienceScope,
      organizationScope: profile.organizationScope,
      workspaceSource: profile.workspaceSource,
      storageId: `ext.${storageIdFor(profile.origin)}`,
    },
    sessionDeps(profile, platform),
  );
}
