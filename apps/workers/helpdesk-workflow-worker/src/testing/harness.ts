/**
 * Test doubles for the worker's bindings, shared by its tests and by the
 * Rust parity fixtures (`rust-fixtures.gen.ts`):
 *
 * - `fakeRealtime()`: a `REALTIME` service binding that records each
 *   `/publish/*` call as the realtime port names it (`{ channel, payload }`).
 * - `FakeWorkflowBinding`: `CONVERSATION_WORKFLOW` as Cloudflare's Workflow
 *   binding behaves: `create` makes an instance (a random id unless given),
 *   `get` throws for an id it never made, and an instance keeps the events
 *   sent to it until a `waitForEvent` of that type takes them.
 * - `FakeStep`: the `step` a run gets. `do` runs the callback (no retries),
 *   `sleep` records and returns, `waitForEvent` takes a kept event or parks
 *   until one is sent, and throws when the test times the wait out (as a
 *   Workflow's wait does).
 * - `fakeDurableNamespace()`: `ASSIGNMENT_ROUTER`, one AssignmentRouter per
 *   name over in-memory storage.
 */

import { AssignmentRouter } from '../durable-objects/assignment-router';
import { ConversationWorkflow, type ConversationWorkflowParams } from '../workflows/conversation-workflow';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export interface RecordedPublish {
  channel: string;
  payload: unknown;
}

/** The URL a `fetch` was called with. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A `REALTIME` binding that records what the worker publishes. */
export function fakeRealtime(): { binding: Fetcher; publishes: RecordedPublish[] } {
  const publishes: RecordedPublish[] = [];
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(requestUrl(input));
      const body = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
      const room = /^\/publish\/(conversation|support|chat)\/(.+)$/.exec(url.pathname);
      if (url.pathname === '/publish/workspace') {
        publishes.push({ channel: `workspace:${String(body.workspaceId)}`, payload: body });
      } else if (room) {
        publishes.push({ channel: `${room[1]}:${decodeURIComponent(room[2]!)}`, payload: body });
      } else {
        publishes.push({ channel: url.pathname, payload: body });
      }
      return Response.json({ ok: true });
    },
    connect() {
      throw new Error('not supported');
    },
  };
  return { binding: binding as unknown as Fetcher, publishes };
}

// ---------------------------------------------------------------------------
// Workflow binding and step
// ---------------------------------------------------------------------------

interface SentEvent {
  type: string;
  payload: unknown;
}

interface ParkedWait {
  type: string;
  resolve: (event: { payload: unknown; type: string; timestamp: Date }) => void;
  reject: (err: Error) => void;
}

/** One Workflow instance: its params and its event mailbox. */
export class FakeInstance {
  readonly sent: SentEvent[] = [];
  private readonly kept: SentEvent[] = [];
  private parked: ParkedWait | null = null;
  private parkListeners: Array<() => void> = [];

  constructor(
    readonly id: string,
    readonly params: ConversationWorkflowParams,
  ) {}

  async sendEvent(event: SentEvent): Promise<void> {
    const copy = JSON.parse(JSON.stringify(event)) as SentEvent;
    this.sent.push(copy);
    if (this.parked && this.parked.type === copy.type) {
      const wait = this.parked;
      this.parked = null;
      wait.resolve({ payload: copy.payload, type: copy.type, timestamp: new Date() });
      return;
    }
    this.kept.push(copy);
  }

  /** `step.waitForEvent`: a kept event of this type, or the next one sent. */
  waitFor(type: string): Promise<{ payload: unknown; type: string; timestamp: Date }> {
    const index = this.kept.findIndex((e) => e.type === type);
    if (index >= 0) {
      const [event] = this.kept.splice(index, 1);
      return Promise.resolve({ payload: event!.payload, type, timestamp: new Date() });
    }
    return new Promise((resolve, reject) => {
      this.parked = { type, resolve, reject };
      const listeners = this.parkListeners;
      this.parkListeners = [];
      for (const listener of listeners) listener();
    });
  }

  /** Resolves once the run is parked in a `waitForEvent`. */
  whenParked(): Promise<void> {
    if (this.parked) return Promise.resolve();
    return new Promise((resolve) => this.parkListeners.push(resolve));
  }

  /** Times the parked wait out: `waitForEvent` throws, as it does on Cloudflare. */
  timeOut(): void {
    const wait = this.parked;
    if (!wait) throw new Error('no wait is parked');
    this.parked = null;
    wait.reject(new Error(`waitForEvent timed out waiting for ${wait.type}`));
  }
}

/** `CONVERSATION_WORKFLOW`. */
export class FakeWorkflowBinding {
  readonly instances = new Map<string, FakeInstance>();
  private created = 0;

  async create(options?: { id?: string; params?: unknown }): Promise<{ id: string }> {
    this.created += 1;
    const id = options?.id ?? `wfi_${this.created}`;
    if (this.instances.has(id)) throw new Error(`instance.already_exists: ${id}`);
    const params = JSON.parse(JSON.stringify(options?.params ?? {})) as ConversationWorkflowParams;
    this.instances.set(id, new FakeInstance(id, params));
    return { id };
  }

  async get(id: string): Promise<FakeInstance> {
    const instance = this.instances.get(id);
    if (!instance) throw new Error('instance.not_found');
    return instance;
  }

  /** The instance `create` made last. */
  last(): FakeInstance {
    const all = [...this.instances.values()];
    const instance = all[all.length - 1];
    if (!instance) throw new Error('no instance was created');
    return instance;
  }
}

export type StepLogEntry =
  | { kind: 'do'; name: string }
  | { kind: 'sleep'; name: string; ms: number }
  | { kind: 'wait'; name: string; type: string; timeout: string };

/** The `step` of one run, recording what it was asked to do. */
export class FakeStep {
  readonly log: StepLogEntry[] = [];

  constructor(private readonly instance: FakeInstance) {}

  async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
    const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<T>;
    this.log.push({ kind: 'do', name });
    const value = await fn();
    // The journal keeps a step's result as JSON.
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  }

  async sleep(name: string, duration: number | string): Promise<void> {
    this.log.push({ kind: 'sleep', name, ms: Number(duration) });
  }

  async waitForEvent(name: string, options: { type: string; timeout?: string }): Promise<unknown> {
    this.log.push({ kind: 'wait', name, type: options.type, timeout: options.timeout ?? '' });
    return this.instance.waitFor(options.type);
  }
}

/** Runs one instance's workflow; resolves with what `run` returned, or rejects. */
export function runInstance(env: Env, instance: FakeInstance): { step: FakeStep; done: Promise<unknown> } {
  const step = new FakeStep(instance);
  const workflow = new ConversationWorkflow({} as never, env);
  const event = { payload: instance.params, instanceId: instance.id, timestamp: new Date() };
  const done = workflow.run(event as never, step as never);
  return { step, done };
}

// ---------------------------------------------------------------------------
// AssignmentRouter
// ---------------------------------------------------------------------------

/** An in-memory `DurableObjectState` storage. */
function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      const value = map.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
    },
  };
}

/** `ASSIGNMENT_ROUTER`: one AssignmentRouter per name, each with its own storage. */
export function fakeDurableNamespace(env: Partial<Env> = {}) {
  const objects = new Map<string, { router: AssignmentRouter; storage: ReturnType<typeof memoryStorage> }>();
  const namespace = {
    idFromName(name: string) {
      return { name, toString: () => name };
    },
    get(id: { name: string }) {
      let entry = objects.get(id.name);
      if (!entry) {
        const storage = memoryStorage();
        const router = new AssignmentRouter({ storage } as never, env as Env);
        entry = { router, storage };
        objects.set(id.name, entry);
      }
      return entry.router;
    },
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, objects };
}

// ---------------------------------------------------------------------------
// Env and requests
// ---------------------------------------------------------------------------

/** The worker's env with fakes for every binding the code paths read. */
export function testEnv(overrides: Partial<Env> = {}) {
  const realtime = fakeRealtime();
  const workflows = new FakeWorkflowBinding();
  const router = fakeDurableNamespace();
  const env = {
    ENVIRONMENT: 'test',
    REALTIME: realtime.binding,
    CONVERSATION_WORKFLOW: workflows as unknown as Workflow,
    ASSIGNMENT_ROUTER: router.namespace,
    ...overrides,
  } as Env;
  return { env, realtime, workflows, router };
}

/** A POST the way a service binding sends one (no public hostname). */
export function post(path: string, body: unknown): Request {
  return new Request(`https://helpdesk-workflow-worker${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
