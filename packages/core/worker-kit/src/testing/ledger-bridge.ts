/**
 * Conformance mode's outbound ledgers: a test's `OUTBOUND_LEDGER` and
 * `OUTBOUND_PLATFORM` Durable Object namespaces (the outbound guard's
 * per-workspace ledger and platform budget, ADR MAIL-006) served over HTTP,
 * so the Rust server's guard calls the same stubs and gets the same answers.
 * The Rust side is `rust/bins/weldsuite/src/conformance_mail.rs`.
 *
 *   POST /rpc { binding, name, method, args }
 *     → ns.get(ns.idFromName(name))[method](...args)
 *     200 { result }   (undefined → null)
 *     500 { error }    the stub threw
 *
 * Both sides' calls are recorded as `{ binding, name, method, args }` and
 * compared as a side effect, with what differs by construction masked: a
 * reservation id (the stub mints one per run) and a time near now.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/**
 * The namespaces the bridge serves. `DOC_ROOM` and `SHEET_ROOM` are the
 * collaborative rooms (rust/docs/collab-rooms.md: on Kubernetes the
 * collab-rooms service answers the same calls); `DOC_ENGINE` and
 * `SHEET_ENGINE` are the engine work a room-less route needs, a test's own
 * engine functions, which the TypeScript routes call in process: Rust's
 * calls to them are served but not recorded.
 */
export const LEDGER_BINDINGS = [
  'OUTBOUND_LEDGER',
  'OUTBOUND_PLATFORM',
  'PORTAL_RATE_LIMITER',
  'DOC_ROOM',
  'SHEET_ROOM',
  'DOC_ENGINE',
  'SHEET_ENGINE',
  // WeldPanel's collector: the daily salt and the per-workspace event counts.
  'PANEL_SALT',
  'PANEL_USAGE',
] as const;
type LedgerBinding = (typeof LEDGER_BINDINGS)[number];

/** Served to Rust, never compared: the TypeScript side runs the same functions in process. */
const UNRECORDED_BINDINGS: ReadonlySet<string> = new Set(['DOC_ENGINE', 'SHEET_ENGINE']);

/**
 * Bytes cross the bridge as `{ "$bytes": "<base64>" }`, both ways (an
 * export's file, an import's upload), as on the collab-rooms service.
 */
export function encodeBridgeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof ArrayBuffer) return { $bytes: Buffer.from(new Uint8Array(value)).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeBridgeValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBridgeValue(v)]));
  }
  return value;
}

/** The inverse of {@link encodeBridgeValue}. */
export function decodeBridgeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBridgeValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]![0] === '$bytes' && typeof entries[0]![1] === 'string') {
      return new Uint8Array(Buffer.from(entries[0]![1], 'base64'));
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, decodeBridgeValue(v)]));
  }
  return value;
}

/**
 * Namespaces whose calls are served but not compared: `PANEL_SALT.today()` is
 * a read an isolate caches for the day (the Worker calls it once per isolate,
 * the Rust server once per request in conformance), and its answer shows in
 * the rows both runs write.
 */
const UNCOMPARED = new Set<string>(['PANEL_SALT']);

interface NamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): Record<string, unknown>;
}

function isNamespaceLike(value: unknown): value is NamespaceLike {
  if (!value || typeof value !== 'object') return false;
  const ns = value as Record<string, unknown>;
  return typeof ns.idFromName === 'function' && typeof ns.get === 'function';
}

/** One call, as compared. */
export interface LedgerCall {
  binding: string;
  name: string;
  method: string;
  args: unknown;
}

const RESERVATION_METHODS = new Set(['commit', 'release']);
/**
 * Ids a request mints that reach a room call (a version's id in its key, a
 * restore's automatic version, a new sheet, a connected table's new tab):
 * new per run, so masked.
 */
const MINTED_ROOM_ID = /\b(?:docv|shtv|sht|shds|sh)_[0-9a-z]{12,}/g;
const ROOM_BINDINGS: ReadonlySet<string> = new Set(['DOC_ROOM', 'SHEET_ROOM']);
const NOW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** The call with its per-run values masked. */
function masked(call: LedgerCall): LedgerCall {
  const args = JSON.parse(JSON.stringify(call.args ?? [])) as unknown[];
  if (RESERVATION_METHODS.has(call.method) && typeof args[0] === 'string') args[0] = '<reservation>';
  const now = Date.now();
  const maskTimes = (value: unknown): unknown => {
    if (typeof value === 'number' && Math.abs(value - now) <= NOW_WINDOW_MS) return '<now>';
    if (Array.isArray(value)) return value.map(maskTimes);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskTimes(v)]));
    }
    return value;
  };
  const maskIds = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(MINTED_ROOM_ID, '<id>');
    if (Array.isArray(value)) return value.map(maskIds);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskIds(v)]));
    }
    return value;
  };
  const masked = maskTimes(args);
  return { ...call, args: ROOM_BINDINGS.has(call.binding) ? maskIds(masked) : masked };
}

const rustCalls: LedgerCall[] = [];

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

async function handle(env: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/rpc' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const call = (await readJson(req)) as LedgerCall;
  const ns = env[call.binding];
  if (!LEDGER_BINDINGS.includes(call.binding as LedgerBinding) || !isNamespaceLike(ns)) {
    res.writeHead(404).end();
    return;
  }
  if (!UNRECORDED_BINDINGS.has(call.binding) && !UNCOMPARED.has(call.binding)) rustCalls.push(masked(call));
  try {
    const stub = ns.get(ns.idFromName(call.name));
    const method = stub[call.method];
    if (typeof method !== 'function') throw new Error(`no RPC method ${call.method}`);
    const args = Array.isArray(call.args) ? (decodeBridgeValue(call.args) as unknown[]) : [];
    const result = encodeBridgeValue((await (method as (...a: unknown[]) => unknown).apply(stub, args)) ?? null);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result }));
  } catch (error) {
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** `{ OUTBOUND_LEDGER: url, … }` for the namespaces `env` has, or undefined. */
export async function ledgerUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const present = LEDGER_BINDINGS.filter((name) => isNamespaceLike(env[name]));
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
export function takeRustLedgerCalls(): LedgerCall[] {
  return rustCalls.splice(0);
}

/** `env` with its ledger namespaces recording the TypeScript run's calls. */
export function recordTypeScriptLedgerCalls(env: Record<string, unknown>): {
  env: Record<string, unknown>;
  finish: () => LedgerCall[];
} {
  if (!LEDGER_BINDINGS.some((binding) => isNamespaceLike(env[binding]))) return { env, finish: () => [] };
  const calls: LedgerCall[] = [];
  const wrapped: Record<string, unknown> = { ...env };
  for (const binding of LEDGER_BINDINGS) {
    const ns = env[binding];
    if (!isNamespaceLike(ns)) continue;
    wrapped[binding] = {
      idFromName: (name: string) => ({ name, id: ns.idFromName(name) }),
      get: (ref: { name: string; id: unknown }) => {
        const stub = ns.get(ref.id);
        return new Proxy(stub, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (typeof prop !== 'string' || typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (!UNCOMPARED.has(binding)) calls.push(masked({ binding, name: ref.name, method: prop, args }));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
      },
    };
  }
  return { env: wrapped, finish: () => calls.splice(0) };
}

/**
 * The calls in a stable order, by their fields rather than by the key order
 * each side wrote them in (Rust's JSON objects come with sorted keys).
 */
export function sortLedgerCalls(calls: LedgerCall[]): LedgerCall[] {
  const key = (call: LedgerCall) => JSON.stringify([call.binding, call.name, call.method, call.args]);
  return [...calls].sort((a, b) => key(a).localeCompare(key(b)));
}
