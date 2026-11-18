/**
 * Conformance mode's rate-limiting bindings: a test's Workers rate limiter
 * (`EVENTS_RATE_LIMIT` and the other `[[ratelimits]]` of WeldPanel's
 * collector, a fake with `limit({ key })`) served over HTTP, so the Rust
 * server counts on the same fake. The Rust side is
 * `rust/bins/weldsuite/src/conformance_panel.rs`.
 *
 *   POST /limit { binding, key }
 *     → binding.limit({ key })
 *     200 { success }   the outcome
 *     500 { error }     the fake threw
 *
 * The calls are not compared as side effects: their outcome shows in the
 * answer (a 429). The TypeScript run of a write calls the fake's `fork()`
 * when it has one (./write-isolation.ts), so each run counts from the same
 * state and only Rust's calls reach the test's fake.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** The rate-limiting bindings the bridge serves. */
export const RATE_LIMIT_BINDINGS = [
  'EVENTS_RATE_LIMIT',
  'EVENTS_PROXY_RATE_LIMIT',
  'REPLAYS_RATE_LIMIT',
  'SNAPSHOTS_RATE_LIMIT',
] as const;

interface RateLimitLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export function isRateLimitLike(value: unknown): value is RateLimitLike {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).limit === 'function';
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

async function handle(env: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/limit' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const call = (await readJson(req)) as { binding: string; key?: string };
  const binding = env[call.binding];
  if (!RATE_LIMIT_BINDINGS.includes(call.binding as (typeof RATE_LIMIT_BINDINGS)[number]) || !isRateLimitLike(binding)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const outcome = await binding.limit({ key: String(call.key ?? '') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: Boolean(outcome?.success) }));
  } catch (error) {
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** `{ EVENTS_RATE_LIMIT: url, … }` for the rate-limiting bindings `env` has, or undefined. */
export async function rateLimitUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const present = RATE_LIMIT_BINDINGS.filter((name) => isRateLimitLike(env[name]));
  if (present.length === 0) return undefined;
  let url = bridges.get(env);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(env, req, res));
    bridges.set(env, url);
  }
  const bridge = await url;
  return Object.fromEntries(present.map((name) => [name, bridge]));
}
