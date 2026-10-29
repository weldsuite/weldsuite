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

/** The namespaces the bridge serves. */
export const LEDGER_BINDINGS = ['OUTBOUND_LEDGER', 'OUTBOUND_PLATFORM'] as const;
type LedgerBinding = (typeof LEDGER_BINDINGS)[number];

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
  return { ...call, args: maskTimes(args) };
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
  rustCalls.push(masked(call));
  try {
    const stub = ns.get(ns.idFromName(call.name));
    const method = stub[call.method];
    if (typeof method !== 'function') throw new Error(`no RPC method ${call.method}`);
    const args = Array.isArray(call.args) ? call.args : [];
    const result = (await (method as (...a: unknown[]) => unknown).apply(stub, args)) ?? null;
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
              calls.push(masked({ binding, name: ref.name, method: prop, args }));
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
      },
    };
  }
  return { env: wrapped, finish: () => calls.splice(0) };
}

/** The calls in a stable order. */
export function sortLedgerCalls(calls: LedgerCall[]): LedgerCall[] {
  return [...calls].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
