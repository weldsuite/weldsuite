/**
 * In-memory stand-ins for the PORTAL_RATE_LIMITER Durable Object namespace.
 *
 * They run the real counter logic (`RateLimitCounter`) over a store that yields
 * to the event loop on every operation, like Durable Object storage does, so
 * concurrent requests in a test interleave the way they do in production while
 * the arithmetic stays the code under test. Pass one as
 * `env.PORTAL_RATE_LIMITER` (cast to the binding type, as the tests do for KV).
 */

import {
  RateLimitCounter,
  type RateLimitCounterStore,
  type RateLimitNamespace,
  type RateLimitState,
} from '@weldsuite/commerce-domain/portal-tokens';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Writes land in call order (like a Durable Object's), then yield. */
class MemoryCounterStore implements RateLimitCounterStore {
  state: RateLimitState | undefined;
  alarmAt: number | null = null;

  async load(): Promise<RateLimitState | undefined> {
    await tick();
    return this.state;
  }

  async save(state: RateLimitState): Promise<void> {
    this.state = state;
    await tick();
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
    await tick();
  }

  async clear(): Promise<void> {
    this.state = undefined;
    this.alarmAt = null;
    await tick();
  }
}

export interface MemoryRateLimitNamespace extends RateLimitNamespace {
  /** The stored window of a limiter key (`rateLimitKey(...)`), if any. */
  peek(name: string): RateLimitState | undefined;
  /** Every limiter key that has a counter. */
  names(): string[];
}

export function createMemoryRateLimitNamespace(now: () => number = Date.now): MemoryRateLimitNamespace {
  const counters = new Map<string, { store: MemoryCounterStore; counter: RateLimitCounter; ready: Promise<void> }>();

  const entry = (name: string) => {
    let existing = counters.get(name);
    if (!existing) {
      const store = new MemoryCounterStore();
      const counter = new RateLimitCounter(store, now);
      existing = { store, counter, ready: counter.load() };
      counters.set(name, existing);
    }
    return existing;
  };

  return {
    idFromName: (name) => ({ name }) as unknown as DurableObjectId,
    get: (id) => {
      const { counter, ready } = entry((id as unknown as { name: string }).name);
      return {
        hit: async (max, windowSeconds) => {
          await ready;
          return counter.hit(max, windowSeconds);
        },
        release: async () => {
          await ready;
          await counter.release();
        },
      };
    },
    peek: (name) => counters.get(name)?.store.state,
    names: () => [...counters.keys()],
  };
}

/** A namespace whose counters cannot be reached (Durable Object error / outage). */
export function createUnreachableRateLimitNamespace(): RateLimitNamespace {
  return {
    idFromName: (name) => ({ name }) as unknown as DurableObjectId,
    get: () => ({
      hit: () => Promise.reject(new Error('Durable Object unreachable')),
      release: () => Promise.reject(new Error('Durable Object unreachable')),
    }),
  };
}
