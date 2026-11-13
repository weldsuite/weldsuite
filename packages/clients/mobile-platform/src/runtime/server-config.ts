/**
 * Reading a Kubernetes server's `/config.json` and deciding whether this app
 * can use it. Pure apart from the injected `fetch`.
 */

import {
  parseRuntimeConfig,
  RUNTIME_CONFIG_PATH,
  type RuntimeConfig,
} from '@weldsuite/app-api-client/schemas/runtime-config';
import type { MobileAppIdentity, ServerProblem } from './types';

export const SERVER_CONFIG_TIMEOUT_MS = 5000;

export type ServerConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; problem: Extract<ServerProblem, 'unreachable' | 'not-weldsuite'> };

/**
 * Fetch and parse `<origin>/config.json`. Never rejects: no answer, a slow
 * answer or a network error is `unreachable`; an answer that isn't a
 * Kubernetes WeldSuite document (an HTML page, another product, Global) is
 * `not-weldsuite`.
 */
export async function fetchServerConfig(
  origin: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ServerConfigResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs ?? SERVER_CONFIG_TIMEOUT_MS)
    : null;
  try {
    const res = await fetchImpl(`${origin}${RUNTIME_CONFIG_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res.ok) return { ok: false, problem: res.status === 404 ? 'not-weldsuite' : 'unreachable' };
    if (!(res.headers.get('content-type') ?? '').includes('json')) {
      return { ok: false, problem: 'not-weldsuite' };
    }
    const config = parseRuntimeConfig(await res.json());
    if (config?.backend !== 'rust') return { ok: false, problem: 'not-weldsuite' };
    return { ok: true, config };
  } catch {
    return { ok: false, problem: 'unreachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether this app can use a server that answered with `config`. Null = yes.
 */
export function assessServerConfig(
  config: RuntimeConfig,
  app: MobileAppIdentity,
): Extract<ServerProblem, 'no-mobile-sign-in' | 'app-unavailable'> | null {
  const auth = config.auth;
  if (!auth) return 'no-mobile-sign-in';
  if (auth.provider === 'oidc' && !auth.mobileClientId) return 'no-mobile-sign-in';
  if (auth.provider === 'clerk' && !auth.publishableKey) return 'no-mobile-sign-in';
  if (config.modules) {
    const served = new Set(config.modules);
    if (app.requiredModules.some((id) => !served.has(id))) return 'app-unavailable';
  }
  if (app.supportsServer && !app.supportsServer(config)) return 'app-unavailable';
  return null;
}
