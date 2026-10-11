import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';

const { managedSeatCap } = vi.hoisted(() => ({ managedSeatCap: vi.fn() }));
vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  managedSeatCap,
}));

const { calculateEffectiveSeatLimit, trySyncClerkSeatLimit } = await import('./clerk');

const perUserPlan = { maxUsers: null, pricePerUser: '12.00', includedUsers: 1 };
const cappedPlan = { maxUsers: 25, pricePerUser: null, includedUsers: null };

describe('calculateEffectiveSeatLimit', () => {
  it('keeps the plan rules for direct workspaces', () => {
    expect(calculateEffectiveSeatLimit(cappedPlan, 0, 3)).toBe(25);
    expect(calculateEffectiveSeatLimit(perUserPlan, 4, 2)).toBe(5);
    expect(calculateEffectiveSeatLimit(perUserPlan, 0, 7)).toBe(7);
    expect(calculateEffectiveSeatLimit({ maxUsers: null, pricePerUser: null, includedUsers: null }, 0, 3)).toBe(0);
  });

  it('uses the licence cap for a partner workspace, whatever the plan says', () => {
    expect(calculateEffectiveSeatLimit(cappedPlan, 0, 3, { maxSeats: 10 })).toBe(10);
    expect(calculateEffectiveSeatLimit(perUserPlan, 40, 30, { maxSeats: 5 })).toBe(5);
    expect(calculateEffectiveSeatLimit(null, 0, 0, { maxSeats: 3 })).toBe(3);
  });

  it('treats a null licence cap as unlimited (0 removes the cap in Clerk)', () => {
    expect(calculateEffectiveSeatLimit(cappedPlan, 0, 3, { maxSeats: null })).toBe(0);
    expect(calculateEffectiveSeatLimit(null, 0, 0, { maxSeats: null })).toBe(0);
  });
});

describe('trySyncClerkSeatLimit', () => {
  const env = { CLERK_SECRET_KEY: 'sk_clerk' } as Env;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const clerkBody = () => JSON.parse(fetchMock.mock.calls[0]![1].body as string);

  it('pushes the licence cap to Clerk for a partner workspace, with no plan at all', async () => {
    managedSeatCap.mockResolvedValue({ managed: true, maxSeats: 12 });
    await trySyncClerkSeatLimit(env, createFakeDb().db, 'org_1', 'ws_1', null, 0, 'test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.clerk.com/v1/organizations/org_1');
    expect(clerkBody()).toEqual({ max_allowed_memberships: 12 });
  });

  it('removes the Clerk cap when the licence has no seat limit', async () => {
    managedSeatCap.mockResolvedValue({ managed: true, maxSeats: null });
    await trySyncClerkSeatLimit(env, createFakeDb().db, 'org_1', 'ws_1', cappedPlan, 0, 'test');
    expect(clerkBody()).toEqual({ max_allowed_memberships: null });
  });

  it('syncs a direct workspace from its plan as before', async () => {
    managedSeatCap.mockResolvedValue({ managed: false });
    // getMemberCount asks Clerk for the memberships first, then the cap is written.
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{}, {}], total_count: 2 }) })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    await trySyncClerkSeatLimit(env, createFakeDb().db, 'org_1', 'ws_1', cappedPlan, 0, 'test');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({ max_allowed_memberships: 25 });
  });

  it('does nothing for a direct workspace without a plan', async () => {
    managedSeatCap.mockResolvedValue({ managed: false });
    await trySyncClerkSeatLimit(env, createFakeDb().db, 'org_1', 'ws_1', null, 0, 'test');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing without an org or a Clerk key', async () => {
    managedSeatCap.mockResolvedValue({ managed: true, maxSeats: 3 });
    await trySyncClerkSeatLimit(env, createFakeDb().db, null, 'ws_1', null, 0, 'test');
    await trySyncClerkSeatLimit({} as Env, createFakeDb().db, 'org_1', 'ws_1', null, 0, 'test');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
