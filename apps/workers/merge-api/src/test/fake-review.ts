/**
 * Test plumbing for the phase 4 (review) route tests: a `fetch` stub that
 * answers any provider by `<METHOD> <origin+path>` (never by call order) and
 * records every call with its body and authorization, plus helpers that seed
 * a member's linked account with sealed credentials.
 *
 * GitHub's installation-token exchange is answered like `stubGithub` does and
 * left out of the recorded calls.
 */

import { vi } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { sealCredentials } from '../services/credentials';

export const KEY_ENV = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) };

export interface RecordedCall {
  method: string;
  /** Origin, path and query. */
  url: string;
  body: unknown;
  authorization: string | null;
}

export type Answer = unknown | ((call: RecordedCall) => unknown);

const realFetch = globalThis.fetch;
const TOKEN_EXCHANGE = /^\/app\/installations\/\d+\/access_tokens$/;

const isLoopback = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

/** What a stub answer becomes: a ready `Response` as is, plain text for strings, JSON otherwise. */
function toResponse(body: unknown): Response {
  if (body instanceof Response) return body.clone();
  if (typeof body === 'string') return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } });

/** Stubs `fetch`; `answers` maps `<METHOD> <origin+path>` (no query) to a body, a function of the call, or a `Response`. */
export function stubProviders(answers: Record<string, Answer>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (isLoopback(url)) return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && TOKEN_EXCHANGE.test(url.pathname)) {
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        return new Response(JSON.stringify({ token: 'ghs_test_token', expires_at: expiresAt }), { status: 201 });
      }
      const headers = new Headers(init?.headers);
      const call: RecordedCall = {
        method,
        url: url.origin + url.pathname + url.search,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        authorization: headers.get('authorization'),
      };
      calls.push(call);
      const answer = answers[`${method} ${url.origin}${url.pathname}`];
      if (answer === undefined) return failure(404, 'Not Found');
      return toResponse(typeof answer === 'function' ? (answer as (c: RecordedCall) => unknown)(call) : answer);
    }),
  );
  return calls;
}

/** The recorded calls as `METHOD url`, for readable assertions. */
export const callLines = (calls: RecordedCall[]) => calls.map((c) => `${c.method} ${c.url}`);

/** Links a member's account for a provider, with a sealed token. `verified: false` is a typed login. */
export async function linkAccount(
  db: Database,
  userId: string,
  provider: MergeProvider,
  options: { host?: string | null; token?: string; verified?: boolean } = {},
) {
  const verified = options.verified ?? true;
  await db.insert(schema.mergeProviderAccounts).values({
    id: generateId('mpa'),
    userId,
    provider,
    login: `${userId}-${provider}`,
    host: options.host ?? null,
    credentials: await sealCredentials(KEY_ENV, { accessToken: options.token ?? `member-${provider}-token` }),
    verifiedAt: verified ? new Date('2026-10-01T00:00:00Z') : null,
  });
}

/** Sealed connection credentials for GitLab, Bitbucket and Azure DevOps connections. */
export const connectionCredentials = (token = 'connection-token') => sealCredentials(KEY_ENV, { accessToken: token });
