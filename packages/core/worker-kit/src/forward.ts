/**
 * app-api → module worker forwarding.
 *
 * While clients still call app-api for a module that has moved to its own
 * worker (old mobile builds, cached SPA tabs, the CLI, local dev), app-api
 * hands those requests to the module worker over a service binding.
 *
 * Forwarding is opt-in per module through `API_FORWARD_MODULES`
 * (comma-separated module ids, e.g. `pass,host`) AND requires the module's
 * service binding (`PASS_API`, …) to exist. Without both, the request stays in
 * app-api, so a half-configured environment never loses traffic.
 *
 * Mount it as the FIRST middleware: the module worker runs its own CORS, auth
 * and error handling, and its response is passed through untouched.
 */

import type { MiddlewareHandler } from 'hono';
import { findModuleForPath, parseModuleList, type ApiModuleId } from '@weldsuite/api-modules';

export interface ForwardEnv {
  API_FORWARD_MODULES?: string;
}

export const FORWARDED_BY_HEADER = 'X-Forwarded-By';

let lastList: string | undefined;
let lastParsed: Set<ApiModuleId> = new Set();

function enabledModules(value: string | undefined): Set<ApiModuleId> {
  if (value !== lastList) {
    lastList = value;
    lastParsed = parseModuleList(value);
  }
  return lastParsed;
}

export function moduleForwarder(options: { from: string }): MiddlewareHandler<{ Bindings: ForwardEnv }> {
  return async (c, next) => {
    const enabled = enabledModules(c.env?.API_FORWARD_MODULES);
    if (enabled.size === 0) return next();

    const module = findModuleForPath(c.req.path);
    if (module.id === 'core' || !enabled.has(module.id)) return next();

    const target = (c.env as unknown as Record<string, unknown>)[module.binding] as Fetcher | undefined;
    if (!target || typeof target.fetch !== 'function') {
      console.warn(`[forward] ${module.id} is enabled but binding ${module.binding} is missing`);
      return next();
    }

    const headers = new Headers(c.req.raw.headers);
    if (!headers.has('X-Request-Id')) headers.set('X-Request-Id', crypto.randomUUID());
    headers.set(FORWARDED_BY_HEADER, options.from);

    const upstream = await target.fetch(new Request(c.req.raw, { headers }));
    // Re-wrap so the headers are mutable for anything that runs after us.
    return new Response(upstream.body, upstream);
  };
}
