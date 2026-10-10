/**
 * Comp plans and the admin billing API against a real (pglite) master DB:
 * the Stripe webhooks must leave a comped workspace's plan and seats alone,
 * the ended-subscription policy (moved out of the webhook) must behave as
 * before, and the comp sweep must end expired comps and renew comp credits.
 *
 * No Stripe or Clerk keys are set, so nothing here leaves the process.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db')>()),
  getMasterDb: () => state.db,
}));

import { webhookRoutes } from '../routes/webhooks';
import { adminRoutes } from '../routes/admin';
import { runCompSweep } from './comp-sweep';
import {
  AdminBillingError,
  adjustCredits,
  changeSubscription,
  endComp,
  grantComp,
  type AdminContext,
} from './admin-billing';
import type { Env } from '../index';

const { plans, workspaces, workspaceCredits, adminAuditEvents } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let db: any;

const WEBHOOK_SECRET = 'whsec_test_secret';
const ADMIN_SECRET = 'x'.repeat(40);
const env = { STRIPE_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET, BILLING_ADMIN_SECRET: ADMIN_SECRET } as Env;
const actor = { email: 'ops@weldsuite.org', userId: 'user_ops' };

const FREE = 'plan_t_free';
const BUSINESS = 'plan_t_business';
const PRO = 'plan_t_pro';

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;
  await db
    .insert(plans)
    .values([
      { id: FREE, name: 'Free', slug: 'free', priceMonthly: '0', monthlyCredits: 100, maxUsers: 3 },
      {
        id: BUSINESS,
        name: 'Business',
        slug: 'business',
        priceMonthly: '20',
        monthlyCredits: 1000,
        stripeProductId: 'prod_business',
        stripePriceIdMonthly: 'price_business_m',
      },
      {
        id: PRO,
        name: 'Pro',
        slug: 'pro',
        priceMonthly: '50',
        monthlyCredits: 5000,
        stripeProductId: 'prod_pro',
        stripePriceIdMonthly: 'price_pro_m',
      },
    ])
    .onConflictDoNothing();
});

async function makeWorkspace(overrides: Partial<typeof workspaces.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const id = `ws_comp_${seq}`;
  await db.insert(workspaces).values({
    id,
    name: `Workspace ${seq}`,
    slug: `ws-comp-${seq}`,
    planId: BUSINESS,
    purchasedSeats: 5,
    ...overrides,
  });
  return id;
}

async function load(id: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return row as typeof workspaces.$inferSelect;
}

const activeComp = () => ({ compGrantedAt: new Date(Date.now() - DAY), compGrantedBy: 'ops@weldsuite.org' });

function subscription(id: string, status: string, priceId = 'price_pro_m', quantity = 9) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    customer: `cus_${id}`,
    status,
    cancel_at_period_end: false,
    current_period_start: now,
    current_period_end: now + 30 * 86400,
    items: {
      data: [{ id: `si_${id}`, quantity, price: { id: priceId, product: 'prod_pro', recurring: { interval: 'month' } } }],
    },
    metadata: {},
  };
}

async function sendEvent(type: string, object: unknown): Promise<Response> {
  const body = JSON.stringify({ id: `evt_${type}_${seq}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return webhookRoutes.request(
    '/',
    { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${signature}`, 'content-type': 'application/json' } },
    env,
  );
}

function ctx(requestId = `req_${seq}_${Date.now()}`, ctxEnv: Env = env): AdminContext {
  return { env: ctxEnv, masterDb: db, actor, requestId, reason: 'integration test' };
}

/** Stripe stand-in: answers by path, records every call. */
function stubStripe(answer: (method: string, path: string) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname });
      const { status, body } = answer(method, url.pathname);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const stripeEnv = { ...env, STRIPE_SECRET_KEY: 'sk_test_integration' } as Env;
const stripeDown = { status: 500, body: { error: { message: 'Stripe is having a moment' } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Stripe webhooks and comp plans', () => {
  it('subscription.updated changes plan and seats for a paying workspace', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_paying' });
    const res = await sendEvent('customer.subscription.updated', subscription('sub_paying', 'active'));
    expect(res.status).toBe(200);
    const ws = await load(id);
    expect(ws.planId).toBe(PRO);
    expect(ws.purchasedSeats).toBe(9);
  });

  it('subscription.updated leaves a comped workspace on its comp plan and seats', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_comped', ...activeComp() });
    await sendEvent('customer.subscription.updated', subscription('sub_comped', 'past_due'));
    const ws = await load(id);
    expect(ws.planId).toBe(BUSINESS);
    expect(ws.purchasedSeats).toBe(5);
    expect(ws.subscriptionStatus).toBe('past_due');
  });

  it('subscription.deleted keeps the comp plan and only drops the subscription link', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_comped_del', subscriptionStatus: 'active', ...activeComp() });
    await sendEvent('customer.subscription.deleted', subscription('sub_comped_del', 'canceled'));
    const ws = await load(id);
    expect(ws.planId).toBe(BUSINESS);
    expect(ws.purchasedSeats).toBe(5);
    expect(ws.stripeSubscriptionId).toBeNull();
    expect(ws.subscriptionStatus).toBeNull();
    expect(ws.scheduledDeletionAt).toBeNull();
  });

  it('subscription.deleted still downgrades a grandfathered workspace to free', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_grandfathered' });
    await sendEvent('customer.subscription.deleted', subscription('sub_grandfathered', 'canceled'));
    const ws = await load(id);
    expect(ws.planId).toBe(FREE);
    expect(ws.purchasedSeats).toBe(0);
    expect(ws.subscriptionStatus).toBe('canceled');
  });

  it('subscription.deleted still starts the pay-or-delete grace period for new signups', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_new_policy', paidPlanRequired: true });
    await sendEvent('customer.subscription.deleted', subscription('sub_new_policy', 'canceled'));
    const ws = await load(id);
    expect(ws.stripeSubscriptionId).toBeNull();
    expect(ws.trialExpiredAt).not.toBeNull();
    const graceDays = (ws.scheduledDeletionAt!.getTime() - ws.trialExpiredAt!.getTime()) / DAY;
    expect(Math.round(graceDays)).toBe(30);
  });

  it('a paid checkout ends the comp', async () => {
    const id = await makeWorkspace({ ...activeComp(), compReason: 'partner' });
    await sendEvent('checkout.session.completed', {
      id: 'cs_test',
      mode: 'subscription',
      subscription: 'sub_from_checkout',
      customer: 'cus_checkout',
      metadata: { workspaceId: id, planId: PRO, seats: '4' },
    });
    const ws = await load(id);
    expect(ws.planId).toBe(PRO);
    expect(ws.purchasedSeats).toBe(4);
    expect(ws.compGrantedAt).toBeNull();
    expect(ws.compReason).toBeNull();
  });
});

describe('comp sweep', () => {
  it('ends an expired comp and applies the ended-subscription policy', async () => {
    const grandfathered = await makeWorkspace({ ...activeComp(), compEndsAt: new Date(Date.now() - 60_000) });
    const newPolicy = await makeWorkspace({
      ...activeComp(),
      compEndsAt: new Date(Date.now() - 60_000),
      paidPlanRequired: true,
    });

    const result = await runCompSweep(env, new Date(), db);
    expect(result.failed).toBe(0);
    expect(result.ended).toBeGreaterThanOrEqual(2);

    const a = await load(grandfathered);
    expect(a.compGrantedAt).toBeNull();
    expect(a.planId).toBe(FREE);
    const b = await load(newPolicy);
    expect(b.compGrantedAt).toBeNull();
    expect(b.scheduledDeletionAt).not.toBeNull();

    const [audit] = await db
      .select()
      .from(adminAuditEvents)
      .where(and(eq(adminAuditEvents.workspaceId, grandfathered), eq(adminAuditEvents.action, 'comp.expire')));
    expect(audit.outcome).toBe('success');
    expect(audit.actorEmail).toBe('system');
  });

  it('renews the monthly credits of an active comp exactly once per period', async () => {
    const id = await makeWorkspace({ ...activeComp() });
    const periodEnd = new Date(Date.now() - DAY);
    await db.insert(workspaceCredits).values({
      id: `wc_${id}`,
      workspaceId: id,
      currentBalance: 0,
      periodStart: new Date(periodEnd.getTime() - 30 * DAY),
      periodEnd,
    });

    await runCompSweep(env, new Date(), db);
    await runCompSweep(env, new Date(), db);

    const [wallet] = await db.select().from(workspaceCredits).where(eq(workspaceCredits.workspaceId, id));
    expect(wallet.currentBalance).toBe(1000);
    expect(wallet.periodEnd.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('admin billing service', () => {
  it('grants a comp: plan, seats, credits, and lifts the trial-expiry paywall', async () => {
    const id = await makeWorkspace({
      paidPlanRequired: true,
      subscriptionStatus: 'canceled',
      trialExpiredAt: new Date(Date.now() - 5 * DAY),
      scheduledDeletionAt: new Date(Date.now() + 25 * DAY),
    });
    const endsAt = new Date(Date.now() + 90 * DAY);
    const result = await grantComp(ctx(), id, { planId: PRO, seats: 12, endsAt, cancelStripeSubscription: false });
    expect(result.warnings).toEqual([]);

    const ws = await load(id);
    expect(ws.planId).toBe(PRO);
    expect(ws.purchasedSeats).toBe(12);
    expect(ws.compGrantedBy).toBe(actor.email);
    expect(ws.compEndsAt?.getTime()).toBe(endsAt.getTime());
    expect(ws.scheduledDeletionAt).toBeNull();
    expect(ws.trialExpiredAt).toBeNull();
    expect(ws.subscriptionStatus).toBeNull();

    const [wallet] = await db.select().from(workspaceCredits).where(eq(workspaceCredits.workspaceId, id));
    expect(wallet.monthlyAllocation).toBe(5000);
  });

  it('keeps an admin-scheduled deletion when granting a comp', async () => {
    const deleteAt = new Date(Date.now() + 10 * DAY);
    const id = await makeWorkspace({ scheduledDeletionAt: deleteAt, deletionRequestedBy: 'ops@weldsuite.org', isActive: false });
    await grantComp(ctx(), id, { planId: PRO, seats: 1, endsAt: null, cancelStripeSubscription: false });
    expect((await load(id)).scheduledDeletionAt?.getTime()).toBe(deleteAt.getTime());
  });

  it('refuses to change the subscription of a comped workspace', async () => {
    const id = await makeWorkspace({ ...activeComp() });
    await expect(
      changeSubscription(ctx(), id, { planId: PRO, cycle: 'monthly', seats: 5, proration: 'always_invoice' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<AdminBillingError>);
  });

  it('adjusts credits once per request id', async () => {
    const id = await makeWorkspace();
    const request = ctx('req_credit_once');
    const first = await adjustCredits(request, id, 250);
    const replay = await adjustCredits(request, id, 250);
    expect(first.newBalance).toBe(250);
    expect(replay.duplicate).toBe(true);
    expect(replay.newBalance).toBe(250);
    const removed = await adjustCredits(ctx('req_credit_remove'), id, -400);
    expect(removed.newBalance).toBe(-150);
  });
});

describe('Stripe lookup failures', () => {
  it('keeps the comp when the subscription lookup fails, so the comp can be ended later', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_lookup_fails', ...activeComp() });
    stubStripe(() => stripeDown);

    await expect(endComp(ctx(undefined, stripeEnv), id)).rejects.toThrow(/failed \(500\)/);

    const ws = await load(id);
    expect(ws.compGrantedAt).not.toBeNull();
    expect(ws.planId).toBe(BUSINESS);
    expect(ws.stripeSubscriptionId).toBe('sub_lookup_fails');
  });

  it('refuses to end a comp with a linked subscription when Stripe is not configured', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_no_key', ...activeComp() });
    await expect(endComp(ctx(), id)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect((await load(id)).compGrantedAt).not.toBeNull();
  });

  it('treats a subscription Stripe no longer has as ended', async () => {
    const id = await makeWorkspace({ stripeSubscriptionId: 'sub_gone', ...activeComp() });
    stubStripe(() => ({ status: 404, body: { error: { message: 'No such subscription' } } }));

    const result = await endComp(ctx(undefined, stripeEnv), id);
    expect(result.outcome).toBe('downgraded_to_free');
    const ws = await load(id);
    expect(ws.compGrantedAt).toBeNull();
    expect(ws.planId).toBe(FREE);
  });

  it('does not start a second subscription when the current one cannot be loaded', async () => {
    const id = await makeWorkspace({ stripeCustomerId: 'cus_lookup', stripeSubscriptionId: 'sub_flaky' });
    const calls = stubStripe((_method, path) =>
      path.startsWith('/v1/customers/')
        ? { status: 200, body: { id: 'cus_lookup', address: { country: 'NL' }, invoice_settings: {} } }
        : stripeDown,
    );

    await expect(
      changeSubscription(ctx(undefined, stripeEnv), id, {
        planId: PRO,
        cycle: 'monthly',
        seats: 5,
        proration: 'always_invoice',
        collectionMethod: 'send_invoice',
      }),
    ).rejects.toThrow(/failed \(500\)/);

    expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/subscriptions')).toBe(false);
    expect((await load(id)).stripeSubscriptionId).toBe('sub_flaky');
  });
});

describe('admin API audit trail', () => {
  it('records a refused change as a failure', async () => {
    const id = await makeWorkspace();
    const res = await adminRoutes.request(
      `/workspaces/${id}/comp/end`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'customer asked' }),
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': ADMIN_SECRET,
          'x-admin-email': actor.email,
          'x-request-id': 'req_end_comp_1',
        },
      },
      env,
    );
    expect(res.status).toBe(409);

    const [audit] = await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.workspaceId, id));
    expect(audit).toMatchObject({
      action: 'comp.end',
      outcome: 'failure',
      actorEmail: actor.email,
      reason: 'customer asked',
      error: 'This workspace has no comp plan',
    });
  });
});
