/**
 * Which WeldSuite server the extension talks to, and whether it can.
 *
 * One store build serves `https://app.weldsuite.eu` by default (ADR PASS-009).
 * Someone on a self-hosted install types its address; the extension reads that
 * server's `/config.json` and accepts it only when it is the Rust backend with
 * OIDC sign-in, offers WeldPass and names a client for this extension. Pure:
 * `fetch` is passed in.
 */

import {
  parseRuntimeConfig,
  RUNTIME_CONFIG_PATH,
  type RuntimeConfig,
} from '@weldsuite/app-api-client/schemas/runtime-config';
import { hostPatternsFor, secureOrigin } from './origins';

export { EU_SERVER, hostPatternsFor, secureOrigin, type DefaultServer } from './origins';

/** Everything the extension needs to sign in to a server and call its API. Nothing secret. */
export interface ServerProfile {
  origin: string;
  /** Where `/api/...` lives: the config's `apiBaseUrl`, else the server's own origin. */
  apiOrigin: string;
  issuer: string;
  clientId: string;
  audience: string | null;
  orgClaim: string | null;
  scopes: string[] | null;
  /** `null` = no such scope (WeldID); `undefined` = Zitadel's default template. */
  audienceScope: string | null | undefined;
  organizationScope: string | null | undefined;
  workspaceSource: 'claim' | 'header';
  /** The provider's account pages, when it has them (WeldID). */
  accountUrl: string | null;
}

export type ServerProblem =
  /** No answer, a slow one, or a network error. */
  | 'unreachable'
  /** An answer that isn't a Kubernetes WeldSuite `/config.json` (Global, another product, a web page). */
  | 'not-weldsuite'
  /** The server signs in with Clerk, or names no client for this extension. */
  | 'no-extension-sign-in'
  /** The server doesn't offer WeldPass. */
  | 'no-weldpass';

export type AddressResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'insecure' };

/**
 * From what a person types (`weldsuite.example.com`, `https://Weld.Example.com/app`)
 * to a server origin. Only `https:`, except `http://localhost` for development.
 */
export function normaliseServerAddress(input: string): AddressResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username || url.password || !url.hostname) return { ok: false, reason: 'invalid' };
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' ? { ok: true, origin: url.origin } : { ok: false, reason: 'insecure' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'invalid' };
  // A bare word ("weldsuite") is a typo, not a server.
  if (!url.hostname.includes('.') && !url.hostname.startsWith('[')) return { ok: false, reason: 'invalid' };
  return { ok: true, origin: url.origin };
}

export type ProfileResult = { ok: true; profile: ServerProfile } | { ok: false; problem: ServerProblem };

/** Whether this extension can use a server that answered with `config`, and how. */
export function profileFromConfig(origin: string, config: RuntimeConfig): ProfileResult {
  if (config.backend !== 'rust') return { ok: false, problem: 'not-weldsuite' };
  const auth = config.auth;
  if (!auth || auth.provider !== 'oidc' || !auth.extensionClientId) {
    return { ok: false, problem: 'no-extension-sign-in' };
  }
  if (config.modules && !config.modules.includes('pass')) return { ok: false, problem: 'no-weldpass' };
  const issuer = secureOrigin(auth.issuer) ? auth.issuer.replace(/\/+$/, '') : null;
  if (!issuer) return { ok: false, problem: 'no-extension-sign-in' };
  const apiOrigin = config.apiBaseUrl ? secureOrigin(config.apiBaseUrl) : origin;
  if (!apiOrigin) return { ok: false, problem: 'not-weldsuite' };

  return {
    ok: true,
    profile: {
      origin,
      apiOrigin,
      issuer,
      clientId: auth.extensionClientId,
      audience: auth.audience ?? null,
      orgClaim: auth.orgClaim ?? null,
      scopes: auth.scopes ?? null,
      audienceScope: auth.audienceScope,
      organizationScope: auth.organizationScope,
      workspaceSource: auth.workspaceSource ?? 'claim',
      accountUrl: auth.accountUrl ?? null,
    },
  };
}

export const SERVER_CONFIG_TIMEOUT_MS = 8000;

/** Fetch and judge `<origin>/config.json`. Never rejects. */
export async function inspectServer(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs = SERVER_CONFIG_TIMEOUT_MS,
): Promise<ProfileResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}${RUNTIME_CONFIG_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!res.ok) return { ok: false, problem: res.status === 404 ? 'not-weldsuite' : 'unreachable' };
    if (!(res.headers.get('content-type') ?? '').includes('json')) return { ok: false, problem: 'not-weldsuite' };
    const config = parseRuntimeConfig(await res.json());
    if (!config) return { ok: false, problem: 'not-weldsuite' };
    return profileFromConfig(origin, config);
  } catch {
    return { ok: false, problem: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The host permission match patterns a server needs: itself, its API and its issuer. */
export function profilePatterns(profile: Pick<ServerProfile, 'origin' | 'apiOrigin' | 'issuer'>): string[] {
  return hostPatternsFor([profile.origin, profile.apiOrigin, profile.issuer]);
}

/** `app.weldsuite.eu`: how the extension names a server to people. */
export function serverLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return origin;
  }
}
