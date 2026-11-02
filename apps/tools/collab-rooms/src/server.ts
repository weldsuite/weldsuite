/**
 * The collab-rooms HTTP and WebSocket server (rust/docs/collab-rooms.md).
 *
 *   POST /rpc { binding, name, method, args }   a room's method, or an engine's
 *     → 200 { result } | 500 { error } | 404 (no such binding or method)
 *   GET  /api/docs/connect?ticket=…, /api/sheets/connect?ticket=…   a room's socket
 *   GET  /healthz, /readyz
 *
 * Every request carries `x-internal-secret` when `secret` is set: only the
 * Rust server talks to this service (it proxies the browsers' sockets).
 * Values cross as JSON, bytes as `{ "$bytes": "<base64>" }`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { HostedSocket, type RoomNamespace } from './runtime/host';

export interface CollabServerOptions {
  /** Room bindings (`DOC_ROOM`, `SHEET_ROOM`). */
  rooms: Record<string, RoomNamespace>;
  /** Engine bindings (`DOC_ENGINE`, `SHEET_ENGINE`): objects of functions. */
  engines: Record<string, Record<string, unknown>>;
  /** Socket path → room binding. */
  connectPaths: Record<string, string>;
  secret?: string;
  /** Whether this pod holds a room (rendezvous over the pod URLs, as the Rust server routes). */
  owns?: (id: string) => boolean;
  /** How often idle rooms are dropped and due alarms woken. */
  sweepMs?: number;
}

export function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof ArrayBuffer) return { $bytes: Buffer.from(new Uint8Array(value)).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  }
  return value;
}

export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]![0] === '$bytes' && typeof entries[0]![1] === 'string') {
      return new Uint8Array(Buffer.from(entries[0]![1], 'base64'));
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, decodeValue(v)]));
  }
  return value;
}

const TICKET = /^([0-9a-f]{64})\.[\w-]{16,}$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function refuse(socket: Duplex, status: number, text: string): void {
  const reason = { 401: 'Unauthorized', 404: 'Not Found', 426: 'Upgrade Required', 503: 'Service Unavailable' }[status] ?? 'Error';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain;charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
  );
}

export interface CollabServer {
  server: Server;
  /** Closes every socket (the rooms checkpoint as the last one leaves), then the server. */
  close(): Promise<void>;
}

export function createCollabServer(options: CollabServerOptions): CollabServer {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  let draining = false;
  const authorized = (req: IncomingMessage) => !options.secret || req.headers['x-internal-secret'] === options.secret;

  async function rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const call = JSON.parse((await readBody(req)) || '{}') as { binding?: string; name?: string; method?: string; args?: unknown };
    const args = Array.isArray(call.args) ? (decodeValue(call.args) as unknown[]) : [];
    const namespace = call.binding ? options.rooms[call.binding] : undefined;
    let target: Record<string, unknown> | undefined;
    if (namespace) {
      const host = await namespace.host(namespace.idFromName(call.name ?? ''));
      host.touch();
      target = host.object as unknown as Record<string, unknown>;
    } else if (call.binding) {
      target = options.engines[call.binding];
    }
    const method = target && call.method ? target[call.method] : undefined;
    if (typeof method !== 'function') {
      json(res, 404, { error: `no RPC method ${call.binding}.${call.method}` });
      return;
    }
    try {
      const result = (await (method as (...a: unknown[]) => unknown).apply(target, args)) ?? null;
      json(res, 200, { result: encodeValue(result) });
    } catch (error) {
      console.error(`[collab-rooms] ${call.binding}.${call.method} threw:`, error);
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz') return json(res, 200, { ok: true });
    if (path === '/readyz') return json(res, draining ? 503 : 200, { ok: !draining });
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (path === '/rpc' && req.method === 'POST') {
      rpc(req, res).catch((error: unknown) => {
        console.error('[collab-rooms] rpc failed:', error);
        if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (options.connectPaths[path]) {
      res.writeHead(426, { 'Content-Type': 'text/plain;charset=UTF-8' }).end('Expected a WebSocket upgrade');
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const binding = options.connectPaths[url.pathname];
      if (!binding) return refuse(socket, 404, 'Not found');
      if (!authorized(req)) return refuse(socket, 401, 'Unauthorized');
      if (draining) return refuse(socket, 503, 'Document unavailable');
      const ticket = url.searchParams.get('ticket') ?? '';
      const match = TICKET.exec(ticket);
      // A ticket names a live room: the room that issued it, on this pod.
      const pending = match ? options.rooms[binding]?.live(match[1]!) : undefined;
      if (!pending) return refuse(socket, 401, 'Invalid or expired ticket');
      const host = await pending;
      host.touch();
      const hosted = new HostedSocket(host);
      const outcome = await host.object.accept(hosted, ticket.split('.')[1] ?? null);
      if (outcome === 'invalid') return refuse(socket, 401, 'Invalid or expired ticket');
      if (outcome === 'unavailable') return refuse(socket, 503, 'Document unavailable');
      sockets.handleUpgrade(req, socket, head, (ws) => {
        hosted.attach(ws);
        if (hosted.closed) ws.close(1000);
      });
    })().catch((error: unknown) => {
      console.error('[collab-rooms] opening a socket failed:', error);
      refuse(socket, 503, 'Document unavailable');
    });
  });

  const owns = options.owns ?? (() => true);
  const sweepMs = options.sweepMs ?? 60_000;
  const timer = setInterval(() => {
    for (const namespace of Object.values(options.rooms)) {
      namespace.sweep().catch((error: unknown) => console.error('[collab-rooms] sweep failed:', error));
      namespace.wake(owns, 2 * sweepMs).catch((error: unknown) => console.error('[collab-rooms] waking alarms failed:', error));
    }
  }, sweepMs);
  timer.unref();
  for (const namespace of Object.values(options.rooms)) {
    namespace.wake(owns, 2 * sweepMs).catch((error: unknown) => console.error('[collab-rooms] waking alarms failed:', error));
  }

  return {
    server,
    async close() {
      draining = true;
      clearInterval(timer);
      const hosts = (await Promise.all(Object.values(options.rooms).map((ns) => ns.all()))).flat();
      for (const host of hosts) host.stop(1012, 'Restarting');
      // The rooms see their sockets close and checkpoint; wait for those writes.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await Promise.all(hosts.map((host) => host.quiet()));
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
