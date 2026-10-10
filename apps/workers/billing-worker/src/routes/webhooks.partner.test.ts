/**
 * Stripe webhooks and partner-managed workspaces (reseller licensing):
 * partner statement invoices are not workspace invoices, and a partner
 * workspace's own leftover subscription changes nothing about it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../test/fake-db';
import type { Env } from '../index';

const mocks = vi.hoisted(() => ({
  handlePartnerInvoicePaid: vi.fn(),
  handlePartnerInvoiceVoided: vi.fn(),
  isPartnerStatementInvoice: vi.fn(),
  applySubscriptionEnded: vi.fn(),
  fakeDb: { current: null as unknown },
}));

vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db')>()),
  getMasterDb: () => (mocks.fakeDb.current as FakeDb).db,
}));
vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  isPartnerStatementInvoice: mocks.isPartnerStatementInvoice,
}));
vi.mock('../services/partner-billing', () => ({
  handlePartnerInvoicePaid: mocks.handlePartnerInvoicePaid,
  handlePartnerInvoiceVoided: mocks.handlePartnerInvoiceVoided,
}));
vi.mock('../services/subscription-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/subscription-policy')>()),
  applySubscriptionEnded: mocks.applySubscriptionEnded,
}));

const { webhookRoutes } = await import('./webhooks');

const SECRET = 'whsec_test_secret';
const env = { STRIPE_BILLING_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test' } as unknown as Env;

async function post(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: 'evt_1', type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return webhookRoutes.request(
    '/',
    { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${hex}`, 'content-type': 'application/json' }, body },
    env,
  );
}

const partnerWorkspace = {
  id: 'ws_partner',
  clerkOrgId: 'org_p',
  planId: 'plan_business',
  billingMode: 'partner',
  stripeSubscriptionId: 'sub_old',
  compGrantedAt: null,
  compEndsAt: null,
  paidPlanRequired: false,
  isActive: true,
};

const subscription = (status: string) => ({
  id: 'sub_old',
  customer: 'cus_ws',
  status,
  cancel_at_period_end: false,
  metadata: {},
  items: { data: [{ id: 'si_1', price: { id: 'price_1', product: 'prod_1' }, quantity: 5 }] },
});

function use(script: Parameters<typeof createFakeDb>[0]) {
  mocks.fakeDb.current = createFakeDb(script);
  return mocks.fakeDb.current as FakeDb;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.isPartnerStatementInvoice.mockResolvedValue(false);
  mocks.handlePartnerInvoicePaid.mockResolvedValue(undefined);
  mocks.handlePartnerInvoiceVoided.mockResolvedValue(undefined);
});

describe('invoice.paid for a partner statement', () => {
  it('marks the statement paid (by metadata) and records no workspace invoice', async () => {
    const fake = use({});
    const res = await post('invoice.paid', {
      id: 'in_partner',
      customer: 'cus_partner',
      subscription: null,
      metadata: { kind: 'partner_statement', statementId: 'pst_1' },
      amount_due: 0,
      amount_paid: 37200,
      total: 37200,
      currency: 'usd',
      status: 'paid',
    });
    expect(res.status).toBe(200);
    expect(mocks.handlePartnerInvoicePaid).toHaveBeenCalledWith(expect.anything(), fake.db, 'in_partner');
    expect(fake.calls.filter((c) => c.op === 'insert')).toEqual([]);
  });

  it('recognises the invoice by the statement table when metadata is missing', async () => {
    mocks.isPartnerStatementInvoice.mockResolvedValue(true);
    const fake = use({});
    await post('invoice.paid', { id: 'in_partner', customer: 'cus_partner', subscription: null, metadata: {}, status: 'paid' });
    expect(mocks.isPartnerStatementInvoice).toHaveBeenCalledWith(fake.db, 'in_partner', 'cus_partner');
    expect(mocks.handlePartnerInvoicePaid).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when marking it paid fails, so Stripe retries the webhook', async () => {
    mocks.handlePartnerInvoicePaid.mockRejectedValue(new Error('db down'));
    use({});
    const res = await post('invoice.paid', { id: 'in_partner', customer: 'c', subscription: null, metadata: { kind: 'partner_statement' } });
    expect(res.status).toBe(500);
  });
});

describe('invoice.created / invoice.finalized for a partner statement', () => {
  it('is not written to billing_invoices', async () => {
    mocks.isPartnerStatementInvoice.mockResolvedValue(true);
    const fake = use({});
    const res = await post('invoice.finalized', { id: 'in_partner', customer: 'cus_partner', subscription: null, metadata: {} });
    expect(res.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });
});

describe('invoice.voided', () => {
  it('voids the statement when it is a partner invoice', async () => {
    mocks.isPartnerStatementInvoice.mockResolvedValue(true);
    const fake = use({});
    await post('invoice.voided', { id: 'in_partner', customer: 'cus_partner', metadata: {} });
    expect(mocks.handlePartnerInvoiceVoided).toHaveBeenCalledWith(expect.anything(), fake.db, 'in_partner');
  });

  it('ignores a workspace invoice', async () => {
    use({});
    await post('invoice.voided', { id: 'in_ws', customer: 'cus_ws', metadata: {} });
    expect(mocks.handlePartnerInvoiceVoided).not.toHaveBeenCalled();
  });
});

describe('subscription events for a partner-managed workspace', () => {
  it('customer.subscription.updated changes nothing', async () => {
    // isNonPlanSubscription: phone + agents lookups, then the workspace by subscription id.
    const fake = use({ selects: [[], [], [partnerWorkspace]] });
    const res = await post('customer.subscription.updated', subscription('active'));
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.op === 'update' || c.op === 'insert')).toEqual([]);
    expect(mocks.applySubscriptionEnded).not.toHaveBeenCalled();
  });

  it('customer.subscription.deleted only forgets the link: no pay-or-delete policy, no downgrade', async () => {
    const fake = use({ selects: [[], [partnerWorkspace]] });
    const res = await post('customer.subscription.deleted', subscription('canceled'));
    expect(res.status).toBe(200);
    expect(mocks.applySubscriptionEnded).not.toHaveBeenCalled();
    const updates = fake.written('update') as Array<Record<string, unknown>>;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ stripeSubscriptionId: null, subscriptionStatus: null });
    // Plan, seats and billing mode are not touched.
    expect(updates[0]).not.toHaveProperty('planId');
    expect(updates[0]).not.toHaveProperty('purchasedSeats');
    expect(updates[0]).not.toHaveProperty('billingMode');
  });

  it('a cancelled-status update on a partner workspace takes the same path', async () => {
    const fake = use({ selects: [[], [], [partnerWorkspace], [], [partnerWorkspace]] });
    await post('customer.subscription.updated', subscription('canceled'));
    expect(mocks.applySubscriptionEnded).not.toHaveBeenCalled();
    expect((fake.written('update') as Array<Record<string, unknown>>)[0]).toMatchObject({ stripeSubscriptionId: null });
  });

  it('checkout.session.completed does not move a partner workspace onto a direct plan', async () => {
    const fake = use({ selects: [[{ planId: 'plan_business', clerkOrgId: 'org_p', stripeSubscriptionId: null, billingMode: 'partner' }]] });
    const res = await post('checkout.session.completed', {
      id: 'cs_1',
      mode: 'subscription',
      subscription: 'sub_new',
      customer: 'cus_ws',
      metadata: { workspaceId: 'ws_partner', planId: 'plan_scale', seats: '3' },
    });
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.op === 'update')).toEqual([]);
  });

  it('invoice.paid on a leftover direct subscription grants no credits', async () => {
    // Invoice upsert (workspace by subscription), then the phone lookup, then the credit-sync workspace lookup.
    const fake = use({ selects: [[{ id: 'ws_partner' }], [], [partnerWorkspace]] });
    mocks.isPartnerStatementInvoice.mockResolvedValue(false);
    const res = await post('invoice.paid', {
      id: 'in_ws',
      customer: 'cus_ws',
      subscription: 'sub_old',
      billing_reason: 'subscription_cycle',
      metadata: {},
      status: 'paid',
    });
    // Without the partner guard this would go on to fetch the subscription from Stripe (and fail).
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.op === 'update')).toEqual([]);
  });
});
