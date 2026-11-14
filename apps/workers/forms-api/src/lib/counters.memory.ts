/**
 * Tests only: an in-memory stand-in for the `FORM_COUNTERS` namespace. Each
 * form gets a `CounterRules` on a Map, and its calls are queued so they run one
 * at a time, as they do in the Durable Object.
 */

import { CounterRules, type CounterStore } from './counters';
import type { FormCounters } from '../durable-objects/form-counters';

export function memoryStore(): CounterStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>),
  };
}

// `Date.now()` looked up per call, not `Date.now` taken once: a test that fakes
// `Date` after building its world still reaches these counters.
export function memoryFormCounters(now: () => number = () => Date.now()): DurableObjectNamespace<FormCounters> {
  const forms = new Map<string, { rules: CounterRules; queue: Promise<unknown> }>();
  const serial = <T>(name: string, run: (rules: CounterRules) => Promise<T>): Promise<T> => {
    let form = forms.get(name);
    if (!form) {
      form = { rules: new CounterRules(memoryStore(), now), queue: Promise.resolve() };
      forms.set(name, form);
    }
    const target = form;
    const next = target.queue.then(() => run(target.rules));
    target.queue = next.catch(() => undefined);
    return next;
  };
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      recordView: (day: string, viewKey: string) => serial(id.name, (r) => r.recordView(day, viewKey)),
      viewsByDay: (from: string, to: string) => serial(id.name, (r) => r.viewsByDay(from, to)),
      rateLimit: (scope: string, limit: number, windowSeconds: number) =>
        serial(id.name, (r) => r.rateLimit(scope, limit, windowSeconds)),
      tries: (scope: string) => serial(id.name, (r) => r.tries(scope)),
      attempt: (scope: string, match: boolean) => serial(id.name, (r) => r.attempt(scope, match)),
    }),
  } as unknown as DurableObjectNamespace<FormCounters>;
}
