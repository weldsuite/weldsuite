/**
 * WeldBooks extra bank connection billing (GET /status, POST /sync) against a
 * scripted master DB and a stubbed Stripe API (global fetch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';
import { isBankConnectionInvoice, isBankConnectionSubscription } from '../services/bank-connection-billing';
import type { StripeInvoice } from '../types/stripe';

const mocks = vi.hoisted(() => ({ db: { current: null as unknown } }));

vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db')>()),
  getMasterDb: () => mocks.db.current,
}));
// The real middleware verifies a Clerk RS256 JWT; the tests only need its output.
vi.mock('../middleware/auth', async (importOriginal) => {
  const { createMiddleware } = await import('hono/factory');
  return {
    ...(await importOriginal<typeof import('../middleware/auth')>()),
    clerkJwtAuth: () =>
      createMiddleware<{ Variables: { userId: string; orgId: string | null; orgRole: string | null } }>(
        async (c, next) => {
          c.set('userId', 'user_1');
          c.set('orgId', c.req.header('x-test-org') || null);
          c.set('orgRole', c.req.header('x-test-role') || null);
          await next();
        },
      ),
  };
});

const { bankConnectionBillingRoutes } = await import('./bank-connection-billing');

const baseEnv = { STRIPE_SECRET_KEY: 'sk_test', ENVIRONMENT: 'test' } as unknown as Env;

// ---------------------------------------------------------------------------
// Stripe stub
// ---------------------------------------------------------------------------

interface StripeCall {
  method: string;
  path: string;
  form: URLSearchParams;
  idempotencyKey: string | null;
}

const stripe = { calls: [] as StripeCall[], routes: {} as Record<string, unknown> };

function stubStripe(routes: Record<string, unknown>) {
  stripe.calls = [];
  stripe.routes = routes;
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    stripe.calls.push({
      method,
      path: url.pathname,
      form: new URLSearchParams(String(init?.body ?? '')),
      idempotencyKey: headers['Idempotency-Key'] ?? null,
    });
    const reply = stripe.routes[`${method} ${url.pathname}`];
    if (reply === undefined) {
      return new Response(JSON.stringify({ error: { message: `unexpected Stripe call ${method} ${url.pathname}` } }), { status: 500 });
    }
    return new Response(JSON.stringify(reply), { status: 200 });
  });
}

const writes = () => stripe.calls.filter((c) => c.method !== 'GET');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workspace = (over: Record<string, unknown> = {}) => ({
  id: 'ws_1',
  name: 'Acme',
  clerkOrgId: 'org_1',
  stripeCustomerId: 'cus_1',
  planId: null,
  ...over,
});

const extraSubscription = (quantity: number) => ({
  id: 'sub_bank',
  status: 'active',
  customer: 'cus_1',
  metadata: { type: 'weldbooks_bank_connections', workspaceId: 'ws_1' },
  items: { data: [{ id: 'si_bank', quantity, metadata: {}, price: { id: 'price_bank' } }] },
});

const planSubscription = { id: 'sub_plan', status: 'active', customer: 'cus_1', metadata: {}, items: { data: [{ id: 'si_plan', quantity: 3 }] } };

const customerWithCard = { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } };
const customerWithoutCard = { id: 'cus_1', invoice_settings: { default_payment_method: null } };

/** `selects`: the workspace, then the connection count, then (with a plan) its features. */
function useDb(selects: unknown[][]) {
  const fake = createFakeDb({ selects });
  const db = { ...fake.db, execute: vi.fn(async () => []) };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  mocks.db.current = db;
  return fake;
}

function call(method: 'GET' | 'POST', path: string, role: string | null = 'org:admin') {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-test-org': 'org_1' };
  if (role) headers['x-test-role'] = role;
  return bankConnectionBillingRoutes.request(path, { method, headers, body: method === 'POST' ? '{}' : undefined }, baseEnv);
}

const body = async (res: Response) =>
  (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------

describe('GET /status', () => {
  it('reports the included connections without asking Stripe while the workspace is under them', async () => {
    useDb([[workspace()], [{ count: 0 }]]);
    stubStripe({});

    const res = await call('GET', '/status', 'org:member');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { connections: 0, included: 1, billedExtra: 0, unitAmountCents: 500, currency: 'eur', hasPaymentMethod: false, canAddPaid: false },
    });
    expect(stripe.calls).toEqual([]);
  });

  it('reads the plan, the billed quantity and the payment method at the limit', async () => {
    useDb([[workspace({ planId: 'plan_pro' })], [{ count: 4 }], [{ features: { includedBankConnections: 3 } }]]);
    stubStripe({
      'GET /v1/subscriptions': { data: [planSubscription, extraSubscription(1)] },
      'GET /v1/customers/cus_1': customerWithCard,
    });

    const res = await call('GET', '/status');

    expect((await body(res)).data).toMatchObject({
      connections: 4,
      included: 3,
      billedExtra: 1,
      unitAmountCents: 500,
      currency: 'eur',
      hasPaymentMethod: true,
      canAddPaid: true,
    });
    expect(writes()).toEqual([]);
  });

  it('quotes the price in the currency the customer is billed in', async () => {
    useDb([[workspace()], [{ count: 1 }]]);
    stubStripe({
      'GET /v1/subscriptions': { data: [planSubscription] },
      'GET /v1/customers/cus_1': { ...customerWithCard, currency: 'usd' },
    });

    const res = await call('GET', '/status');

    expect((await body(res)).data).toMatchObject({ unitAmountCents: 500, currency: 'usd', hasPaymentMethod: true });
  });
});

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------

describe('POST /sync', () => {
  it('changes nothing while the connections fit in the plan', async () => {
    useDb([[workspace()], [{ count: 1 }]]);
    stubStripe({ 'GET /v1/subscriptions': { data: [planSubscription] } });

    const res = await call('POST', '/sync', 'org:member');

    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ connections: 1, included: 1, quantity: 0 });
    expect(writes()).toEqual([]);
  });

  it('starts the extra-connection subscription for an admin with a card', async () => {
    useDb([[workspace()], [{ count: 2 }]]);
    stubStripe({
      'GET /v1/subscriptions': { data: [planSubscription] },
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/prices': { data: [{ id: 'price_bank' }] },
      'POST /v1/subscriptions': extraSubscription(1),
    });

    const res = await call('POST', '/sync');

    expect(res.status).toBe(200);
    const created = writes();
    expect(created).toHaveLength(1);
    expect(created[0]?.path).toBe('/v1/subscriptions');
    expect(Object.fromEntries(created[0]!.form)).toMatchObject({
      customer: 'cus_1',
      'items[0][price]': 'price_bank',
      'items[0][quantity]': '1',
      'metadata[type]': 'weldbooks_bank_connections',
      'metadata[workspaceId]': 'ws_1',
    });
    // Unique per attempt, so a later subscription the same day is never answered with a cancelled one.
    expect(created[0]?.idempotencyKey).toMatch(/^bank-connections:ws_1:1:[0-9a-f-]{36}$/);
  });

  it('raises the quantity of an existing subscription', async () => {
    useDb([[workspace()], [{ count: 3 }]]);
    stubStripe({
      'GET /v1/subscriptions': { data: [extraSubscription(1)] },
      'GET /v1/customers/cus_1': customerWithCard,
      'POST /v1/subscription_items/si_bank': {},
    });

    await call('POST', '/sync');

    expect(writes().map((c) => [c.path, c.form.get('quantity')])).toEqual([['/v1/subscription_items/si_bank', '2']]);
  });

  it('refuses to raise the charge for a member, or without a payment method', async () => {
    useDb([[workspace()], [{ count: 2 }]]);
    stubStripe({ 'GET /v1/subscriptions': { data: [] } });
    const member = await call('POST', '/sync', 'org:member');
    expect(member.status).toBe(403);
    expect((await body(member)).error?.code).toBe('BILLING_ADMIN_REQUIRED');

    useDb([[workspace()], [{ count: 2 }]]);
    stubStripe({ 'GET /v1/subscriptions': { data: [] }, 'GET /v1/customers/cus_1': customerWithoutCard, 'GET /v1/payment_methods': { data: [] } });
    const noCard = await call('POST', '/sync');
    expect(noCard.status).toBe(402);
    expect((await body(noCard)).error?.code).toBe('PAYMENT_METHOD_REQUIRED');
    expect(writes()).toEqual([]);
  });

  it('lets any member lower the charge, and cancels at zero extra connections', async () => {
    useDb([[workspace()], [{ count: 2 }]]);
    stubStripe({ 'GET /v1/subscriptions': { data: [extraSubscription(3)] }, 'POST /v1/subscription_items/si_bank': {} });
    await call('POST', '/sync', 'org:member');
    expect(writes().map((c) => [c.path, c.form.get('quantity')])).toEqual([['/v1/subscription_items/si_bank', '1']]);

    useDb([[workspace()], [{ count: 1 }]]);
    stubStripe({ 'GET /v1/subscriptions': { data: [extraSubscription(1)] }, 'DELETE /v1/subscriptions/sub_bank': {} });
    const res = await call('POST', '/sync', 'org:member');
    expect(res.status).toBe(200);
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/subscriptions/sub_bank']);
  });
});

// ---------------------------------------------------------------------------
// Webhook guards
// ---------------------------------------------------------------------------

describe('webhook guards', () => {
  it('recognises the subscription and its invoices, and nothing else', () => {
    expect(isBankConnectionSubscription(extraSubscription(1))).toBe(true);
    expect(isBankConnectionSubscription(planSubscription)).toBe(false);

    const invoice = (extra: Record<string, unknown>) => ({ id: 'in_1', ...extra }) as unknown as StripeInvoice;
    expect(isBankConnectionInvoice(invoice({ subscription_details: { metadata: { type: 'weldbooks_bank_connections' } } }))).toBe(true);
    expect(isBankConnectionInvoice(invoice({ lines: { data: [{ metadata: { type: 'weldbooks_bank_connections' } }] } }))).toBe(true);
    expect(isBankConnectionInvoice(invoice({ subscription_details: { metadata: {} }, lines: { data: [{ metadata: {} }] } }))).toBe(false);
  });
});
