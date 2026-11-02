/**
 * Conformance mode's live presence: the realtime-worker answers
 * `GET /internal/presence` (`RealtimePublisher#getPresence`), and a test
 * answers it through its own `REALTIME` binding stub. This bridge serves that
 * binding on 127.0.0.1 so the Rust server reads the same presence through its
 * `PresenceReader` port (`rust/bins/weldsuite/src/conformance_outbound.rs`):
 *
 *   GET /internal/presence?workspaceId=…[&userId=…]   the binding's answer, as is
 *
 * Only reads go through here. Publishes are side effects, compared through the
 * recorders (./conformance.ts), never replayed into the test's stub.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** A `REALTIME` service binding: anything with `fetch`. */
export interface RealtimeLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function isRealtimeLike(value: unknown): value is RealtimeLike {
  return Boolean(value) && typeof (value as { fetch?: unknown }).fetch === 'function';
}

async function handle(realtime: RealtimeLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET' || url.pathname !== '/internal/presence') {
    res.writeHead(404).end();
    return;
  }
  let response: Response;
  try {
    response = await realtime.fetch(`https://internal${url.pathname}${url.search}`, { method: 'GET' });
  } catch (error) {
    res.writeHead(502, { 'x-realtime-error': 'fetch-threw' }).end(String(error));
    return;
  }
  const body = new Uint8Array(await response.arrayBuffer());
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain' }).end(body);
}

const bridges = new WeakMap<object, Promise<string>>();

/**
 * The bridge's URL for a test's own `REALTIME` binding (wrapped by the
 * recorder, `testOwned`), or undefined: the recorder's own binding answers
 * presence with nothing, as Rust without a presence source does.
 */
export function realtimeUrl(env: Record<string, unknown>): Promise<string> | undefined {
  const realtime = env.REALTIME;
  if (!isRealtimeLike(realtime) || !(realtime as { testOwned?: boolean }).testOwned) return undefined;
  let url = bridges.get(realtime);
  if (!url) {
    url = serveOnLoopback((req, res) => handle(realtime, req, res));
    bridges.set(realtime, url);
  }
  return url;
}
