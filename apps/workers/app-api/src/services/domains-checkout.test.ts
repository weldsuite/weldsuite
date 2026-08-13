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
import { createCheckout } from './domains';

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

function availableRtr(domain = 'example.com'): RealtimeRegistrar {
  return {
    checkDomains: vi.fn(async () => [
      {
        name: domain,
        available: true,
        premium: false,
        priceCents: 1200,
        currency: 'usd',
      },
    ]),
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
        where: () => ({
          limit: async () => {
            if (table === masterSchema.hostDomainPricing) return [];
            return opts.workspace ? [opts.workspace] : [];
          },
        }),
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

    const result = await createCheckout(db, availableRtr('privacy-force.com'), masterDb, {
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
      availableRtr('reuse.com'),
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
});
