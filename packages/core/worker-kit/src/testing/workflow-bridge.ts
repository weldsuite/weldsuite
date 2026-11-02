/**
 * Conformance mode's Workflow bindings: a test's `EXECUTE_SEQUENCE` (a fake
 * with `create` and `get`, the instances `get` answers having `sendEvent`)
 * served over HTTP, so the Rust server's routes start and wake runs on the
 * same fake and get the same answers. The Rust side is
 * `rust/bins/weldsuite/src/conformance_workflows.rs`.
 *
 *   POST /rpc { binding, method, id, args }
 *     create     → binding.create(args)               (args: { id, params })
 *     get        → binding.get(id)                     (the instance is kept)
 *     sendEvent  → (the kept instance).sendEvent(args) (args: { type, payload })
 *     200 { result: null } | 500 { error }   the fake threw
 *
 * Both runs' calls are compared as `workflows` side effects
 * (`{ binding, method, id, args }`). The TypeScript run calls the fake's
 * implementations without the test's mocks recording the call, so a test's
 * assertions on the fake (`toHaveBeenCalledTimes`, `mock.calls`) see Rust's
 * calls only, as its response is Rust's. A fake must therefore answer by
 * method and id (`vi.fn(impl)`, `mockImplementation`), never by call order
 * (`mockResolvedValueOnce`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

/** The Workflow bindings the bridge serves. */
export const WORKFLOW_BINDINGS = [
  'EXECUTE_SEQUENCE',
  'SEND_SCHEDULED_EMAIL',
  'WELDDATA_ENRICH',
  // WeldMeet: the recording copy, the meeting AI and the legacy backfill.
  'MEETING_RECORDING_COPY',
  'MEETING_AI',
  'MEETING_RECORDING_BACKFILL',
] as const;

interface WorkflowLike {
  create(options?: unknown): Promise<unknown>;
  get(id: string): Promise<unknown>;
}

function isWorkflowLike(value: unknown): value is WorkflowLike {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.create === 'function' && typeof binding.get === 'function';
}

/** One call, as compared. */
export interface WorkflowCall {
  binding: string;
  method: string;
  id: string | null;
  args: unknown;
}

function record(binding: string, method: string, id: unknown, args: unknown): WorkflowCall {
  return {
    binding,
    method,
    id: typeof id === 'string' ? id : null,
    args: args === undefined ? null : (JSON.parse(JSON.stringify(args)) as unknown),
  };
}

type Fn = (...args: unknown[]) => unknown;

/**
 * `fn.apply(thisArg, args)`, except that a vitest mock runs its
 * implementation without recording the call.
 */
async function silently(fn: unknown, thisArg: unknown, args: unknown[]): Promise<unknown> {
  if (typeof fn !== 'function') throw new TypeError('not a function');
  const mock = fn as { mock?: unknown; getMockImplementation?: () => Fn | undefined };
  if (mock.mock && typeof mock.getMockImplementation === 'function') {
    const impl = mock.getMockImplementation();
    return impl ? await impl.apply(thisArg, args) : undefined;
  }
  return await (fn as Fn).apply(thisArg, args);
}

const rustCalls: WorkflowCall[] = [];

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

async function handle(
  env: Record<string, unknown>,
  instances: Map<string, unknown>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/rpc' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const call = (await readJson(req)) as { binding: string; method: string; id?: string; args?: unknown };
  const binding = env[call.binding];
  if (!WORKFLOW_BINDINGS.includes(call.binding as (typeof WORKFLOW_BINDINGS)[number]) || !isWorkflowLike(binding)) {
    res.writeHead(404).end();
    return;
  }
  rustCalls.push(record(call.binding, call.method, call.id, call.args));
  const key = `${call.binding}:${call.id ?? ''}`;
  try {
    if (call.method === 'create') {
      await binding.create(call.args);
    } else if (call.method === 'get') {
      instances.set(key, await binding.get(call.id ?? ''));
    } else if (call.method === 'sendEvent' || call.method === 'terminate') {
      const instance = instances.get(key) as Record<string, unknown> | undefined;
      const method = instance?.[call.method];
      if (!instance || typeof method !== 'function') throw new Error('instance.not_found');
      await (method as Fn).call(instance, ...(call.method === 'sendEvent' ? [call.args] : []));
    } else {
      throw new Error(`no Workflow method ${call.method}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: null }));
  } catch (error) {
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

const bridges = new WeakMap<object, Promise<string>>();

/** `{ EXECUTE_SEQUENCE: url }` for the Workflow bindings `env` has, or undefined. */
export async function workflowUrls(env: Record<string, unknown>): Promise<Record<string, string> | undefined> {
  const present = WORKFLOW_BINDINGS.filter((name) => isWorkflowLike(env[name]));
  if (present.length === 0) return undefined;
  let url = bridges.get(env);
  if (!url) {
    const instances = new Map<string, unknown>();
    url = serveOnLoopback((req, res) => handle(env, instances, req, res));
    bridges.set(env, url);
  }
  const bridge = await url;
  return Object.fromEntries(present.map((name) => [name, bridge]));
}

/** What Rust called through the bridge since the last call, clearing it. */
export function takeRustWorkflowCalls(): WorkflowCall[] {
  return rustCalls.splice(0);
}

/** An instance whose `sendEvent` is recorded and runs silently. */
function recordedInstance(instance: unknown, binding: string, id: string, calls: WorkflowCall[]): unknown {
  if (!instance || typeof instance !== 'object') return instance;
  const target = instance as Record<string, unknown>;
  if (typeof target.sendEvent !== 'function' && typeof target.terminate !== 'function') return instance;
  return new Proxy(target, {
    get(object, prop, receiver) {
      const value = Reflect.get(object, prop, receiver) as unknown;
      if (prop === 'sendEvent') {
        return (event: unknown) => {
          calls.push(record(binding, 'sendEvent', id, event));
          return silently(value, object, [event]);
        };
      }
      if (prop === 'terminate') {
        return () => {
          calls.push(record(binding, 'terminate', id, undefined));
          return silently(value, object, []);
        };
      }
      return value;
    },
  });
}

/** `env` with its Workflow bindings recording the TypeScript run's calls. */
export function recordTypeScriptWorkflowCalls(env: Record<string, unknown>): {
  env: Record<string, unknown>;
  finish: () => WorkflowCall[];
} {
  if (!WORKFLOW_BINDINGS.some((binding) => isWorkflowLike(env[binding]))) return { env, finish: () => [] };
  const calls: WorkflowCall[] = [];
  const wrapped: Record<string, unknown> = { ...env };
  for (const binding of WORKFLOW_BINDINGS) {
    const target = env[binding];
    if (!isWorkflowLike(target)) continue;
    wrapped[binding] = {
      create: (options?: { id?: string }) => {
        calls.push(record(binding, 'create', options?.id, options));
        return silently(target.create, target, [options]);
      },
      get: async (id: string) => {
        calls.push(record(binding, 'get', id, undefined));
        return recordedInstance(await silently(target.get, target, [id]), binding, id, calls);
      },
    };
  }
  return { env: wrapped, finish: () => calls };
}

