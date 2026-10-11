/**
 * Seat limit of a partner-managed workspace: the licence's maxSeats, not the
 * plan's (docs/plans/reseller-licensing.md). Direct workspaces keep the plan rule.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const queue = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  // Every `select().from().where()` resolves the next queued result set.
  const db = {
    select: () => db,
    from: () => db,
    where: () => Promise.resolve(queue.rows.shift() ?? []),
  };
  return { ...actual, getMasterDb: () => db };
});
vi.mock('./member-count', () => ({ getAccurateMemberCount: vi.fn(async () => 4) }));
vi.mock('./clerk-seat-cap', () => ({ countPendingSeatInvitations: vi.fn(async () => 1) }));

import { getWorkspaceSeatLimit } from './seat-limits';
import type { Env } from '../types';

const env = { DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db' } as unknown as Env;

beforeEach(() => {
  queue.rows = [];
});

describe('getWorkspaceSeatLimit', () => {
  it('uses the licence seat cap for a partner workspace, ignoring the plan', async () => {
    queue.rows = [
      [{ id: 'ws_1', planId: 'pln_business', purchasedSeats: 0, billingMode: 'partner', partnerId: 'ptr_1' }],
      [{ maxSeats: 5 }],
      [{ name: 'Acme Reseller' }],
    ];
    expect(await getWorkspaceSeatLimit(env, 'org_1')).toEqual({
      limit: 5,
      current: 5, // 4 members + 1 pending invitation
      atLimit: true,
      planName: 'Licence',
      managedBy: 'Acme Reseller',
    });
  });

  it('is unlimited when the licence has no seat cap', async () => {
    queue.rows = [
      [{ id: 'ws_1', planId: 'pln_business', purchasedSeats: 0, billingMode: 'partner', partnerId: 'ptr_1' }],
      [{ maxSeats: null }],
      [{ name: 'Acme Reseller' }],
    ];
    const seats = await getWorkspaceSeatLimit(env, 'org_1');
    expect(seats).toMatchObject({ limit: null, atLimit: false, managedBy: 'Acme Reseller' });
  });

  it('is unlimited for a partner workspace without a licence row', async () => {
    queue.rows = [
      [{ id: 'ws_1', planId: null, purchasedSeats: 0, billingMode: 'partner', partnerId: 'ptr_1' }],
      [],
      [{ name: 'Acme Reseller' }],
    ];
    expect(await getWorkspaceSeatLimit(env, 'org_1')).toMatchObject({ limit: null, atLimit: false });
  });

  it('keeps the plan rule for a direct workspace', async () => {
    queue.rows = [
      [{ id: 'ws_1', planId: 'pln_business', purchasedSeats: 0, billingMode: 'direct', partnerId: null }],
      [{ name: 'Business', maxUsers: 10, pricePerUser: null, includedUsers: 1 }],
    ];
    expect(await getWorkspaceSeatLimit(env, 'org_1')).toEqual({
      limit: 10,
      current: 5,
      atLimit: false,
      planName: 'Business',
    });
  });

  it('is null for an unknown workspace', async () => {
    queue.rows = [[]];
    expect(await getWorkspaceSeatLimit(env, 'org_x')).toBeNull();
  });
});
