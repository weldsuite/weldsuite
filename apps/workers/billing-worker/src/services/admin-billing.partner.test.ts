/** Direct-billing admin actions refuse partner-managed workspaces. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';

const { retrieveSubscriptionForAdmin } = vi.hoisted(() => ({ retrieveSubscriptionForAdmin: vi.fn() }));
vi.mock('../lib/stripe-admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe-admin')>()),
  retrieveSubscriptionForAdmin,
}));

const billing = await import('./admin-billing');

const managed = { id: 'ws_p', clerkOrgId: 'org_p', name: 'Managed', billingMode: 'partner', partnerId: 'ptr_a', deletedAt: null, stripeSubscriptionId: 'sub_1', planId: 'plan_x', purchasedSeats: 0, compGrantedAt: null, compEndsAt: null };

function ctx(workspace: unknown) {
  const { db, calls } = createFakeDb({ selects: [[workspace]] });
  return {
    calls,
    ctx: {
      env: { STRIPE_SECRET_KEY: 'sk_test' } as Env,
      masterDb: db,
      actor: { email: 'ops@weldsuite.org', userId: null },
      requestId: 'req_12345678',
      reason: 'because',
    } as Parameters<typeof billing.changeSubscription>[0],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('partner-managed workspaces in the admin billing actions', () => {
  const change = { planId: 'plan_x', cycle: 'monthly' as const, seats: 3, proration: 'none' as const };

  it.each([
    ['changeSubscription', (c: ReturnType<typeof ctx>['ctx']) => billing.changeSubscription(c, 'ws_p', change)],
    ['cancelSubscription', (c: ReturnType<typeof ctx>['ctx']) => billing.cancelSubscription(c, 'ws_p', 'immediately')],
    ['reactivateSubscription', (c: ReturnType<typeof ctx>['ctx']) => billing.reactivateSubscription(c, 'ws_p')],
    ['setTrialEnd', (c: ReturnType<typeof ctx>['ctx']) => billing.setTrialEnd(c, 'ws_p', new Date(Date.now() + 7 * 86_400_000))],
    ['applyDiscount', (c: ReturnType<typeof ctx>['ctx']) => billing.applyDiscount(c, 'ws_p', { percentOff: 10, duration: 'once' })],
    ['removeDiscount', (c: ReturnType<typeof ctx>['ctx']) => billing.removeDiscount(c, 'ws_p')],
    ['grantComp', (c: ReturnType<typeof ctx>['ctx']) => billing.grantComp(c, 'ws_p', { planId: 'plan_x', seats: 1, endsAt: null, cancelStripeSubscription: false })],
    ['endComp', (c: ReturnType<typeof ctx>['ctx']) => billing.endComp(c, 'ws_p')],
  ])('%s is refused with a pointer to the partner licence, and nothing is written', async (_name, run) => {
    const { ctx: c, calls } = ctx(managed);
    await expect(run(c)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('managed by a partner'),
    });
    expect(calls.filter((x) => x.op !== 'select')).toEqual([]);
    expect(retrieveSubscriptionForAdmin).not.toHaveBeenCalled();
  });

  it('the preview is refused too', async () => {
    const { ctx: c } = ctx(managed);
    await expect(billing.previewSubscriptionChange({ env: c.env, masterDb: c.masterDb }, 'ws_p', change)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
