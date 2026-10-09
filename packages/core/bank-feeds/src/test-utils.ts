import type { FetchLike } from './http';

export interface RecordedCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  query: URLSearchParams;
  /** JSON body, or the form body parsed into an object. */
  payload: Record<string, unknown>;
}

export type Responder = (call: RecordedCall) => unknown;

/**
 * A fixture `fetch`: routes are `"METHOD /path"`; a responder returns the JSON
 * body, or `new Response(...)` for a custom status. An unmatched call throws so
 * the test fails loudly instead of hitting the network.
 */
export function routeFetch(routes: Record<string, Responder | object>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? init.body : null;
    let payload: Record<string, unknown> = {};
    if (body) {
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        payload = Object.fromEntries(new URLSearchParams(body));
      }
    }
    const call: RecordedCall = { url: input, path: url.pathname, method: init?.method ?? 'GET', headers, body, query: url.searchParams, payload };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) throw new Error(`Unexpected request: ${call.method} ${call.path}`);
    const result = typeof route === 'function' ? (route as Responder)(call) : route;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl, calls };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of array) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
