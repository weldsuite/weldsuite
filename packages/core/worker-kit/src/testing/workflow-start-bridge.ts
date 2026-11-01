/**
 * Conformance mode's Workflow starts (one run per key): a test's Workflow binding stub (a
 * `FINALIZE_ENVELOPE` that fails on purpose, say) served over HTTP on
 * 127.0.0.1, so the Rust server's jobs adapter starts its jobs through a
 * stub of the same kind (`conformance_portal.rs`).
 *
 *   POST /start   { name, key, payload }   204 started; 503 when it could not start
 *
 * Rust's `Jobs::start` is one run per key, started again after a failure;
 * on a Workflow binding that is what the Workers do around `create`
 * (`startFinalizing` in @weldsuite/sign-domain/portal): create the instance
 * with the key as its id; when that throws, look the instance up, and
 * restart it when it errored or was terminated. No instance: not started.
 *
 * A stub records its calls and holds state, so the test gives Rust a stub
 * of its own and TypeScript another, and asserts on the one Rust used.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** The Workflow binding methods the bridge calls. */
export interface WorkflowLike {
  create(options: { id: string; params: unknown }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }>; restart(): Promise<unknown> }>;
}

async function readJson(req: IncomingMessage): Promise<{ key?: string; payload?: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { key?: string; payload?: unknown };
}

/** Start one run of `key`, as `startFinalizing` does on the binding. */
async function start(workflow: WorkflowLike, key: string, params: unknown): Promise<void> {
  try {
    await workflow.create({ id: key, params });
  } catch (err) {
    const instance = await workflow.get(key).catch(() => null);
    if (!instance) throw err;
    const { status } = await instance.status();
    if (status === 'errored' || status === 'terminated') await instance.restart();
  }
}

async function handle(workflow: WorkflowLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/start' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const { key, payload } = await readJson(req);
  if (!key) {
    res.writeHead(400).end('key required');
    return;
  }
  try {
    await start(workflow, key, payload);
  } catch (error) {
    res.writeHead(503).end(String(error));
    return;
  }
  res.writeHead(204).end();
}

const bridges = new WeakMap<object, Promise<string>>();

/** The bridge's URL for this binding, starting its server once. */
export function workflowBridgeUrl(workflow: WorkflowLike): Promise<string> {
  let url = bridges.get(workflow);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(workflow, req, res));
    bridges.set(workflow, url);
  }
  return url;
}
