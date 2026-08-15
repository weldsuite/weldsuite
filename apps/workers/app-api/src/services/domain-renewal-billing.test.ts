/**
 * Stripe-billed domain auto-renew helpers.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import {
  isDueForStripeAutoRenew,
  listDomainsDueForAutoRenew,
  renewalMeta,
  renewalPriceCents,
} from './domain-renewal-billing';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const now = new Date('2026-08-14T12:00:00.000Z');

function daysFromNow(days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

describe('isDueForStripeAutoRenew', () => {
  const base = {
    autoRenew: true,
    status: 'active',
    registrar: 'realtimeregister',
    expiresAt: daysFromNow(10),
    deletedAt: null,
    registrationStatus: 'registered' as string | null,
  };

  it('selects RTR domains inside the 14-day window', () => {
    expect(isDueForStripeAutoRenew(base, now)).toBe(true);
  });

  it('selects domains that expired within the grace period', () => {
    expect(isDueForStripeAutoRenew({ ...base, status: 'expired', expiresAt: daysFromNow(-3) }, now)).toBe(true);
  });

  it('skips domains that expire too far out', () => {
    expect(isDueForStripeAutoRenew({ ...base, expiresAt: daysFromNow(40) }, now)).toBe(false);
  });

  it('skips domains with auto-renew off', () => {
    expect(isDueForStripeAutoRenew({ ...base, autoRenew: false }, now)).toBe(false);
  });

  it('skips Cloudflare Registrar domains (no renew API)', () => {
    expect(isDueForStripeAutoRenew({ ...base, registrar: 'cloudflare' }, now)).toBe(false);
  });

  it('always includes in-flight registrar renewals', () => {
    expect(
      isDueForStripeAutoRenew(
        { ...base, registrationStatus: 'pending_renewal', expiresAt: daysFromNow(40) },
        now,
      ),
    ).toBe(true);
  });
});

describe('renewalMeta', () => {
  it('reads invoice tracking fields off domain metadata', () => {
    expect(
      renewalMeta({
        stripeRenewalInvoiceId: 'in_123',
        stripeRenewalForExpiresAt: '2027-08-01',
        rtrRenewalProcessId: '99',
      }),
    ).toEqual({
      stripeRenewalInvoiceId: 'in_123',
      stripeRenewalForExpiresAt: '2027-08-01',
      rtrRenewalProcessId: '99',
    });
  });

  it('returns nulls when metadata is missing', () => {
    expect(renewalMeta(null)).toEqual({
      stripeRenewalInvoiceId: null,
      stripeRenewalForExpiresAt: null,
      rtrRenewalProcessId: null,
    });
  });
});

describe('renewalPriceCents', () => {
  it('uses catalog renewalPrice when wholesale is absent', () => {
    expect(
      renewalPriceCents({
        tld: 'com',
        pricing: {
          renewalPrice: '15.50',
          registrationPrice: '10.00',
          currency: 'USD',
          markupAmount: null,
          markupPercent: null,
        } as never,
      }),
    ).toBe(1550);
  });

  it('applies markup to the authored catalog renewalPrice', () => {
    expect(
      renewalPriceCents({
        tld: 'com',
        pricing: {
          renewalPrice: '11.00',
          registrationPrice: '10.00',
          currency: 'USD',
          markupAmount: 200,
          markupPercent: null,
        } as never,
      }),
    ).toBe(1300);
  });

  it('returns null without a catalog row', () => {
    expect(renewalPriceCents({ tld: 'com', pricing: undefined })).toBeNull();
  });
});

describe('listDomainsDueForAutoRenew', () => {
  it('returns only auto-renew RTR domains inside the window', async () => {
    const dueId = generateId('dom');
    const skipId = generateId('dom');
    const farId = generateId('dom');

    await db.insert(schema.hostDomains).values([
      {
        id: dueId,
        name: 'due',
        tld: 'com',
        fullDomain: 'due.com',
        status: 'active',
        registrar: 'realtimeregister',
        autoRenew: true,
        expiresAt: daysFromNow(5),
        registrationStatus: 'registered',
      },
      {
        id: skipId,
        name: 'off',
        tld: 'com',
        fullDomain: 'off.com',
        status: 'active',
        registrar: 'realtimeregister',
        autoRenew: false,
        expiresAt: daysFromNow(5),
        registrationStatus: 'registered',
      },
      {
        id: farId,
        name: 'far',
        tld: 'com',
        fullDomain: 'far.com',
        status: 'active',
        registrar: 'realtimeregister',
        autoRenew: true,
        expiresAt: daysFromNow(200),
        registrationStatus: 'registered',
      },
    ]);

    const rows = await listDomainsDueForAutoRenew(db, now);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(skipId);
    expect(ids).not.toContain(farId);
  });
});

describe('createDomainCheckoutSession saves the card for later renewals', () => {
  it('sets payment_intent_data[setup_future_usage]=off_session', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => ({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { createDomainCheckoutSession } = await import('../lib/stripe');
    await createDomainCheckoutSession('sk_test', {
      customerId: 'cus_1',
      lineItems: [{ name: 'example.com', unitAmountCents: 1200, currency: 'usd' }],
      successUrl: 'https://app.example/ok',
      cancelUrl: 'https://app.example/cancel',
      metadata: { kind: 'domain_registration' },
    });

    const body = decodeURIComponent(String(fetchMock.mock.calls[0]?.[1]?.body ?? ''));
    expect(body).toContain('payment_intent_data[setup_future_usage]=off_session');
    expect(body).toContain('mode=payment');

    vi.unstubAllGlobals();
  });
});
