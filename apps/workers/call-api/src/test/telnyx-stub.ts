/**
 * A stand-in for Telnyx's REST API (`https://api.telnyx.com/v2`) as a
 * `fetch` stub. It answers by method and path (the handler sees the URL and
 * the parsed body), never by call order, so the same stub answers both
 * backends in conformance mode: the Rust server's calls reach it through the
 * harness's outbound bridge.
 *
 * billing-worker's local URL (`http://localhost:8788`, `ENVIRONMENT:
 * 'development'`) refuses the connection, as when billing-worker cannot be
 * reached. Every other URL (the harness's own loopback calls) goes to the
 * real fetch.
 */

import { vi } from 'vitest';

export const TELNYX = 'https://api.telnyx.com/v2';

/** One call the stub answered. */
export interface TelnyxCall {
  method: string;
  url: URL;
  body: unknown;
}

type Handler = (call: TelnyxCall) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A Telnyx error answer (`{ errors: [{ detail }] }`). */
export const telnyxError = (status: number, detail?: string) =>
  json(detail === undefined ? {} : { errors: [{ detail }] }, status);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return body ?? null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

const realFetch = globalThis.fetch;

/**
 * Install the stub; `on(method, path, handler)` answers `path` (after
 * `/v2`, without the query). Unknown paths answer 404 with a Telnyx error.
 */
export function stubTelnyx() {
  const routes = new Map<string, Handler>();
  const calls: TelnyxCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      if (url.host === 'localhost:8788') throw new TypeError('fetch failed');
      if (url.hostname !== 'api.telnyx.com') return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      const call = { method, url, body: bodyOf(init?.body) };
      calls.push(call);
      const handler = routes.get(`${method} ${url.pathname.replace(/^\/v2/, '')}`);
      if (!handler) return telnyxError(404, `no stub for ${method} ${url.pathname}`);
      return handler(call);
    }),
  );
  return {
    calls,
    on(method: string, path: string, handler: Handler | unknown) {
      routes.set(
        `${method} ${path}`,
        typeof handler === 'function' ? (handler as Handler) : () => json(handler),
      );
    },
    off(method: string, path: string) {
      routes.delete(`${method} ${path}`);
    },
  };
}
