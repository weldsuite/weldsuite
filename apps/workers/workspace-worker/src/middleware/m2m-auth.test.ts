/**
 * `m2mAuth()`: what the Clerk M2M guard caches, who it lets through, and what
 * it never logs. Clerk itself is stubbed; KV is an in-memory fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index';

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({ m2m: { verify } }),
}));

const TOKEN = 'mt_SuperSecretMachineTokenValue_0123456789';
const HOUR_MS = 3_600_000;

interface StoredEntry {
  value: string;
  ttl: number | undefined;
}

function fakeKv() {
  const store = new Map<string, StoredEntry>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: options?.expirationTtl });
    }),
  };
  return { kv: kv as unknown as KVNamespace, store, put: kv.put };
}

function verified(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mt_id',
    subject: 'mch_ops',
    scopes: ['mch_workspace_worker'],
    claims: null,
    revoked: false,
    revocationReason: null,
    expired: false,
    expiration: Date.now() + HOUR_MS,
    ...overrides,
  };
}

async function setup(envOverrides: Record<string, unknown> = {}) {
  // Fresh module state per test: the "warn once" flag lives in the module.
  vi.resetModules();
  const { m2mAuth } = await import('./m2m-auth');
  const { kv, store, put } = fakeKv();
  const env = {
    WORKSPACE_CACHE: kv,
    CLERK_SECRET_KEY: 'sk_test_x',
    CLERK_MACHINE_SECRET_KEY: 'ak_test_x',
    ENVIRONMENT: 'test',
    ...envOverrides,
  } as unknown as Env;

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const reached = vi.fn();
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', m2mAuth());
  app.post('/work', (c) => {
    reached();
    return c.json({ caller: c.get('m2m') });
  });

  return {
    store,
    put,
    reached,
    env,
    call: async (token: string | null = TOKEN, callEnv: Env = env) => {
      const res = await app.request(
        '/work',
        { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} },
        callEnv,
        ctx,
      );
      await Promise.all(pending);
      return res;
    },
  };
}

beforeEach(() => {
  verify.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('m2mAuth: verification', () => {
  it('rejects a request without a bearer token before calling Clerk', async () => {
    const t = await setup();
    const res = await t.call(null);
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    expect(t.reached).not.toHaveBeenCalled();
  });

  it('puts the verified machine on the context', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    const res = await t.call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: { machineId: string; scopes: string[]; expiresAt: number } };
    expect(body.caller.machineId).toBe('mch_ops');
    expect(body.caller.scopes).toEqual(['mch_workspace_worker']);
    expect(body.caller.expiresAt).toBeGreaterThan(Date.now());
    expect(verify).toHaveBeenCalledWith({ token: TOKEN, machineSecretKey: 'ak_test_x' });
  });

  it('rejects a token Clerk refuses, and caches nothing', async () => {
    verify.mockRejectedValue(new Error('Token is invalid'));
    const t = await setup();
    const res = await t.call();
    expect(res.status).toBe(401);
    expect(t.reached).not.toHaveBeenCalled();
    expect(t.put).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { revoked: true }],
    ['expired', { expired: true }],
    ['past its expiration', { expiration: Date.now() - 1000 }],
    ['without a subject', { subject: '' }],
  ])('rejects a token Clerk reports as %s', async (_label, overrides) => {
    verify.mockResolvedValue(verified(overrides));
    const t = await setup();
    const res = await t.call();
    expect(res.status).toBe(401);
    expect(t.reached).not.toHaveBeenCalled();
    expect(t.put).not.toHaveBeenCalled();
  });

  it('reads an expiration in seconds as seconds', async () => {
    const inOneHourSeconds = Math.floor((Date.now() + HOUR_MS) / 1000);
    verify.mockResolvedValue(verified({ expiration: inOneHourSeconds }));
    const t = await setup();
    const res = await t.call();
    const body = (await res.json()) as { caller: { expiresAt: number } };
    expect(body.caller.expiresAt).toBe(inOneHourSeconds * 1000);
  });

  it('accepts a token that never expires', async () => {
    verify.mockResolvedValue(verified({ expiration: null }));
    const t = await setup();
    const res = await t.call();
    expect(res.status).toBe(200);
    const [entry] = [...t.store.values()];
    expect(entry?.ttl).toBe(60);
    expect(JSON.parse(entry!.value).expiresAt).toBeNull();
  });
});

describe('m2mAuth: cache', () => {
  it('caches the machine identity, scopes and expiry as JSON, never the token', async () => {
    const expiration = Date.now() + HOUR_MS;
    verify.mockResolvedValue(verified({ expiration }));
    const t = await setup();
    await t.call();

    expect(t.store.size).toBe(1);
    const [[key, entry]] = [...t.store.entries()];
    expect(key.startsWith('m2m:v2:')).toBe(true);
    expect(key).not.toContain(TOKEN);
    expect(entry.value).not.toContain(TOKEN);
    expect(JSON.parse(entry.value)).toEqual({
      machineId: 'mch_ops',
      scopes: ['mch_workspace_worker'],
      expiresAt: expiration,
    });
  });

  it('caches for 60 seconds, not five minutes', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    await t.call();
    expect([...t.store.values()][0]?.ttl).toBe(60);
  });

  it('does not cache past the token expiry', async () => {
    // Expires in 30 s: a cache entry (KV minimum 60 s) would outlive the token.
    verify.mockResolvedValue(verified({ expiration: Date.now() + 30_000 }));
    const t = await setup();
    const first = await t.call();
    expect(first.status).toBe(200);
    expect(t.put).not.toHaveBeenCalled();

    // So the next request verifies again.
    await t.call();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('serves the second request from the cache, with the same identity', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    await t.call();
    const res = await t.call();
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { caller: { machineId: string } };
    expect(body.caller.machineId).toBe('mch_ops');
  });

  it('honours the token expiry on a cache hit', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    await t.call();

    const [key] = [...t.store.keys()];
    t.store.set(key!, {
      value: JSON.stringify({ machineId: 'mch_ops', scopes: [], expiresAt: Date.now() - 1 }),
      ttl: 60,
    });

    const res = await t.call();
    expect(res.status).toBe(401);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(t.reached).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable cache entry as a miss and verifies again', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    await t.call();
    const [key] = [...t.store.keys()];
    t.store.set(key!, { value: '1', ttl: 60 });

    const res = await t.call();
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('still answers when the cache is down', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    (t.env.WORKSPACE_CACHE.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
    (t.env.WORKSPACE_CACHE.put as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
    const res = await t.call();
    expect(res.status).toBe(200);
  });
});

describe('m2mAuth: machine allowlist', () => {
  it('lets an allowed machine through', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: 'mch_other, mch_ops' });
    const res = await t.call();
    expect(res.status).toBe(200);
  });

  it('refuses a verified token from a machine that is not allowed', async () => {
    verify.mockResolvedValue(verified({ subject: 'mch_stranger' }));
    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: 'mch_ops' });
    const res = await t.call();
    expect(res.status).toBe(403);
    expect(t.reached).not.toHaveBeenCalled();
  });

  it('applies the allowlist on a cache hit too', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: 'mch_ops' });
    expect((await t.call()).status).toBe(200);

    // The allowlist changes while the verification is still cached.
    const tightened = { ...t.env, M2M_ALLOWED_MACHINE_IDS: 'mch_someone_else' } as Env;
    const res = await t.call(TOKEN, tightened);
    expect(res.status).toBe(403);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('keeps today\'s behaviour when unset, with a single warning', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup();
    expect((await t.call()).status).toBe(200);
    expect((await t.call()).status).toBe(200);

    const warnings = vi
      .mocked(console.warn)
      .mock.calls.filter((args) => String(args[0]).includes('M2M_ALLOWED_MACHINE_IDS'));
    expect(warnings).toHaveLength(1);
  });

  it('treats a blank allowlist as unset', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: ' , ' });
    expect((await t.call()).status).toBe(200);
  });
});

describe('m2mAuth: logging', () => {
  it('never logs the token, a prefix of it or its length', async () => {
    verify
      .mockResolvedValueOnce(verified())
      .mockRejectedValueOnce(new Error('Token is invalid'))
      .mockResolvedValueOnce(verified({ subject: 'mch_stranger' }));

    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: 'mch_ops' });
    await t.call(); // verified, cache miss
    await t.call(); // cache hit
    await t.call('mt_another_token_that_clerk_rejects'); // verification failure
    await t.call(null); // no header
    await t.call('mt_stranger_machine_token_value'); // verified, machine refused

    const logged = [console.log, console.warn, console.error, console.info]
      .flatMap((spy) => vi.mocked(spy).mock.calls)
      .map((args) => args.map(String).join(' '))
      .join('\n');

    for (const secret of [TOKEN, TOKEN.slice(0, 10), 'mt_another_token', 'mt_stranger']) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toMatch(/length|starts with/i);
  });

  it('is silent on a successful call', async () => {
    verify.mockResolvedValue(verified());
    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: 'mch_ops' });
    await t.call();
    await t.call();
    for (const spy of [console.log, console.warn, console.error, console.info]) {
      expect(vi.mocked(spy)).not.toHaveBeenCalled();
    }
  });

  it('logs at most one line for a failed call', async () => {
    verify.mockRejectedValue(new Error('Token is invalid'));
    const t = await setup({ M2M_ALLOWED_MACHINE_IDS: 'mch_ops' });
    await t.call();
    const lines = [console.log, console.warn, console.error, console.info].flatMap((spy) => vi.mocked(spy).mock.calls);
    expect(lines).toHaveLength(1);
  });
});
