import { describe, expect, it } from 'vitest';
import type { BillingSubscriptionResponse } from '@/lib/api/domains/billing';
import {
  billingDetailsFromSettings,
  EMPTY_BILLING_DETAILS,
  formatBillingAddress,
  formatBillingAmount,
  hasPaidSubscription,
  toBillingDetailsPayload,
} from './billing-details';

const subscription = (patch: Partial<BillingSubscriptionResponse>): BillingSubscriptionResponse => ({
  id: 'sub_1',
  planId: 'plan_pro',
  planName: 'Pro',
  planSlug: 'pro',
  status: 'active',
  cycle: 'monthly',
  purchasedSeats: 5,
  usedSeats: 2,
  currentPeriodStart: '2026-10-01T00:00:00Z',
  currentPeriodEnd: '2026-11-01T00:00:00Z',
  cancelAtPeriodEnd: false,
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_stripe_1',
  paidPlanRequired: false,
  trialExpiredAt: null,
  scheduledDeletionAt: null,
  isLocked: false,
  ...patch,
});

describe('billingDetailsFromSettings', () => {
  it('reads the flat settings columns', () => {
    expect(
      billingDetailsFromSettings({
        email: 'billing@acme.nl',
        legalName: 'Acme B.V.',
        addressLine1: 'Keizersgracht 100',
        addressLine2: null,
        country: 'NL',
        city: 'Amsterdam',
        postalCode: '1015 AA',
        state: null,
        vatNumber: 'NL123456789B01',
      }),
    ).toEqual({
      email: 'billing@acme.nl',
      company: 'Acme B.V.',
      addressLine1: 'Keizersgracht 100',
      addressLine2: '',
      country: 'NL',
      city: 'Amsterdam',
      postalCode: '1015 AA',
      state: '',
      vatNumber: 'NL123456789B01',
    });
  });

  it('falls back to the trading name, and to empty details when nothing is saved', () => {
    expect(billingDetailsFromSettings({ tradingName: 'Acme' }).company).toBe('Acme');
    expect(billingDetailsFromSettings(null)).toEqual(EMPTY_BILLING_DETAILS);
  });
});

describe('toBillingDetailsPayload', () => {
  it('sends the flat fields PUT /api/workspace-settings stores, never a nested settings bag', () => {
    const payload = toBillingDetailsPayload({
      email: ' billing@acme.nl ',
      company: 'Acme B.V.',
      addressLine1: 'Keizersgracht 100',
      addressLine2: '',
      country: 'NL',
      city: 'Amsterdam',
      postalCode: '1015 AA',
      state: '  ',
      vatNumber: 'NL123456789B01',
    });
    expect(payload).toEqual({
      email: 'billing@acme.nl',
      legalName: 'Acme B.V.',
      addressLine1: 'Keizersgracht 100',
      addressLine2: null,
      country: 'NL',
      city: 'Amsterdam',
      postalCode: '1015 AA',
      state: null,
      vatNumber: 'NL123456789B01',
    });
    expect(payload).not.toHaveProperty('settings');
  });
});

describe('formatBillingAddress', () => {
  it('joins the parts that are set', () => {
    expect(formatBillingAddress({ addressLine1: 'Keizersgracht 100', city: 'Amsterdam', country: 'NL' })).toBe(
      'Keizersgracht 100, Amsterdam, NL',
    );
    expect(formatBillingAddress({ addressLine1: 'Keizersgracht 100', city: '', country: 'NL' })).toBe(
      'Keizersgracht 100, NL',
    );
    expect(formatBillingAddress({ addressLine1: '', city: 'Amsterdam', country: 'NL' })).toBe('');
  });
});

describe('formatBillingAmount', () => {
  it('formats in the UI language', () => {
    expect(formatBillingAmount(0, 'usd', 'en')).toBe('$0.00');
    expect(formatBillingAmount(1999, 'eur', 'en')).toBe('€19.99');
    // nl keeps its own conventions (narrow no-break space between symbol and amount).
    expect(formatBillingAmount(0, 'usd', 'nl').replace(/\s/g, ' ')).toBe('US$ 0,00');
  });

  it('defaults to EUR and survives an unknown currency code', () => {
    expect(formatBillingAmount(500, undefined, 'en')).toBe('€5.00');
    expect(formatBillingAmount(500, 'not-a-currency', 'en')).toBe('5.00 NOT-A-CURRENCY');
  });
});

describe('hasPaidSubscription', () => {
  it('is true for an active paid Stripe subscription, cancelling or not', () => {
    expect(hasPaidSubscription(subscription({}))).toBe(true);
    expect(hasPaidSubscription(subscription({ cancelAtPeriodEnd: true }))).toBe(true);
  });

  it('is false for the Free plan and without a Stripe subscription', () => {
    expect(
      hasPaidSubscription(
        subscription({ planSlug: 'free', stripeSubscriptionId: null, currentPeriodEnd: null }),
      ),
    ).toBe(false);
    expect(hasPaidSubscription(subscription({ stripeSubscriptionId: null }))).toBe(false);
    expect(hasPaidSubscription(subscription({ planSlug: 'free' }))).toBe(false);
  });

  it('is false when there is no active subscription', () => {
    expect(hasPaidSubscription(null)).toBe(false);
    expect(hasPaidSubscription(subscription({ status: 'canceled' }))).toBe(false);
  });
});
