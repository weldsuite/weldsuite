/**
 * A stand-in for Clerk's Backend API as a `fetch` stub, for route tests that
 * also run in conformance mode (the Rust backend's Clerk calls reach this stub
 * through the harness's outbound bridge).
 *
 * The stub answers by method and URL only, never by call order: in
 * conformance mode both backends ask it the same questions. `clerkShim()`
 * stands in for `@clerk/backend`'s client, which binds `fetch` when it loads
 * and so never sees a stub: it makes the same requests the SDK makes, through
 * the current `fetch`.
 */

import type { Mock } from 'vitest';
import { vi } from 'vitest';

export const CLERK_API = 'https://api.clerk.com/v1';

/** The real `fetch`: the conformance harness talks to the Rust server with it. */
const realFetch = globalThis.fetch.bind(globalThis);

export interface ClerkAnswer {
  status: number;
  body?: unknown;
}

function json(answer: ClerkAnswer): Response {
  return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Clerk error body (`errors[0]`). */
export function clerkError(status: number, code: string, message = code): ClerkAnswer {
  return { status, body: { errors: [{ code, message, long_message: message }] } };
}

/** `(method, path + query, body) → answer`; `'throw'` fails like a network error. */
export type ClerkRoutes = (method: string, path: string, body: unknown) => ClerkAnswer | 'throw' | undefined;

/**
 * Stub `fetch` with `routes` for calls to Clerk (a missing route is a 404);
 * anything else goes to the real `fetch`.
 */
export function stubClerk(routes: ClerkRoutes): Mock {
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    // Not Clerk: the harness's own calls (the Rust server, the bridges).
    if (!url.startsWith(CLERK_API)) return realFetch(input, init);
    let body: unknown = null;
    if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body) as unknown;
    const answer = routes(method, url.slice(CLERK_API.length), body);
    if (answer === 'throw') throw new TypeError('fetch failed');
    return json(answer ?? clerkError(404, 'resource_not_found'));
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

/**
 * The distinct Clerk calls a stub received, as `METHOD /path`, in first-call
 * order. Distinct: in conformance mode both backends make each call.
 */
export function clerkCalls(stub: Mock): string[] {
  const calls = stub.mock.calls
    .map(([input, init]) => [String(input), (init as RequestInit | undefined)?.method ?? 'GET'] as const)
    .filter(([url]) => url.startsWith(CLERK_API))
    .map(([url, method]) => `${method.toUpperCase()} ${url.slice(CLERK_API.length)}`);
  return [...new Set(calls)];
}

async function sdkRequest(method: string, path: string): Promise<unknown> {
  const res = await fetch(`${CLERK_API}${path}`, {
    method,
    headers: { Authorization: 'Bearer sk_test', 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Clerk ${method} ${path} answered ${res.status}`);
  return res.json().catch(() => ({}));
}

/** The parts of `createClerkClient()` the routes use, as the SDK calls them. */
export function clerkShim() {
  return {
    organizations: {
      deleteOrganization: (id: string) => sdkRequest('DELETE', `/organizations/${id}`),
    },
    users: {
      deleteUser: (id: string) => sdkRequest('DELETE', `/users/${id}`),
    },
  };
}
