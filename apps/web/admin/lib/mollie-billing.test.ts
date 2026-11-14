import { describe, expect, it } from 'vitest';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';
import {
  BILLING_CLI_PREFIX,
  billingCliCommands,
  isAbsoluteUrl,
  isStripeRow,
  mandateSummary,
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
    for (const kind of ['checkout', 'change', 'renewal', 'pay_link', 'mandate']) {
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
