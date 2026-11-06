/**
 * A stub of the outbound `fetch` for the GitLab, Bitbucket, Azure DevOps and
 * OAuth hosts, answered by METHOD, host and path (never by call order, so the
 * Rust backend can answer the same test in conformance mode), with the calls
 * recorded: method, URL (host, path and query), the JSON or form body, and the
 * kind of credentials sent. `test/fake-gitlab.ts`, `fake-bitbucket.ts` and
 * `fake-azure-devops.ts` build on it with each provider's payloads.
 */

import { vi } from 'vitest';

export interface HttpCall {
  method: string;
  /** `host/path?query` (no scheme). */
  url: string;
  body?: unknown;
  /** `bearer <token>`, `basic <user>:<password>`, or absent. */
  auth?: string;
}

/** A body, a function of the call returning one (or a promise of one), or a ready `Response` (to answer with an error status). */
export type HttpAnswer = unknown | ((call: { url: URL; body: unknown }) => unknown);

const realFetch = globalThis.fetch;

function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

function authOf(init?: RequestInit): string | undefined {
  const headers = new Headers(init?.headers);
  const value = headers.get('authorization');
  if (!value) return undefined;
  if (/^bearer /i.test(value)) return `bearer ${value.slice(7)}`;
  if (/^basic /i.test(value)) return `basic ${atob(value.slice(6))}`;
  return value;
}

function bodyOf(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return undefined;
  const type = new Headers(init.headers).get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(init.body));
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

/**
 * Stubs `fetch`. `answers` maps `<METHOD> <host><path>` (no query) to a body or a
 * function of the call; anything else is a 404. Returns the calls made, in order.
 */
export function stubHttp(answers: Record<string, HttpAnswer>): HttpCall[] {
  const calls: HttpCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (isLoopback(url)) return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = bodyOf(init);
      calls.push({ method, url: `${url.host}${url.pathname}${url.search}`, ...(body !== undefined ? { body } : {}), auth: authOf(init) });
      const answer = answers[`${method} ${url.host}${url.pathname}`];
      if (answer === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      // An answer may be async (it can change the database first, as a concurrent request would).
      const value = typeof answer === 'function' ? await (answer as (c: { url: URL; body: unknown }) => unknown)({ url, body }) : answer;
      if (value instanceof Response) return value.clone();
      return new Response(value === null ? null : JSON.stringify(value), {
        status: value === null ? 204 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** An in-memory KV namespace (the OAuth state lives in `WORKSPACE_CACHE`). */
export function fakeKv(): KVNamespace & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  } as unknown as KVNamespace & { entries: Map<string, string> };
}

/** A JSON error answer with a status. */
export const failure = (status: number, body: unknown = { message: 'failed' }) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
