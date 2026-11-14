import { describe, expect, it } from 'vitest';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';
import type { MollieBillingAccount } from './billing-types';
import {
  BILLING_CLI_PREFIX,
  billingCliCommands,
  cycleLabel,
  isAbsoluteUrl,
  isStripeRow,
  mandateSummary,
  mollieAccountSummary,
  paymentKindLabel,
} from './mollie-billing';

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const en = mollieBillingCopyByLocale.en;

describe('Mollie billing copy', () => {
  const english = flatten(en);
  const dutch = new Map(flatten(mollieBillingCopyByLocale.nl));

  it('has a Dutch string for every English one, with the same placeholders', () => {
    for (const [key, text] of english) {
      const nl = dutch.get(key);
      expect(nl, key).toBeTruthy();
      expect(placeholders(nl as string), key).toEqual(placeholders(text));
    }
    expect(dutch.size).toBe(english.length);
  });

  it('has no empty strings', () => {
    for (const [key, text] of english) expect(text.trim(), key).not.toBe('');
  });

  it('labels every charge kind the Rust billing writes', () => {
    for (const kind of ['checkout', 'change', 'renewal', 'pay_link', 'mandate', 'credits']) {
      expect(paymentKindLabel(en, kind), kind).not.toBe(kind);
    }
  });
});

describe('billingCliCommands', () => {
  const commands = billingCliCommands('ws_123');

  it('lists the change commands with the workspace filled in, each needing --as and --reason', () => {
    const byKey = new Map(commands.map((c) => [c.key, c.args]));
    expect([...byKey.keys()]).toEqual(['show', 'comp', 'uncomp', 'refund', 'retryNow']);
    for (const key of ['comp', 'uncomp', 'retryNow'] as const) {
      expect(byKey.get(key)).toContain('ws_123');
      expect(byKey.get(key)).toContain('--as <email> --reason <text>');
    }
    expect(byKey.get('retryNow')).toMatch(/^retry-now ws_123 /);
    // A refund names the charge, not the workspace.
    expect(byKey.get('refund')).toMatch(/^refund <bpy_…\|tr_…> /);
    expect(byKey.get('show')).toBe('show ws_123');
  });

  it('runs in the server pod', () => {
    expect(BILLING_CLI_PREFIX).toBe('kubectl -n weldsuite exec deploy/weldsuite -- weldsuite admin billing');
  });

  it('has a description for every command', () => {
    for (const { key } of commands) expect(en.cli[key], key).toBeTruthy();
  });
});

describe('mandateSummary', () => {
  it('prefers the masked label, naming the method when the label does not', () => {
    expect(mandateSummary(en, { mandateLabel: 'Visa •••• 4242', mandateMethod: 'creditcard' })).toBe('Visa •••• 4242');
    expect(mandateSummary(en, { mandateLabel: 'NL91 •••• 4300', mandateMethod: 'directdebit' })).toBe(
      'NL91 •••• 4300 · SEPA Direct Debit',
    );
  });

  it('falls back to the method, then to none', () => {
    expect(mandateSummary(en, { mandateLabel: null, mandateMethod: 'paypal' })).toBe('PayPal');
    expect(mandateSummary(en, { mandateLabel: null, mandateMethod: 'klarna' })).toBe('klarna');
    expect(mandateSummary(en, { mandateLabel: null, mandateMethod: null })).toBe('None');
  });
});

describe('history rows', () => {
  it('treats only Stripe rows (and rows from before the provider column) as Stripe', () => {
    expect(isStripeRow({ provider: 'stripe' })).toBe(true);
    expect(isStripeRow({ provider: null })).toBe(true);
    expect(isStripeRow({ provider: 'mollie' })).toBe(false);
    expect(isStripeRow({ provider: 'weldbooks' })).toBe(false);
  });

  it('opens only absolute links, not a WeldBooks document path behind the platform API', () => {
    expect(isAbsoluteUrl('https://invoice.stripe.com/i/acct/inv')).toBe(true);
    expect(isAbsoluteUrl('/api/billing/invoices/binv_1/document')).toBe(false);
    expect(isAbsoluteUrl(null)).toBe(false);
  });

  it('labels an unknown charge kind readably', () => {
    expect(paymentKindLabel(en, 'seat_top_up')).toBe('seat top up');
    expect(paymentKindLabel(en, null)).toBeNull();
  });
});

describe('mollieAccountSummary', () => {
  const account: MollieBillingAccount = {
    customerId: 'cst_1',
    mandateId: 'mdt_1',
    mandateMethod: 'creditcard',
    mandateLabel: 'Visa •••• 4242',
    unitAmount: 4900,
    currency: 'EUR',
    anchorDay: 14,
    nextChargeAt: '2026-12-14T10:00:00.000Z',
    scheduled: null,
    pastDue: null,
  };

  it('prices the seat per cycle and names the billing day', () => {
    const monthly = mollieAccountSummary(en, account, 'monthly');
    expect(monthly.seatPrice).toBe('€49.00 per seat per month, excl. VAT');
    expect(monthly.nextCharge).toBe('14 Dec 2026');
    expect(monthly.billingDay).toBe('Day 14 of the month');
    expect(monthly.scheduled).toEqual([]);
    expect(monthly.pastDue).toBeNull();
    expect(mollieAccountSummary(en, account, 'yearly').seatPrice).toContain('per year');
  });

  it('shows a dash without a price, and no billing day without an anchor', () => {
    const bare = mollieAccountSummary(en, { ...account, unitAmount: null, anchorDay: null, nextChargeAt: null }, null);
    expect(bare.seatPrice).toBe('—');
    expect(bare.billingDay).toBeNull();
    expect(bare.nextCharge).toBe('—');
  });

  it('lists what changes at the period end', () => {
    const summary = mollieAccountSummary(
      en,
      { ...account, scheduled: { planId: 'plan_team', planName: 'Team', seats: 3, cycle: 'yearly' } },
      'monthly',
    );
    expect(summary.scheduled).toEqual([
      [en.scheduled.plan, 'Team'],
      [en.scheduled.seats, '3'],
      [en.scheduled.cycle, 'Yearly'],
    ]);
    const unnamed = mollieAccountSummary(
      en,
      { ...account, scheduled: { planId: 'plan_team', planName: null, seats: null, cycle: null } },
      'monthly',
    );
    expect(unnamed.scheduled).toEqual([[en.scheduled.plan, 'plan_team']]);
  });

  it('spells out a past-due account and its open charge', () => {
    const summary = mollieAccountSummary(
      en,
      {
        ...account,
        pastDue: {
          since: '2027-01-14T10:30:00.000Z',
          remindedAt: '2027-01-21T10:30:00.000Z',
          charge: {
            id: 'bpy_1',
            providerPaymentId: 'tr_1',
            amount: 12100,
            currency: null,
            status: 'failed',
            failureMessage: 'insufficient funds',
          },
        },
      },
      'monthly',
    );
    expect(summary.pastDue).toEqual({
      since: 'Past due since 14 Jan 2027.',
      charge: 'Open charge tr_1 (bpy_1): €121.00 (failed).',
      failure: 'Last failure: insufficient funds',
      reminded: 'Billing owners last reminded on 21 Jan 2027.',
    });
    const unrecorded = mollieAccountSummary(
      en,
      { ...account, pastDue: { since: '2027-01-14T10:30:00.000Z', remindedAt: null, charge: null } },
      'monthly',
    );
    expect(unrecorded.pastDue).toEqual({
      since: 'Past due since 14 Jan 2027.',
      charge: en.pastDue.noCharge,
      failure: null,
      reminded: null,
    });
  });

  it('labels the cycles, and keeps an unknown one', () => {
    expect(cycleLabel(en, 'monthly')).toBe('Monthly');
    expect(cycleLabel(en, 'yearly')).toBe('Yearly');
    expect(cycleLabel(en, 'weekly')).toBe('weekly');
  });
});
