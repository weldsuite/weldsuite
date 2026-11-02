/**
 * Conformance mode's stream bindings: a test's Cloudflare Pipelines stream
 * (`PANEL_EVENTS`, a fake with `send(records)`) served over HTTP, so the
 * Rust server's event writes reach the same fake. The Rust side is
 * `rust/bins/weldsuite/src/conformance_panel.rs`.
 *
 *   POST /send { binding, records }
 *     → binding.send(records)
 *     204 | 500 { error }   the fake threw
 *
 * Both runs' writes are compared as `pipelines` side effects
 * (`{ binding, records }`). The TypeScript run of a write sends to the
 * fake's `fork()` when it has one (./write-isolation.ts), so the test's own
 * assertions see Rust's rows only, as its response is Rust's.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** The stream bindings the bridge serves. */
export const PIPELINE_BINDINGS = ['PANEL_EVENTS'] as const;

interface PipelineLike {
  send(records: unknown[]): Promise<unknown>;
}

export function isPipelineLike(value: unknown): value is PipelineLike {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).send === 'function';
}

/** One write, as compared. */
export interface PipelineCall {
  binding: string;
  records: unknown[];
}

const copy = (value: unknown): unknown[] => JSON.parse(JSON.stringify(value ?? [])) as unknown[];

const rustCalls: PipelineCall[] = [];

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

async function handle(env: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/send' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const call = (await readJson(req)) as { binding: string; records?: unknown[] };
  const binding = env[call.binding];
  if (!PIPELINE_BINDINGS.includes(call.binding as (typeof PIPELINE_BINDINGS)[number]) || !isPipelineLike(binding)) {
    res.writeHead(404).end();
    return;
  }
  const records = copy(call.records);
  rustCalls.push({ binding: call.binding, records });
  try {
    await binding.send(records);
    res.writeHead(204).end();
  } catch (error) {
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** `{ PANEL_EVENTS: url }` for the stream bindings `env` has, or undefined. */
export async function pipelineUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const present = PIPELINE_BINDINGS.filter((name) => isPipelineLike(env[name]));
  if (present.length === 0) return undefined;
  let url = bridges.get(env);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(env, req, res));
    bridges.set(env, url);
  }
  const bridge = await url;
  return Object.fromEntries(present.map((name) => [name, bridge]));
}

/** What Rust wrote through the bridge since the last call, clearing it. */
export function takeRustPipelineCalls(): PipelineCall[] {
  return rustCalls.splice(0);
}

/** `env` with its stream bindings recording the TypeScript run's writes. */
export function recordTypeScriptPipelineCalls(env: Record<string, unknown>): {
  env: Record<string, unknown>;
  finish: () => PipelineCall[];
} {
  if (!PIPELINE_BINDINGS.some((binding) => isPipelineLike(env[binding]))) return { env, finish: () => [] };
  const calls: PipelineCall[] = [];
  const wrapped: Record<string, unknown> = { ...env };
  for (const binding of PIPELINE_BINDINGS) {
    const target = env[binding];
    if (!isPipelineLike(target)) continue;
    wrapped[binding] = {
      send: (records: unknown[]) => {
        calls.push({ binding, records: copy(records) });
        return target.send(records);
      },
    };
  }
  return { env: wrapped, finish: () => calls.splice(0) };
}
