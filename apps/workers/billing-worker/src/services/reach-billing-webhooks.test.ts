/**
 * Mapping of Stripe subscription / invoice events onto the WeldReach billing
 * status of `workspace_app_access`.
 */

import { describe, expect, it } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { StripeInvoice, StripeSubscription } from '../types/stripe';
import { mapStripeSubscriptionStatus } from './reach-billing';
import { handleReachInvoiceEvent, handleReachSubscriptionEvent } from './reach-billing-webhooks';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'waa_1',
  workspaceId: 'ws_1',
  appCode: 'weldreach',
  status: 'approved',
  stripeSubscriptionId: 'sub_1',
  billingStatus: 'active',
  billingStatusAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

const subscription = (status: string, over: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: 'sub_1',
  customer: 'cus_1',
  status,
  cancel_at_period_end: false,
  metadata: { type: 'weldreach', workspaceId: 'ws_1', appCode: 'weldreach' },
  items: { data: [{ id: 'si_1', price: { id: 'price_inbox', product: 'prod_inbox' }, quantity: 3 }] },
  ...over,
});

const invoice = (over: Record<string, unknown> = {}): StripeInvoice =>
  ({
    id: 'in_1',
    subscription: 'sub_1',
    billing_reason: 'subscription_cycle',
    customer: 'cus_1',
    number: null,
    amount_due: 1500,
    amount_paid: 0,
    total: 1500,
    currency: 'usd',
    status: 'open',
    invoice_pdf: null,
    hosted_invoice_url: null,
    metadata: {},
    ...over,
  }) as StripeInvoice;

describe('mapStripeSubscriptionStatus', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'active'],
    ['past_due', 'past_due'],
    ['unpaid', 'past_due'],
    ['canceled', 'canceled'],
    ['incomplete_expired', 'canceled'],
  ])('%s -> %s', (stripeStatus, expected) => {
    expect(mapStripeSubscriptionStatus(stripeStatus)).toBe(expected);
  });

  it.each(['incomplete', 'paused', 'something_new'])('leaves %s alone', (stripeStatus) => {
    expect(mapStripeSubscriptionStatus(stripeStatus)).toBeNull();
  });
});

describe('handleReachSubscriptionEvent', () => {
  it('is not a WeldReach subscription without the metadata type, and touches no table', async () => {
    const fake = createFakeDb();
    const handled = await handleReachSubscriptionEvent(fake.db, subscription('active', { metadata: {} }));
    expect(handled).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('is not a WeldReach subscription when it carries no metadata at all', async () => {
    const fake = createFakeDb();
    expect(await handleReachSubscriptionEvent(fake.db, subscription('active', { metadata: null }))).toBe(false);
  });

  it('moves active to past_due and stamps billingStatusAt', async () => {
    const fake = createFakeDb({ selects: [[row()]] });

    const handled = await handleReachSubscriptionEvent(fake.db, subscription('past_due'));

    expect(handled).toBe(true);
    const [update] = fake.written('update') as Array<Record<string, unknown>>;
    expect(update).toMatchObject({ billingStatus: 'past_due' });
    expect(update.billingStatusAt).toBeInstanceOf(Date);
    expect(update.billingStatusAt).not.toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('maps unpaid to past_due', async () => {
    const fake = createFakeDb({ selects: [[row()]] });
    await handleReachSubscriptionEvent(fake.db, subscription('unpaid'));
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'past_due' });
  });

  it('keeps billingStatusAt when the status did not change (a Stripe retry event)', async () => {
    const fake = createFakeDb({ selects: [[row({ billingStatus: 'past_due' })]] });

    const handled = await handleReachSubscriptionEvent(fake.db, subscription('past_due'));

    expect(handled).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });

  it('moves past_due back to active when Stripe recovers', async () => {
    const fake = createFakeDb({ selects: [[row({ billingStatus: 'past_due' })]] });
    await handleReachSubscriptionEvent(fake.db, subscription('active'));
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'active' });
  });

  it('marks a deleted (canceled) subscription canceled', async () => {
    const fake = createFakeDb({ selects: [[row()]] });
    await handleReachSubscriptionEvent(fake.db, subscription('canceled'));
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'canceled' });
  });

  it('does not revive a cancelled subscription with a late update event', async () => {
    const fake = createFakeDb({ selects: [[row({ billingStatus: 'canceled' })]] });
    const handled = await handleReachSubscriptionEvent(fake.db, subscription('past_due'));
    expect(handled).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });

  it('ignores a status it has no mapping for, but still counts as WeldReach', async () => {
    const fake = createFakeDb();
    expect(await handleReachSubscriptionEvent(fake.db, subscription('incomplete'))).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('finds the row through the workspace in the metadata and records the subscription id', async () => {
    const fake = createFakeDb({ selects: [[], [row({ stripeSubscriptionId: null, billingStatus: 'none' })]] });

    await handleReachSubscriptionEvent(fake.db, subscription('active'));

    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' });
  });

  it('ignores an event of a subscription the row no longer tracks', async () => {
    const fake = createFakeDb({ selects: [[], [row({ stripeSubscriptionId: 'sub_new', billingStatus: 'active' })]] });

    const handled = await handleReachSubscriptionEvent(fake.db, subscription('canceled', { id: 'sub_old' }));

    expect(handled).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });

  it('ignores a subscription without any access row', async () => {
    const fake = createFakeDb({ selects: [[], []] });
    expect(await handleReachSubscriptionEvent(fake.db, subscription('active'))).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });

  it('ignores a subscription whose metadata names no workspace and has no row by id', async () => {
    const fake = createFakeDb({ selects: [[]] });
    const handled = await handleReachSubscriptionEvent(
      fake.db,
      subscription('active', { metadata: { type: 'weldreach' } }),
    );
    expect(handled).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });
});

describe('handleReachInvoiceEvent', () => {
  it('payment failed -> past_due', async () => {
    const fake = createFakeDb({ selects: [[row()]] });

    const handled = await handleReachInvoiceEvent(fake.db, invoice(), 'failed');

    expect(handled).toBe(true);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'past_due' });
  });

  it('every Stripe retry of a failed payment leaves billingStatusAt alone', async () => {
    const fake = createFakeDb({ selects: [[row({ billingStatus: 'past_due' })]] });
    expect(await handleReachInvoiceEvent(fake.db, invoice(), 'failed')).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });

  it('paid -> active', async () => {
    const fake = createFakeDb({ selects: [[row({ billingStatus: 'past_due' })]] });
    expect(await handleReachInvoiceEvent(fake.db, invoice({ status: 'paid' }), 'paid')).toBe(true);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'active' });
  });

  it('a late paid event does not revive a cancelled subscription', async () => {
    const fake = createFakeDb({ selects: [[row({ billingStatus: 'canceled' })]] });
    expect(await handleReachInvoiceEvent(fake.db, invoice(), 'paid')).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });

  it('accepts the subscription as an expanded object', async () => {
    const fake = createFakeDb({ selects: [[row()]] });
    expect(await handleReachInvoiceEvent(fake.db, invoice({ subscription: { id: 'sub_1' } }), 'failed')).toBe(true);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'past_due' });
  });

  it('is not a WeldReach invoice without a subscription', async () => {
    const fake = createFakeDb();
    expect(await handleReachInvoiceEvent(fake.db, invoice({ subscription: null }), 'paid')).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('is not a WeldReach invoice for a plan subscription (no row by id, no WeldReach metadata)', async () => {
    const fake = createFakeDb({ selects: [[]] });
    expect(await handleReachInvoiceEvent(fake.db, invoice({ subscription: 'sub_plan' }), 'failed')).toBe(false);
    expect(fake.written('update')).toEqual([]);
  });

  it('recognises the invoice by the subscription metadata it carries when the row has no id yet', async () => {
    const fake = createFakeDb({
      selects: [[], [], [row({ stripeSubscriptionId: null, billingStatus: 'none' })]],
    });
    const withMetadata = invoice({
      subscription_details: { metadata: { type: 'weldreach', workspaceId: 'ws_1' } },
    });

    expect(await handleReachInvoiceEvent(fake.db, withMetadata, 'paid')).toBe(true);
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' });
  });

  it('reads the metadata from the invoice lines when subscription_details is absent', async () => {
    const fake = createFakeDb({
      selects: [[], [], [row({ stripeSubscriptionId: null, billingStatus: 'none' })]],
    });
    const withLines = invoice({
      lines: { data: [{ metadata: { type: 'weldreach', workspaceId: 'ws_1' } }] },
    });

    expect(await handleReachInvoiceEvent(fake.db, withLines, 'failed')).toBe(true);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'past_due' });
  });

  it('ignores a WeldReach invoice that has no access row', async () => {
    const fake = createFakeDb({ selects: [[], [], []] });
    const withMetadata = invoice({
      subscription_details: { metadata: { type: 'weldreach', workspaceId: 'ws_gone' } },
    });
    expect(await handleReachInvoiceEvent(fake.db, withMetadata, 'paid')).toBe(true);
    expect(fake.written('update')).toEqual([]);
  });
});
