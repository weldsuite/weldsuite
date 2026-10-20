import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalRateLimiter } from './portal-rate-limiter';
import worker, { PortalRateLimiter as ExportedLimiter } from '../index';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The slice of DurableObjectState / storage the object uses, with storage that yields like the real one. */
function fakeState(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const alarms: number[] = [];
  const storage = {
    get: async (key: string) => {
      await tick();
      return data.get(key);
    },
    put: async (key: string, value: unknown) => {
      data.set(key, value);
      await tick();
    },
    setAlarm: async (at: number) => {
      alarms.push(at);
      await tick();
    },
    deleteAll: async () => {
      data.clear();
      await tick();
    },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  };
  return { ctx: ctx as unknown as DurableObjectState, data, alarms };
}

async function createLimiter(initial?: Record<string, unknown>) {
  const state = fakeState(initial);
  const limiter = new PortalRateLimiter(state.ctx, {} as Cloudflare.Env);
  await tick(); // the constructor loads the stored window before serving
  await tick();
  return { limiter, ...state };
}

describe('PortalRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('lets exactly the cap through when called in parallel, and persists the final count', async () => {
    const { limiter, data, alarms } = await createLimiter();
    const verdicts = await Promise.all(Array.from({ length: 40 }, () => limiter.hit(5, 900)));

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(verdicts.filter((v) => !v.allowed)).toHaveLength(35);
    expect(data.get('window')).toMatchObject({ count: 5, windowMs: 900_000 });
    expect(alarms).toEqual([Date.now() + 900_000]);
  });

  it('keeps counting from the stored window after the object restarts', async () => {
    const windowStart = Date.now() - 60_000;
    const { limiter } = await createLimiter({ window: { count: 5, windowStart, windowMs: 900_000 } });
    const verdict = await limiter.hit(5, 900);
    expect(verdict.allowed).toBe(false);
    expect(verdict.resetAt).toBe(windowStart + 900_000);
  });

  it('wipes its storage from the alarm once the window is over', async () => {
    const { limiter, data } = await createLimiter();
    await limiter.hit(5, 900);
    expect(data.size).toBe(1);

    vi.setSystemTime(Date.now() + 899_000);
    await limiter.alarm();
    expect(data.size).toBe(1); // still inside the window

    vi.setSystemTime(Date.now() + 1_000);
    await limiter.alarm();
    expect(data.size).toBe(0);
    expect((await limiter.hit(5, 900)).count).toBe(1);
  });

  it('refuses a nonsensical limit instead of allowing everything', async () => {
    const { limiter } = await createLimiter();
    await expect(limiter.hit(0, 900)).rejects.toThrow(RangeError);
  });
});

describe('worker entry', () => {
  it('exports the Durable Object class that wrangler.toml binds', () => {
    expect(ExportedLimiter).toBe(PortalRateLimiter);
    expect(typeof worker.fetch).toBe('function');
  });
});
