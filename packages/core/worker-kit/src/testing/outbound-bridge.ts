/**
 * Conformance mode's outbound HTTP: the calls a route makes to a third-party
 * API (Clerk's Backend API, Expo push, …) are answered by the test's own
 * `fetch` stub on both backends, and compared.
 *
 * The TypeScript route calls `globalThis.fetch` directly, which the test has
 * stubbed. The Rust server can't see that stub, so in conformance mode its
 * adapters (the `Identity` port's Clerk adapter, `rust/bins/weldsuite/src/
 * conformance_outbound.rs`) send each call here instead, and this bridge
 * replays it into the test's `fetch`:
 *
 *   <METHOD> /fetch?url=<the original URL, encoded>   body and Content-Type as sent
 *
 * The answer (status, Content-Type, body) goes back to Rust unchanged.
 *
 * Both sides are recorded as `{ method, url, body }`: the bridge records what
 * Rust sent, and `recordOutbound()` wraps `globalThis.fetch` while the Hono
 * app runs. `conformance.ts` compares the two lists as a side effect, so a
 * port that skips, adds or changes a provider call fails the suite.
 *
 * A test's stub answers both runs, so it must answer by URL and method
 * (`mockImplementation`), not by call order (`mockResolvedValueOnce`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** One outbound call, as compared between the backends. */
export interface OutboundCall {
  method: string;
  url: string;
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

/** A `fetch` body as text, when it is one we can read without consuming a stream. */
function textOf(body: BodyInit | null | undefined): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return '<body>';
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Loopback calls are the harness's own (the Rust server, the bridges), never a route's. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Headers of one HTTP leg, never passed between the stub and Rust. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'upgrade',
]);

const rustCalls: OutboundCall[] = [];

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const target = url.searchParams.get('url');
  if (url.pathname !== '/fetch' || !target) {
    res.writeHead(404).end();
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const bytes = await readBody(req);
  const text = bytes.byteLength > 0 ? new TextDecoder().decode(bytes) : null;
  rustCalls.push({ method, url: target, body: bodyOf(text) });

  // The call's own headers (a forwarded request carries the app's), minus
  // the hop-by-hop ones of this leg.
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && !HOP_BY_HOP.has(name)) headers.set(name, value);
  }

  let response: Response;
  try {
    response = await globalThis.fetch(target, { method, headers, body: text ?? undefined });
  } catch (error) {
    // The stub threw (a network failure in the test's terms): Rust sees a
    // connection-level failure too.
    res.writeHead(502, { 'x-outbound-error': 'fetch-threw' }).end(String(error));
    return;
  }
  const answer = new Uint8Array(await response.arrayBuffer());
  const answerHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && name !== 'content-encoding') answerHeaders[name] = value;
  });
  res.writeHead(response.status, answerHeaders).end(answer);
}


let bridge: Promise<string> | undefined;

/** The bridge's URL, starting its server once per test process. */
export function outboundBridgeUrl(): Promise<string> {
  bridge ??= serveOnLoopback(handle);
  return bridge;
}

/** What Rust sent through the bridge since the last call, clearing it. */
export function takeRustOutbound(): OutboundCall[] {
  return rustCalls.splice(0);
}

/**
 * Run `fn` with `globalThis.fetch` wrapped to record the route's outbound
 * calls (loopback excluded), then put the test's `fetch` back.
 */
export async function recordOutbound<T>(fn: () => Promise<T>): Promise<{ result: T; calls: OutboundCall[] }> {
  const calls: OutboundCall[] = [];
  const original = globalThis.fetch;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!isLoopback(url)) {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      // A `Request` carries its own body (a forwarded call, `fetch(new Request(…))`).
      const text =
        init?.body === undefined && input instanceof Request ? (await input.clone().text()) || null : textOf(init?.body);
      calls.push({ method, url, body: bodyOf(text) });
    }
    return original(input, init);
  };
  globalThis.fetch = wrapped as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    // A test that swapped `fetch` mid-request keeps its own.
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  }
}

/** The calls in a stable order: concurrent calls (`Promise.all`) may go out in any order. */
export function sortOutbound(calls: OutboundCall[]): OutboundCall[] {
  return [...calls].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
