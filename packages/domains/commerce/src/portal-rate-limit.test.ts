import { describe, expect, it, vi } from 'vitest';
import {
  applyRateLimitHit,
  consumeRateLimit,
  RATE_LIMIT_MAX,
  RATE_LIMIT_TTL_SECONDS,
  rateLimitKey,
  RateLimitCounter,
  type RateLimitCounterStore,
  type RateLimitNamespace,
  type RateLimitState,
} from './portal-rate-limit';

const WINDOW = 900;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Storage that yields on every operation, like a Durable Object's. Writes land in call order. */
class YieldingStore implements RateLimitCounterStore {
  state: RateLimitState | undefined;
  alarms: number[] = [];
  clears = 0;

  constructor(initial?: RateLimitState) {
    this.state = initial;
  }

  async load() {
    await tick();
    return this.state;
  }

  async save(state: RateLimitState) {
    this.state = state;
    await tick();
  }

  async setAlarm(at: number) {
    this.alarms.push(at);
    await tick();
  }

  async clear() {
    this.state = undefined;
    this.clears += 1;
    await tick();
  }
}

describe('applyRateLimitHit', () => {
  it('allows up to max hits in a window, then refuses without counting the refused ones', () => {
    let state: RateLimitState | null = null;
    const verdicts = [];
    for (let i = 0; i < 8; i++) {
      const out = applyRateLimitHit(state, 1_000 + i, 5, WINDOW);
      state = out.state;
      verdicts.push(out.verdict);
    }
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, true, true, false, false, false]);
    expect(verdicts.map((v) => v.remaining)).toEqual([4, 3, 2, 1, 0, 0, 0, 0]);
    expect(state?.count).toBe(5);
    expect(verdicts[0]!.resetAt).toBe(1_000 + WINDOW * 1000);
  });

  it('starts a new window once the old one is over', () => {
    const first = applyRateLimitHit(null, 0, 1, 10);
    expect(first.verdict.allowed).toBe(true);
    expect(applyRateLimitHit(first.state, 9_999, 1, 10).verdict.allowed).toBe(false);
    const later = applyRateLimitHit(first.state, 10_000, 1, 10);
    expect(later.verdict.allowed).toBe(true);
    expect(later.state.windowStart).toBe(10_000);
    expect(later.state.count).toBe(1);
  });

  it('keeps the window open when the clock steps backwards', () => {
    const first = applyRateLimitHit(null, 5_000, 1, 10);
    expect(applyRateLimitHit(first.state, 4_000, 1, 10).verdict.allowed).toBe(false);
  });

  it('rejects nonsensical limits instead of silently allowing everything', () => {
    expect(() => applyRateLimitHit(null, 0, 0, 10)).toThrow(RangeError);
    expect(() => applyRateLimitHit(null, 0, 1.5, 10)).toThrow(RangeError);
    expect(() => applyRateLimitHit(null, 0, Number.NaN, 10)).toThrow(RangeError);
    expect(() => applyRateLimitHit(null, 0, 5, 0)).toThrow(RangeError);
    expect(() => applyRateLimitHit(null, 0, 5, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('RateLimitCounter', () => {
  it('allows exactly the cap when many hits arrive at once', async () => {
    const store = new YieldingStore();
    const counter = new RateLimitCounter(store);
    await counter.load();

    const verdicts = await Promise.all(Array.from({ length: 60 }, () => counter.hit(7, WINDOW)));

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(7);
    expect(verdicts.filter((v) => !v.allowed)).toHaveLength(53);
    // What is persisted is the final count, not a stale intermediate one.
    expect(store.state?.count).toBe(7);
    // One alarm for the window, not one per hit.
    expect(store.alarms).toHaveLength(1);
  });

  it('allows exactly the cap for the 5 per 15 minutes request limit', async () => {
    const store = new YieldingStore();
    const counter = new RateLimitCounter(store);
    await counter.load();
    const verdicts = await Promise.all(
      Array.from({ length: 25 }, () => counter.hit(RATE_LIMIT_MAX, RATE_LIMIT_TTL_SECONDS)),
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(RATE_LIMIT_MAX);
  });

  it('picks up the stored window after the object was evicted and restarted', async () => {
    const now = () => 2_000;
    const stored: RateLimitState = { count: 5, windowStart: 1_000, windowMs: WINDOW * 1000 };
    const counter = new RateLimitCounter(new YieldingStore(stored), now);
    await counter.load();
    expect((await counter.hit(5, WINDOW)).allowed).toBe(false);
  });

  it('refused hits write nothing', async () => {
    const store = new YieldingStore();
    const counter = new RateLimitCounter(store);
    await counter.load();
    await counter.hit(1, WINDOW);
    const save = vi.spyOn(store, 'save');
    const setAlarm = vi.spyOn(store, 'setAlarm');
    await Promise.all([counter.hit(1, WINDOW), counter.hit(1, WINDOW), counter.hit(1, WINDOW)]);
    expect(save).not.toHaveBeenCalled();
    expect(setAlarm).not.toHaveBeenCalled();
  });

  it('sets the alarm for the end of the window, and again for each new window', async () => {
    let t = 10_000;
    const store = new YieldingStore();
    const counter = new RateLimitCounter(store, () => t);
    await counter.load();
    await counter.hit(2, 60);
    await counter.hit(2, 60);
    t += 60_000;
    await counter.hit(2, 60);
    expect(store.alarms).toEqual([10_000 + 60_000, 70_000 + 60_000]);
  });

  it('wipes the storage when the alarm fires after the window, and reschedules while it is still open', async () => {
    let t = 0;
    const store = new YieldingStore();
    const counter = new RateLimitCounter(store, () => t);
    await counter.load();
    await counter.hit(3, 60);

    t = 30_000;
    await counter.alarm();
    expect(store.clears).toBe(0);
    expect(store.alarms.at(-1)).toBe(60_000);
    expect(store.state?.count).toBe(1);

    t = 60_000;
    await counter.alarm();
    expect(store.clears).toBe(1);
    expect(store.state).toBeUndefined();
    // And the next hit starts clean.
    expect((await counter.hit(3, 60)).count).toBe(1);
  });
});

/** A fake Durable Object namespace: one RateLimitCounter per name. */
function fakeNamespace(): RateLimitNamespace & { calls: Array<{ name: string; max: number; windowSeconds: number }> } {
  const counters = new Map<string, Promise<RateLimitCounter>>();
  const calls: Array<{ name: string; max: number; windowSeconds: number }> = [];
  return {
    calls,
    idFromName: (name) => ({ name }) as unknown as DurableObjectId,
    get: (id) => {
      const name = (id as unknown as { name: string }).name;
      let counter = counters.get(name);
      if (!counter) {
        const created = new RateLimitCounter(new YieldingStore());
        counter = created.load().then(() => created);
        counters.set(name, counter);
      }
      return {
        hit: async (max, windowSeconds) => {
          calls.push({ name, max, windowSeconds });
          return (await counter).hit(max, windowSeconds);
        },
      };
    },
  };
}

describe('consumeRateLimit', () => {
  it('allows the cap and then reports limited, even for parallel callers', async () => {
    const env = { PORTAL_RATE_LIMITER: fakeNamespace() };
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(env, 'ws_1', 'ip:203.0.113.7', 5)),
    );
    expect(outcomes.filter((o) => o === 'allowed')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'limited')).toHaveLength(15);
  });

  it('uses the 5 per 15 minutes defaults and passes max and window to the counter', async () => {
    const ns = fakeNamespace();
    await consumeRateLimit({ PORTAL_RATE_LIMITER: ns }, 'ws_1', 'e:a@example.com');
    await consumeRateLimit({ PORTAL_RATE_LIMITER: ns }, 'ws_1', 'verify-ws', 200, 60);
    expect(ns.calls[0]).toMatchObject({ max: 5, windowSeconds: 900 });
    expect(ns.calls[1]).toMatchObject({ max: 200, windowSeconds: 60 });
  });

  it('keeps workspaces and keys apart', async () => {
    const env = { PORTAL_RATE_LIMITER: fakeNamespace() };
    expect(await consumeRateLimit(env, 'ws_1', 'ip:1.1.1.1', 1)).toBe('allowed');
    expect(await consumeRateLimit(env, 'ws_1', 'ip:1.1.1.1', 1)).toBe('limited');
    expect(await consumeRateLimit(env, 'ws_2', 'ip:1.1.1.1', 1)).toBe('allowed');
    expect(await consumeRateLimit(env, 'ws_1', 'ip:2.2.2.2', 1)).toBe('allowed');
  });

  it('treats the key case-insensitively and ignores surrounding whitespace', async () => {
    const env = { PORTAL_RATE_LIMITER: fakeNamespace() };
    expect(await consumeRateLimit(env, 'ws_1', 'e:Buyer@Example.com', 1)).toBe('allowed');
    expect(await consumeRateLimit(env, 'ws_1', ' e:buyer@example.com ', 1)).toBe('limited');
    expect(rateLimitKey('ws_1', ' E:X ')).toBe('cportal:rl:ws_1:e:x');
  });

  it('reports unavailable (so callers can fail closed) when the binding is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await consumeRateLimit({}, 'ws_1', 'ip:1.1.1.1')).toBe('unavailable');
    error.mockRestore();
  });

  it('reports unavailable when the Durable Object call fails, and when the limit is nonsense', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: RateLimitNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ hit: () => Promise.reject(new Error('boom')) }),
    };
    expect(await consumeRateLimit({ PORTAL_RATE_LIMITER: broken }, 'ws_1', 'ip:1.1.1.1')).toBe('unavailable');
    expect(await consumeRateLimit({ PORTAL_RATE_LIMITER: fakeNamespace() }, 'ws_1', 'x', 0)).toBe('unavailable');
    error.mockRestore();
  });
});
