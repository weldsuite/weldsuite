/**
 * Tests only: an in-memory stand-in for the `SIGN_CODE_ATTEMPTS` namespace.
 * Each link gets an `AttemptCounter` on a Map, and its calls are queued so they
 * run one at a time, as they do in the Durable Object.
 */

import { AttemptCounter, type AttemptStore } from '../services/codes';
import type { SignCodeAttempts } from './code-attempts';

export function memoryStore(): AttemptStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key),
  };
}

export function memoryCodeAttempts(now: () => number = Date.now): DurableObjectNamespace<SignCodeAttempts> {
  const links = new Map<string, { counter: AttemptCounter; queue: Promise<unknown> }>();
  const serial = <T>(name: string, run: (counter: AttemptCounter) => Promise<T>): Promise<T> => {
    let link = links.get(name);
    if (!link) {
      link = { counter: new AttemptCounter(memoryStore(), now), queue: Promise.resolve() };
      links.set(name, link);
    }
    const next = link.queue.then(() => run(link.counter));
    link.queue = next.catch(() => undefined);
    return next;
  };
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      tries: () => serial(id.name, (counter) => counter.tries()),
      attempt: (match: boolean) => serial(id.name, (counter) => counter.attempt(match)),
    }),
  } as unknown as DurableObjectNamespace<SignCodeAttempts>;
}
