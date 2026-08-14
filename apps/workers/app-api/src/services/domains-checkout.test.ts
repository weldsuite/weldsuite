/**
 * Domain checkout: silent Stripe customer creation.
 *
 * `c.get('workspaceId')` is the Clerk org id. Looking up the workspace by
 * `workspaces.id` used to miss the row entirely and surface
 * "Workspace has no Stripe customer — complete billing setup first".
 * Checkout must find the workspace by org id and create a Stripe customer
 * when one is missing, then proceed.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '../db';
import type { RealtimeRegistrar } from '@weldsuite/realtime-registrar';

vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/stripe')>();
  return {
    ...actual,
    createStripeCustomer: vi.fn(),
    createDomainCheckoutSession: vi.fn(),
  };
});

import { createStripeCustomer, createDomainCheckoutSession } from '../lib/stripe';
import { createCheckout, domainsFromCheckoutInput, MAX_CHECKOUT_DOMAINS } from './domains';

const mockedCreateCustomer = createStripeCustomer as ReturnType<typeof vi.fn>;
const mockedCreateSession = createDomainCheckoutSession as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreateCustomer.mockResolvedValue({ id: 'cus_created' });
  mockedCreateSession.mockResolvedValue({
    id: 'cs_test_1',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  });
});

function availableRtr(): RealtimeRegistrar {
  return {
    checkDomains: vi.fn(async (requested: string[]) =>
      requested.map((name) => ({
        name,
        available: true,
        premium: false,
        priceCents: 1200,
        currency: 'usd',
      })),
    ),
  } as unknown as RealtimeRegistrar;
}

function masterDbStub(opts: {
  workspace: {
    id: string;
    name: string;
    clerkOrgId: string | null;
    stripeCustomerId: string | null;
  } | null;
  onUpdate?: (values: Record<string, unknown>) => void;
}): MasterDatabase {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const isPricing = table === masterSchema.hostDomainPricing;
          const rows = isPricing ? [] : opts.workspace ? [opts.workspace] : [];
          const thenable = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>;
          };
          thenable.limit = async () => rows;
          return thenable;
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          opts.onUpdate?.(values);
        },
      }),
    }),
  } as unknown as MasterDatabase;
}

const checkoutParams = {
  workspaceId: 'org_test_default',
  stripeSecretKey: 'sk_test',
  origin: 'https://app.weldsuite.org',
  input: { domain: 'example.com', autoRenew: true, years: 1, privacyProtection: true },
};

describe('createCheckout · Stripe customer', () => {
  it('creates a Stripe customer when the workspace has none and continues checkout', async () => {
    const persisted: Record<string, unknown>[] = [];
    const workspace = {
      id: 'ws_internal',
      name: 'Acme',
      clerkOrgId: 'org_test_default',
      stripeCustomerId: null as string | null,
    };
    const masterDb = masterDbStub({
      workspace,
      onUpdate: (values) => {
        persisted.push(values);
        if (typeof values.stripeCustomerId === 'string') {
          workspace.stripeCustomerId = values.stripeCustomerId;
        }
      },
    });

    const result = await createCheckout(db, availableRtr(), masterDb, checkoutParams);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe('cs_test_1');
    expect(result.url).toContain('checkout.stripe.com');
    expect(mockedCreateCustomer).toHaveBeenCalledWith('sk_test', {
      name: 'Acme',
      metadata: { workspaceId: 'ws_internal', clerkOrgId: 'org_test_default' },
    });
    expect(persisted[0]).toMatchObject({ stripeCustomerId: 'cus_created' });
    expect(mockedCreateSession).toHaveBeenCalledWith(
      'sk_test',
      expect.objectContaining({ customerId: 'cus_created' }),
    );

    const [row] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.id, result.registrationIds[0]!))
      .limit(1);
    expect(row?.fullDomain).toBe('example.com');
    expect(row?.stripeSessionId).toBe('cs_test_1');
    expect(row?.registrationStatus).toBe('pending_payment');
    expect(row?.privacyProtection).toBe(true);
  });

  it('stores customer contact on the tenant row and still forces WHOIS privacy', async () => {
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });
    const contact = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@customer.example',
      phone: '+44.2079460958',
      address1: '1 Street',
      city: 'London',
      postalCode: 'SW1A 1AA',
      country: 'GB',
    };

    const result = await createCheckout(db, availableRtr(), masterDb, {
      ...checkoutParams,
      input: {
        domain: 'privacy-force.com',
        autoRenew: true,
        years: 1,
        privacyProtection: false,
        contact,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.id, result.registrationIds[0]!))
      .limit(1);
    expect(row?.privacyProtection).toBe(true);
    expect(row?.registrantContact).toMatchObject({ email: 'ada@customer.example' });
    expect(row?.rtrRegistrantHandle).toBeNull();
  });


  it('reuses an existing Stripe customer and does not create another', async () => {
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });

    const result = await createCheckout(
      db,
      availableRtr(),
      masterDb,
      { ...checkoutParams, input: { ...checkoutParams.input, domain: 'reuse.com' } },
    );

    expect(result.ok).toBe(true);
    expect(mockedCreateCustomer).not.toHaveBeenCalled();
    expect(mockedCreateSession).toHaveBeenCalledWith(
      'sk_test',
      expect.objectContaining({ customerId: 'cus_existing' }),
    );
  });

  it('returns workspace_not_found instead of asking the user to complete billing setup', async () => {
    const masterDb = masterDbStub({ workspace: null });

    const result = await createCheckout(db, availableRtr(), masterDb, checkoutParams);

    expect(result).toEqual({ ok: false, reason: 'workspace_not_found' });
    expect(mockedCreateCustomer).not.toHaveBeenCalled();
    expect(mockedCreateSession).not.toHaveBeenCalled();
  });

  it('checks out every selected domain on one Stripe session', async () => {
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });

    const result = await createCheckout(db, availableRtr(), masterDb, {
      ...checkoutParams,
      input: { domains: ['alpha.com', 'beta.com'], autoRenew: true, years: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registrationIds).toHaveLength(2);
    expect(result.domains).toEqual(['alpha.com', 'beta.com']);
    expect(mockedCreateSession).toHaveBeenCalledWith(
      'sk_test',
      expect.objectContaining({
        lineItems: [
          { name: 'alpha.com', unitAmountCents: 1200, currency: 'usd' },
          { name: 'beta.com', unitAmountCents: 1200, currency: 'usd' },
        ],
      }),
    );
    const successUrl = mockedCreateSession.mock.calls[0]![1].successUrl as string;
    expect(successUrl).toContain(result.registrationIds.join(','));

    const all = await Promise.all(
      result.registrationIds.map(async (id) => {
        const [row] = await db
          .select()
          .from(schema.hostDomains)
          .where(eq(schema.hostDomains.id, id))
          .limit(1);
        return row;
      }),
    );
    expect(all.map((r) => r?.fullDomain)).toEqual(['alpha.com', 'beta.com']);
    expect(all.every((r) => r?.registrationStatus === 'pending_payment')).toBe(true);
    expect(all.every((r) => r?.stripeSessionId === 'cs_test_1')).toBe(true);
  });

  it('rejects a mixed-currency cart', async () => {
    const rtr = {
      checkDomains: vi.fn(async (requested: string[]) =>
        requested.map((name, i) => ({
          name,
          available: true,
          premium: false,
          priceCents: 1200,
          currency: i === 0 ? 'usd' : 'eur',
        })),
      ),
    } as unknown as RealtimeRegistrar;
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });

    const result = await createCheckout(db, rtr, masterDb, {
      ...checkoutParams,
      input: { domains: ['usd.com', 'eur.com'] },
    });
    expect(result).toEqual({ ok: false, reason: 'currency_mismatch' });
    expect(mockedCreateSession).not.toHaveBeenCalled();
  });

  it('caps at MAX_CHECKOUT_DOMAINS', async () => {
    expect(MAX_CHECKOUT_DOMAINS).toBe(10);
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });
    const names = Array.from({ length: 11 }, (_, i) => `n${i}.com`);
    const result = await createCheckout(db, {} as RealtimeRegistrar, masterDb, {
      ...checkoutParams,
      input: { domains: names },
    });
    expect(result).toEqual({ ok: false, reason: 'too_many', max: 10 });
    expect(mockedCreateSession).not.toHaveBeenCalled();
  });

  it('rejects multi-year checkout so billing and registration stay in lockstep', async () => {
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });
    const result = await createCheckout(db, {} as RealtimeRegistrar, masterDb, {
      ...checkoutParams,
      input: { domain: 'multi-year.com', years: 2 },
    });
    expect(result).toEqual({ ok: false, reason: 'unsupported_years' });
    expect(mockedCreateSession).not.toHaveBeenCalled();
  });

  it('deletes pending domain rows when Stripe returns a definite 4xx', async () => {
    mockedCreateSession.mockRejectedValueOnce(
      new Error('Stripe POST /v1/checkout/sessions failed (400): invalid_request'),
    );
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });

    await expect(
      createCheckout(db, availableRtr(), masterDb, {
        ...checkoutParams,
        input: { domain: 'stripe-400.com', years: 1 },
      }),
    ).rejects.toThrow(/failed \(400\)/);

    const leftover = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.fullDomain, 'stripe-400.com'));
    expect(leftover).toHaveLength(0);
  });

  it('keeps pending rows without a session id when Stripe fails ambiguously', async () => {
    mockedCreateSession.mockRejectedValueOnce(new Error('fetch failed'));
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });

    await expect(
      createCheckout(db, availableRtr(), masterDb, {
        ...checkoutParams,
        input: { domain: 'stripe-timeout.com', years: 1 },
      }),
    ).rejects.toThrow(/fetch failed/);

    const [row] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.fullDomain, 'stripe-timeout.com'))
      .limit(1);
    expect(row?.registrationStatus).toBe('pending_payment');
    expect(row?.stripeSessionId).toBeNull();
    expect(row?.metadata).toMatchObject({ registrationYears: 1 });
  });

  it('reuses orphan pending_payment rows on retry so Stripe cannot double-register', async () => {
    mockedCreateSession.mockRejectedValueOnce(new Error('fetch failed'));
    const masterDb = masterDbStub({
      workspace: {
        id: 'ws_internal',
        name: 'Acme',
        clerkOrgId: 'org_test_default',
        stripeCustomerId: 'cus_existing',
      },
    });
    const params = {
      ...checkoutParams,
      input: { domain: 'retry-orphan.com', years: 1 },
    };

    await expect(createCheckout(db, availableRtr(), masterDb, params)).rejects.toThrow(/fetch failed/);
    const [orphan] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.fullDomain, 'retry-orphan.com'))
      .limit(1);
    expect(orphan?.stripeSessionId).toBeNull();

    mockedCreateSession.mockResolvedValueOnce({
      id: 'cs_retry',
      url: 'https://checkout.stripe.com/c/pay/cs_retry',
    });
    const result = await createCheckout(db, availableRtr(), masterDb, params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registrationIds).toEqual([orphan!.id]);
    expect(mockedCreateSession).toHaveBeenLastCalledWith(
      'sk_test',
      expect.objectContaining({
        idempotencyKey: `weldhost-checkout:${orphan!.id}`,
      }),
    );

    const rows = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.fullDomain, 'retry-orphan.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stripeSessionId).toBe('cs_retry');
  });
});

describe('domainsFromCheckoutInput', () => {
  it('merges domain + domains, lowercases, and de-dupes', () => {
    expect(domainsFromCheckoutInput({ domain: 'Example.COM', domains: ['foo.com', 'example.com'] })).toEqual([
      'foo.com',
      'example.com',
    ]);
  });
});

