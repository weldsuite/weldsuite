/**
 * Stripe-billed domain auto-renew helpers.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';
import {
  chargeAndRenewDomain,
  isDueForStripeAutoRenew,
  listDomainsDueForAutoRenew,
  renewalMeta,
  renewalPriceCents,
  storedInvoiceAppliesToExpiry,
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
      stripeRenewalProcessedInvoiceId: null,
      rtrRenewalProcessId: '99',
    });
  });

  it('returns nulls when metadata is missing', () => {
    expect(renewalMeta(null)).toEqual({
      stripeRenewalInvoiceId: null,
      stripeRenewalForExpiresAt: null,
      stripeRenewalProcessedInvoiceId: null,
      rtrRenewalProcessId: null,
    });
  });
});

describe('storedInvoiceAppliesToExpiry', () => {
  const expiresAt = new Date('2026-08-19T00:00:00.000Z');

  it('reuses the stored invoice only for the billed expiry', () => {
    expect(
      storedInvoiceAppliesToExpiry(
        renewalMeta({
          stripeRenewalInvoiceId: 'in_1',
          stripeRenewalForExpiresAt: '2026-08-19',
        }),
        expiresAt,
      ),
    ).toBe(true);
  });

  it('does not reuse an invoice raised for a previous expiry', () => {
    expect(
      storedInvoiceAppliesToExpiry(
        renewalMeta({
          stripeRenewalInvoiceId: 'in_old',
          stripeRenewalForExpiresAt: '2025-08-19',
        }),
        expiresAt,
      ),
    ).toBe(false);
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
  });

  it('retrieves the live invoice before adding items and finalizes with an idempotency key', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = String(init?.method ?? 'GET');
      if (method === 'POST' && path.endsWith('/v1/invoices')) {
        return { ok: true, json: async () => ({ id: 'in_1', status: 'open' }) };
      }
      if (method === 'GET' && path.endsWith('/v1/invoices/in_1')) {
        return { ok: true, json: async () => ({ id: 'in_1', status: 'open' }) };
      }
      return { ok: true, json: async () => ({ id: 'unexpected' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createDomainRenewalInvoice } = await import('../lib/stripe');
    const invoice = await createDomainRenewalInvoice('sk_test', {
      customerId: 'cus_1',
      amountCents: 1200,
      currency: 'usd',
      description: 'Domain renewal: example.com (1 year)',
      idempotencyKey: 'weldhost-renew:dom_1:2026-08-19',
      metadata: { kind: 'domain_renewal' },
    });

    expect(invoice.status).toBe('open');
    const paths = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
    expect(paths.some((p) => p.includes('GET ') && p.endsWith('/v1/invoices/in_1'))).toBe(true);
    expect(paths.some((p) => p.includes('/finalize'))).toBe(false);
  });
});

function stubMasterDb(): MasterDatabase {
  const pricing = [
    {
      tld: 'com',
      renewalPrice: '12.00',
      registrationPrice: '10.00',
      currency: 'USD',
      markupAmount: null,
      markupPercent: null,
      isActive: true,
    },
  ];
  const workspace = [{ stripeCustomerId: 'cus_1', clerkOrgId: 'org_1' }];
  return {
    select() {
      return {
        from(table: object) {
          const rows = 'tld' in table ? pricing : workspace;
          return {
            where() {
              const result = Promise.resolve(rows);
              return Object.assign(result, { limit: async () => rows });
            },
          };
        },
      };
    },
  } as never;
}

describe('chargeAndRenewDomain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('charges once then reuses the paid invoice without charging again', async () => {
    const domainId = generateId('dom');
    const expiresAt = daysFromNow(5);
    await db.insert(schema.hostDomains).values({
      id: domainId,
      name: 'renewme',
      tld: 'com',
      fullDomain: 'renewme.com',
      status: 'active',
      registrar: 'realtimeregister',
      autoRenew: true,
      expiresAt,
      registrationStatus: 'registered',
    });

    const renew = vi.fn(async () => ({
      status: 'completed' as const,
      domain: { expiresAt: '2027-08-19T00:00:00.000Z', status: ['OK'] },
    }));
    const rtr = { renew } as never;
    const masterDb = stubMasterDb();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = String(init?.method ?? 'GET');
      if (method === 'POST' && path.endsWith('/v1/invoices')) {
        return { ok: true, json: async () => ({ id: 'in_paid', status: 'draft' }) };
      }
      if (path.endsWith('/v1/invoices/in_paid') && method === 'GET') {
        return { ok: true, json: async () => ({ id: 'in_paid', status: 'draft' }) };
      }
      if (path.endsWith('/v1/invoiceitems')) {
        return { ok: true, json: async () => ({ id: 'ii_1' }) };
      }
      if (path.endsWith('/v1/invoices/in_paid/finalize')) {
        return { ok: true, json: async () => ({ id: 'in_paid', status: 'open' }) };
      }
      if (path.endsWith('/v1/invoices/in_paid/pay')) {
        return { ok: true, json: async () => ({ id: 'in_paid', status: 'paid' }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await chargeAndRenewDomain(db, rtr, masterDb, {
      domainId,
      workspaceId: 'org_1',
      stripeSecretKey: 'sk_test',
    });
    expect(first).toMatchObject({ ok: true, invoiceId: 'in_paid', renewed: true });
    expect(renew).toHaveBeenCalledTimes(1);
    const finalizeHeaders = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/finalize'))
      .map(([, init]) => init?.headers as Record<string, string> | undefined);
    expect(finalizeHeaders.some((h) => h?.['Idempotency-Key']?.endsWith(':finalize'))).toBe(true);

    const second = await chargeAndRenewDomain(db, rtr, masterDb, {
      domainId,
      workspaceId: 'org_1',
      stripeSecretKey: 'sk_test',
      alreadyPaidInvoiceId: 'in_paid',
    });
    expect(second).toEqual({ ok: false, reason: 'already_renewed' });
    expect(renew).toHaveBeenCalledTimes(1);

    const payCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/pay'));
    expect(payCalls).toHaveLength(1);
  });
});
