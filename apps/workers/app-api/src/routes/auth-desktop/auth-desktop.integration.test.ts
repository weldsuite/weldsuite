/**
 * /api/auth-desktop (the desktop shell's sign-in handoff) with Clerk as a
 * fetch stub: the ticket, the allowed return targets, and Clerk failing.
 * Conformance-ready (rust/conformance/suites.json): Clerk's calls are compared
 * between the backends.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { clerkCalls, clerkError, stubClerk } from '../../test/fake-clerk';

vi.setConfig({ testTimeout: 120_000 });

// The session comes from the test context; the router's own Clerk check is skipped.
vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
// The SDK's requests, through the stubbed fetch (the SDK binds fetch at load).
vi.mock('@clerk/backend', async () => {
  const { clerkShim } = await import('../../test/fake-clerk');
  return { createClerkClient: () => clerkShim() };
});

import { authDesktopRoutes } from './index';

let tenantDb: Database;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ticket = (body: unknown) =>
  createTestApp('/api/auth-desktop', authDesktopRoutes, {
    // No workspace needed: a member may not have chosen one yet.
    context: { userId: 'user_desk', orgId: null, tenantDb },
  }).request('/api/auth-desktop/ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Clerk's sign-in tokens endpoint, answering with a fixed ticket. */
const clerkTickets = () =>
  stubClerk((method, path) =>
    method === 'POST' && path === '/sign_in_tokens'
      ? { status: 200, body: { object: 'sign_in_token', id: 'sit_1', token: 'tkt_desktop', status: 'pending' } }
      : undefined,
  );

describe('POST /api/auth-desktop/ticket', () => {
  it('mints a two-minute single-use ticket for the caller', async () => {
    const clerk = clerkTickets();
    const before = Date.now();
    const res = await ticket({});
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { ticket: string; expiresAt: number; returnTo: string } };
    expect(data).toMatchObject({ ticket: 'tkt_desktop', returnTo: 'weldsuite://auth' });
    expect(data.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(data.expiresAt).toBeLessThan(before + 125_000);
    expect(clerkCalls(clerk)).toEqual(['POST /sign_in_tokens']);
    const [, init] = clerk.mock.calls.find(([url]) => String(url).endsWith('/sign_in_tokens'))!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ user_id: 'user_desk', expires_in_seconds: 120 });
  });

  it('returns to a weldsuite:// target of the caller’s choosing', async () => {
    clerkTickets();
    const res = await ticket({ returnTo: 'weldsuite://auth/callback?next=%2Finbox' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { returnTo: string } }).data.returnTo).toBe(
      'weldsuite://auth/callback?next=%2Finbox',
    );
  });

  it('refuses any other scheme, so the ticket cannot leave the desktop shell', async () => {
    const clerk = clerkTickets();
    const res = await ticket({ returnTo: 'https://evil.example.com/steal' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'return_to scheme not allowed' } });
    expect(clerkCalls(clerk)).toEqual([]);
  });

  it('validates the body', async () => {
    clerkTickets();
    expect((await ticket({ returnTo: 'not a url' })).status).toBe(400);
    expect((await ticket({ returnTo: 42 })).status).toBe(400);
  });

  it('answers 500 when Clerk refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubClerk(() => clerkError(422, 'form_param_invalid'));
    const res = await ticket({});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Could not create desktop sign-in ticket' },
    });
  });
});
