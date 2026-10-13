/**
 * Stripe webhooks for the WeldReach inbox subscription: they update
 * workspace_app_access and never fall into the plan/seat/credit handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../test/fake-db';
import type { Env } from '../index';

const mocks = vi.hoisted(() => ({
  isPartnerStatementInvoice: vi.fn(),
  fakeDb: { current: null as unknown },
  fetch: vi.fn(),
}));

vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db')>()),
  getMasterDb: () => (mocks.fakeDb.current as FakeDb).db,
}));
vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  isPartnerStatementInvoice: mocks.isPartnerStatementInvoice,
}));

const { webhookRoutes } = await import('./webhooks');

const SECRET = 'whsec_test_secret';
const env = { STRIPE_BILLING_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test' } as unknown as Env;

async function post(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: 'evt_1', type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return webhookRoutes.request(
    '/',
    { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${hex}`, 'content-type': 'application/json' }, body },
    env,
  );
}

const accessRow = (over: Record<string, unknown> = {}) => ({
  id: 'waa_1',
  workspaceId: 'ws_1',
  appCode: 'weldreach',
  stripeSubscriptionId: 'sub_reach',
  billingStatus: 'active',
  billingStatusAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

const reachSubscription = (status: string) => ({
  id: 'sub_reach',
  customer: 'cus_ws',
  status,
  cancel_at_period_end: false,
  metadata: { type: 'weldreach', workspaceId: 'ws_1', appCode: 'weldreach' },
  items: { data: [{ id: 'si_1', price: { id: 'price_inbox', product: 'prod_inbox' }, quantity: 3 }] },
});

const reachInvoice = (over: Record<string, unknown> = {}) => ({
  id: 'in_reach',
  customer: 'cus_ws',
  subscription: 'sub_reach',
  billing_reason: 'subscription_cycle',
  metadata: {},
  amount_due: 1500,
  amount_paid: 0,
  total: 1500,
  currency: 'usd',
  status: 'open',
  ...over,
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
  mocks.fetch.mockRejectedValue(new Error('no Stripe call expected'));
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('customer.subscription.* for a WeldReach subscription', () => {
  it('mirrors an update onto the access row and nothing else', async () => {
    const fake = use({ selects: [[accessRow()]] });

    const res = await post('customer.subscription.updated', reachSubscription('past_due'));

    expect(res.status).toBe(200);
    expect(fake.written('update')).toHaveLength(1);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'past_due' });
    // one lookup and one write: no workspace plan, seats, credits or Clerk handling
    expect(fake.calls.map((c) => c.op)).toEqual(['select', 'update']);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('handles the created event the same way', async () => {
    const fake = use({ selects: [[accessRow({ stripeSubscriptionId: null, billingStatus: 'none' })]] });
    await post('customer.subscription.created', reachSubscription('active'));
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_reach', billingStatus: 'active' });
  });

  it('marks the access row canceled on deletion, without the phone/plan lookups', async () => {
    const fake = use({ selects: [[accessRow()]] });

    const res = await post('customer.subscription.deleted', reachSubscription('canceled'));

    expect(res.status).toBe(200);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'canceled' });
    expect(fake.calls.map((c) => c.op)).toEqual(['select', 'update']);
  });

  it('a plan subscription still goes through the plan handling', async () => {
    const fake = use({});
    await post('customer.subscription.updated', {
      id: 'sub_plan',
      customer: 'cus_ws',
      status: 'active',
      cancel_at_period_end: false,
      metadata: {},
      items: { data: [{ id: 'si_1', price: { id: 'price_1', product: 'prod_1' }, quantity: 5 }] },
    });
    // phone, agents and workspace lookups, which the WeldReach branch never makes
    expect(fake.calls.length).toBeGreaterThan(2);
  });
});

describe('invoice events for a WeldReach subscription', () => {
  it('invoice.payment_failed sets past_due and still records the invoice', async () => {
    const fake = use({ selects: [[accessRow()], [{ id: 'ws_1' }]] });

    const res = await post('invoice.payment_failed', reachInvoice());

    expect(res.status).toBe(200);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'past_due' });
    const inserts = fake.calls.filter((c) => c.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(fake.written('insert')[0]).toMatchObject({ stripeInvoiceId: 'in_reach', workspaceId: 'ws_1' });
  });

  it('invoice.paid sets active, records the invoice and grants no plan credits', async () => {
    const fake = use({
      selects: [
        [{ id: 'ws_1' }], // handleInvoiceUpsert: workspace by subscription or customer
        [accessRow({ billingStatus: 'past_due' })], // WeldReach row by subscription id
      ],
    });

    const res = await post('invoice.paid', reachInvoice({ status: 'paid', amount_paid: 1500 }));

    expect(res.status).toBe(200);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'active' });
    expect(fake.calls.map((c) => c.op)).toEqual(['select', 'insert', 'select', 'update']);
    // no retrieveSubscription / credit reset
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('a repeated payment failure answers 200 and writes no status change', async () => {
    const fake = use({ selects: [[accessRow({ billingStatus: 'past_due' })], [{ id: 'ws_1' }]] });

    const res = await post('invoice.payment_failed', reachInvoice());

    expect(res.status).toBe(200);
    expect(fake.written('update')).toEqual([]);
  });

  it('answers 500 when the status cannot be saved, so Stripe retries the webhook', async () => {
    mocks.fakeDb.current = {
      db: {
        select: () => {
          throw new Error('db down');
        },
      },
    };
    const res = await post('invoice.payment_failed', reachInvoice());
    expect(res.status).toBe(500);
  });
});
