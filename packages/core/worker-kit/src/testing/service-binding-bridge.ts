/**
 * Conformance mode's service bindings: a worker's call to another worker over
 * a Cloudflare service binding (hr-api's `BOOKS_INTERNAL`, books-api's
 * `BooksInternal` entrypoint that posts an approved pay run's journal) is
 * answered by the test's own stub on both backends, and compared.
 *
 * The Rust server can't call the stub, so in conformance mode its port
 * (`rust/bins/weldsuite/src/conformance_books.rs`) sends each call here and
 * this bridge replays it into the binding:
 *
 *   <METHOD> /fetch?binding=<name>&path=<path>
 *     X-Workspace-Id: <key>, Content-Type, the body as sent
 *
 * The bridge answers with the stub's status and body; a stub that threw is a
 * `502` with `x-binding-error: fetch-threw` and the error's message.
 *
 * Both sides are recorded as `{ binding, method, path, workspace, body }`:
 * the bridge records what Rust sent, and `recordTypeScriptServiceCalls()`
 * wraps the bindings the Hono app runs with. `conformance.ts` compares the
 * two lists as a side effect. A stub answers both runs, so it must answer by
 * request, not by call order.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** The service bindings the bridge serves. */
export const SERVICE_BINDINGS = ['BOOKS_INTERNAL'] as const;

interface FetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function isFetcherLike(value: unknown): value is FetcherLike {
  return !!value && typeof value === 'object' && typeof (value as FetcherLike).fetch === 'function';
}

/** One call, as compared. */
export interface ServiceCall {
  binding: string;
  method: string;
  path: string;
  /** `X-Workspace-Id`, the workspace the call is for. */
  workspace: string | null;
  /** The body as JSON when it parses, else the text; null without one. */
  body: unknown;
}

function bodyOf(text: string | null | undefined): unknown {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

type Fn = (...args: unknown[]) => unknown;

/**
 * Call the stub without counting the call on a `vi.fn` (the test asserts on
 * the calls its route made, which are Rust's, once).
 */
async function silently(binding: FetcherLike, args: [RequestInfo | URL, RequestInit | undefined]): Promise<Response> {
  const fn = binding.fetch as unknown as { mock?: unknown; getMockImplementation?: () => Fn | undefined };
  if (fn.mock && typeof fn.getMockImplementation === 'function') {
    const impl = fn.getMockImplementation();
    if (!impl) return new Response(null, { status: 200 });
    return (await impl.apply(binding, args)) as Response;
  }
  return binding.fetch(...args);
}

const rustCalls: ServiceCall[] = [];

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(env: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const name = url.searchParams.get('binding') ?? '';
  const path = url.searchParams.get('path') ?? '/';
  const binding = env[name];
  if (url.pathname !== '/fetch' || !SERVICE_BINDINGS.includes(name as (typeof SERVICE_BINDINGS)[number]) || !isFetcherLike(binding)) {
    res.writeHead(404).end();
    return;
  }
  const method = (req.method ?? 'POST').toUpperCase();
  const text = await readText(req);
  const workspace = typeof req.headers['x-workspace-id'] === 'string' ? req.headers['x-workspace-id'] : null;
  rustCalls.push({ binding: name, method, path, workspace, body: bodyOf(text) });
  const headers: Record<string, string> = { 'Content-Type': String(req.headers['content-type'] ?? 'application/json') };
  if (workspace) headers['X-Workspace-Id'] = workspace;
  let response: Response;
  try {
    response = await silently(binding, [`https://internal${path}`, { method, headers, body: text || undefined }]);
  } catch (error) {
    res.writeHead(502, { 'x-binding-error': 'fetch-threw' }).end(error instanceof Error ? error.message : String(error));
    return;
  }
  const answer = new Uint8Array(await response.arrayBuffer());
  res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' }).end(answer);
}

const bridges = new WeakMap<object, Promise<string>>();

/** `{ BOOKS_INTERNAL: url }` for the service bindings `env` has, or undefined. */
export async function serviceBindingUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const present = SERVICE_BINDINGS.filter((name) => isFetcherLike(env[name]));
  if (present.length === 0) return undefined;
  let url = bridges.get(env);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(env, req, res));
    bridges.set(env, url);
  }
  const bridge = await url;
  return Object.fromEntries(present.map((name) => [name, bridge]));
}

/** What Rust called through the bridge since the last call, clearing it. */
export function takeRustServiceCalls(): ServiceCall[] {
  return rustCalls.splice(0);
}

async function requestText(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') return init.body;
    return new Response(init.body).text();
  }
  if (input instanceof Request) return (await input.clone().text()) || null;
  return null;
}

/** `env` with its service bindings recording the TypeScript run's calls. */
export function recordTypeScriptServiceCalls(env: Record<string, unknown>): {
  env: Record<string, unknown>;
  finish: () => ServiceCall[];
} {
  if (!SERVICE_BINDINGS.some((name) => isFetcherLike(env[name]))) return { env, finish: () => [] };
  const calls: ServiceCall[] = [];
  const wrapped: Record<string, unknown> = { ...env };
  for (const name of SERVICE_BINDINGS) {
    const binding = env[name];
    if (!isFetcherLike(binding)) continue;
    wrapped[name] = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        calls.push({
          binding: name,
          method,
          path: url.pathname + url.search,
          workspace: headers.get('x-workspace-id'),
          body: bodyOf(await requestText(input, init)),
        });
        return binding.fetch(input, init);
      },
    };
  }
  return { env: wrapped, finish: () => calls };
}

/** The calls in a stable order. */
export function sortServiceCalls(calls: ServiceCall[]): ServiceCall[] {
  return [...calls].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
