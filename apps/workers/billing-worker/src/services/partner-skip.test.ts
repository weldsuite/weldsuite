/** Partner-managed workspaces never enter the direct-billing paths. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';

const { isPartnerManagedWorkspace, grantCredits } = vi.hoisted(() => ({
  isPartnerManagedWorkspace: vi.fn(),
  grantCredits: vi.fn(),
}));
vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  isPartnerManagedWorkspace,
}));
vi.mock('@weldsuite/credits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/credits')>()),
  grantCredits,
}));

const { updateSubscriptionCredits } = await import('./credits');
const { applySubscriptionEnded } = await import('./subscription-policy');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('updateSubscriptionCredits (plan credit grants)', () => {
  it('grants nothing to a partner-managed workspace, on renewal or on a plan change', async () => {
    isPartnerManagedWorkspace.mockResolvedValue(true);
    const { db, calls } = createFakeDb();

    const renewal = await updateSubscriptionCredits(db, 'ws_p', {
      planCredits: 5000,
      subscribedCredits: 0,
      resetPeriod: true,
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
    });
    const change = await updateSubscriptionCredits(db, 'ws_p', { planCredits: 9000, subscribedCredits: 0 });

    expect(renewal).toMatchObject({ skipped: 'partner_managed', allocationChange: 0 });
    expect(change).toMatchObject({ skipped: 'partner_managed', allocationChange: 0 });
    expect(grantCredits).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('applySubscriptionEnded (pay-or-delete / free downgrade policy)', () => {
  const env = {} as Env;
  const base = { id: 'ws_p', clerkOrgId: 'org_p', paidPlanRequired: true, isActive: true, trialExpiredAt: null, scheduledDeletionAt: null, stripeCustomerId: null };

  it('never schedules deletion or downgrades a partner-managed workspace', async () => {
    const { db, calls } = createFakeDb();
    const outcome = await applySubscriptionEnded(env, db, { ...base, billingMode: 'partner' } as never);
    expect(outcome).toBe('skipped_partner');
    expect(calls).toEqual([]);
  });

  it('still applies the policy to a direct workspace', async () => {
    const { db, written } = createFakeDb();
    const outcome = await applySubscriptionEnded(env, db, { ...base, billingMode: 'direct' } as never);
    expect(outcome).toBe('grace_period');
    expect(written('update')[0]).toMatchObject({ subscriptionStatus: 'canceled', stripeSubscriptionId: null });
    expect((written('update')[0] as { scheduledDeletionAt: Date }).scheduledDeletionAt).toBeInstanceOf(Date);
  });
});
