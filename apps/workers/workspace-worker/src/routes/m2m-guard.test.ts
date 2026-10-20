/**
 * The workspace-worker routes that create Clerk orgs / databases and touch
 * every workspace are behind `m2mAuth()`: no token, a token Clerk refuses, or a
 * genuine token from a machine that is not on the allowlist never reaches the
 * handler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index';
import { onboardRoutes } from './onboard';
import { backfillMailRoutes } from './backfill-mail';

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({ m2m: { verify } }),
}));

const TOKEN = 'mt_route_guard_token_value_0123456789';

function env(allowed: string | undefined): Env {
  return {
    WORKSPACE_CACHE: { get: async () => null, put: async () => undefined } as unknown as KVNamespace,
    CLERK_SECRET_KEY: 'sk_test_x',
    CLERK_MACHINE_SECRET_KEY: 'ak_test_x',
    ENVIRONMENT: 'test',
    M2M_ALLOWED_MACHINE_IDS: allowed,
  } as unknown as Env;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

const routes = [
  { name: 'POST /api/onboard', call: (e: Env, headers: HeadersInit) => onboardRoutes.request('/', { method: 'POST', headers, body: '{}' }, e, ctx) },
  { name: 'POST /api/backfill/mail', call: (e: Env, headers: HeadersInit) => backfillMailRoutes.request('/mail', { method: 'POST', headers }, e, ctx) },
];

beforeEach(() => {
  verify.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(routes)('$name', ({ call }) => {
  it('answers 401 without a bearer token', async () => {
    expect((await call(env(undefined), {})).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it('answers 401 for a token Clerk refuses', async () => {
    verify.mockRejectedValue(new Error('Token is invalid'));
    expect((await call(env(undefined), { Authorization: `Bearer ${TOKEN}` })).status).toBe(401);
  });

  it('answers 403 for a genuine token of a machine that is not allowed', async () => {
    verify.mockResolvedValue({
      subject: 'mch_stranger',
      scopes: [],
      revoked: false,
      expired: false,
      expiration: Date.now() + 3_600_000,
    });
    const res = await call(env('mch_ops'), { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    expect(res.status).toBe(403);
  });
});
