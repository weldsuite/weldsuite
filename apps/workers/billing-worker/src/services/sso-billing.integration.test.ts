/**
 * The SSO add-on against a real (pglite) master DB: buying it from Settings,
 * the Stripe webhooks mirroring it onto workspace_sso, the staff price
 * override (custom, free, revoke) and the hourly sweep. Stripe is a stubbed
 * fetch and Clerk a fake client, so the tests also check that the Clerk
 * connection follows entitlement.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const state = vi.hoisted(() => ({
  db: null as unknown,
  clerk: {
    connections: new Map<string, { id: string; active: boolean }>(),
    updates: [] as Array<{ id: string; active?: boolean }>,
    deletes: [] as string[],
  },
}));

vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db')>()),
  getMasterDb: () => state.db,
}));

vi.mock('@clerk/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/backend')>()),
  createClerkClient: () => ({
    samlConnections: {
      getSamlConnection: async (id: string) => state.clerk.connections.get(id),
      updateSamlConnection: async (id: string, params: { active?: boolean }) => {
        const connection = state.clerk.connections.get(id);
        if (!connection) throw Object.assign(new Error('not found'), { status: 404 });
        state.clerk.updates.push({ id, ...params });
        Object.assign(connection, params);
        return connection;
      },
      deleteSamlConnection: async (id: string) => {
        state.clerk.deletes.push(id);
        state.clerk.connections.delete(id);
        return {};
      },
    },
  }),
}));

// The real middleware verifies a Clerk RS256 JWT; the tests only need its output.
vi.mock('../middleware/auth', async (importOriginal) => {
  const { createMiddleware } = await import('hono/factory');
  return {
    ...(await importOriginal<typeof import('../middleware/auth')>()),
    clerkJwtAuth: () =>
      createMiddleware<{ Variables: { userId: string; orgId: string | null; orgRole: string | null } }>(async (c, next) => {
        c.set('userId', 'user_1');
        c.set('orgId', c.req.header('x-test-org') || null);
        c.set('orgRole', c.req.header('x-test-role') || null);
        await next();
      }),
  };
});

import { ssoBillingRoutes } from '../routes/sso-billing';
import { webhookRoutes } from '../routes/webhooks';
import { adminRoutes } from '../routes/admin';
import { runSsoSweep } from './sso-billing';
import type { Env } from '../index';

const { plans, workspaces, workspaceSso, adminAuditEvents } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let db: any;

const WEBHOOK_SECRET = 'whsec_sso_test';
const ADMIN_SECRET = 'a'.repeat(40);
const env = {
  STRIPE_SECRET_KEY: 'sk_test_sso',
  STRIPE_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BILLING_ADMIN_SECRET: ADMIN_SECRET,
  CLERK_SECRET_KEY: 'sk_clerk_test',
  ENVIRONMENT: 'test',
} as Env;

const FREE = 'plan_sso_free';
const BUSINESS = 'plan_sso_business';
const ENTERPRISE = 'plan_sso_enterprise';

let seq = 0;

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;
  await db
    .insert(plans)
    .values([
      { id: FREE, name: 'Free', slug: 'free', priceMonthly: '0' },
      { id: BUSINESS, name: 'Business', slug: 'business', priceMonthly: '0', pricePerUser: '49' },
      { id: ENTERPRISE, name: 'Enterprise', slug: 'enterprise', priceMonthly: '0', pricePerUser: '99', features: { sso: true } },
    ])
    .onConflictDoNothing();
}, 60_000);

beforeEach(() => {
  state.clerk.connections.clear();
  state.clerk.updates = [];
  state.clerk.deletes = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Seeded {
  id: string;
  orgId: string;
  customerId: string;
}

async function seedWorkspace(overrides: Partial<typeof workspaces.$inferInsert> = {}): Promise<Seeded> {
  seq += 1;
  const id = `ws_sso_${seq}`;
  const orgId = `org_sso_${seq}`;
  const customerId = `cus_sso_${seq}`;
  await db.insert(workspaces).values({
    id,
    clerkOrgId: orgId,
    name: `SSO Workspace ${seq}`,
    slug: `ws-sso-${seq}`,
    planId: BUSINESS,
    stripeCustomerId: customerId,
    ...overrides,
  });
  return { id, orgId, customerId };
}

/** An enabled connection on a verified domain, switched off in Clerk until entitled. */
async function seedConnection(ws: Seeded, overrides: Partial<typeof workspaceSso.$inferInsert> = {}): Promise<string> {
  const connectionId = `samlc_${ws.id}`;
  state.clerk.connections.set(connectionId, { id: connectionId, active: Boolean(overrides.clerkActive) });
  await db.insert(workspaceSso).values({
    id: `wsso_${ws.id}`,
    workspaceId: ws.id,
    clerkOrgId: ws.orgId,
    domain: `${ws.id}.example`,
    domainVerificationToken: 'token',
    domainVerifiedAt: new Date(),
    clerkConnectionId: connectionId,
    provider: 'saml_okta',
    enabled: true,
    clerkActive: false,
    ...overrides,
  });
  return connectionId;
}

async function ssoRow(workspaceId: string) {
  const [row] = await db.select().from(workspaceSso).where(eq(workspaceSso.workspaceId, workspaceId));
  return row as typeof workspaceSso.$inferSelect | undefined;
}

function ssoSubscription(id: string, ws: Seeded, status = 'active', price: Record<string, unknown> = { id: 'price_sso' }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    customer: ws.customerId,
    status,
    cancel_at_period_end: false,
    current_period_end: now + 30 * 86400,
    metadata: { type: 'weldsuite_sso', workspaceId: ws.id, clerkOrgId: ws.orgId },
    items: { data: [{ id: `si_${id}`, quantity: 1, price }] },
  };
}

// ---------------------------------------------------------------------------
// Stripe stub
// ---------------------------------------------------------------------------

interface StripeCall {
  method: string;
  path: string;
  form: URLSearchParams;
}

type Reply = unknown | ((form: URLSearchParams) => unknown);

/** Answers `${METHOD} ${path}`; the price lookups have defaults. Unknown calls fail loudly. */
function stubStripe(routes: Record<string, Reply>): StripeCall[] {
  const calls: StripeCall[] = [];
  const all: Record<string, Reply> = {
    'GET /v1/prices': { data: [{ id: 'price_sso' }] },
    'GET /v1/prices/price_sso': { id: 'price_sso', product: 'prod_sso' },
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const form = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ method, path: url.pathname, form });
      const reply = all[`${method} ${url.pathname}`];
      if (reply === undefined) {
        return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${url.pathname}` } }), { status: 500 });
      }
      const body = typeof reply === 'function' ? (reply as (f: URLSearchParams) => unknown)(form) : reply;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

const customer = (ws: Seeded, currency: string | null, card: boolean) => ({
  id: ws.customerId,
  currency,
  invoice_settings: { default_payment_method: card ? 'pm_1' : null },
});

const writes = (calls: StripeCall[]) => calls.filter((call) => call.method !== 'GET');

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Json = { data?: Record<string, unknown>; error?: { code: string; message: string } };

async function settings(ws: Seeded, method: 'GET' | 'POST', path: string, role: string | null = 'org:admin') {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-test-org': ws.orgId };
  if (role) headers['x-test-role'] = role;
  const res = await ssoBillingRoutes.request(path, { method, headers, body: method === 'POST' ? '{}' : undefined }, env);
  return { status: res.status, json: (await res.json()) as Json };
}

async function admin(ws: Seeded, path: string, body: Record<string, unknown>) {
  seq += 1;
  const res = await adminRoutes.request(
    `/workspaces/${ws.id}/sso${path}`,
    {
      method: 'POST',
      body: JSON.stringify({ reason: 'sales deal', ...body }),
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
        'x-admin-email': 'ops@weldsuite.org',
        'x-request-id': `req_sso_${seq}`,
      },
    },
    env,
  );
  return { status: res.status, json: (await res.json()) as Json };
}

async function sendEvent(type: string, object: unknown): Promise<Response> {
  const body = JSON.stringify({ id: `evt_${type}_${seq}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return webhookRoutes.request(
    '/',
    { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${signature}`, 'content-type': 'application/json' } },
    env,
  );
}

// ---------------------------------------------------------------------------
// Settings: status
// ---------------------------------------------------------------------------

describe('GET /status', () => {
  it('offers the add-on to a paid plan at €100, with the card on file', async () => {
    const ws = await seedWorkspace();
    stubStripe({
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true),
    });

    const { status, json } = await settings(ws, 'GET', '/status');

    expect(status).toBe(200);
    expect(json.data).toMatchObject({
      entitlement: { entitled: false, source: null },
      price: { unitAmountCents: 10_000, currency: 'eur', custom: false },
      purchasable: true,
      unavailableReason: null,
      subscription: null,
      hasPaymentMethod: true,
    });
  });

  it('prices it in dollars for a customer billed in USD', async () => {
    const ws = await seedWorkspace();
    stubStripe({
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, 'usd', false),
      'GET /v1/payment_methods': { data: [] },
    });

    const { json } = await settings(ws, 'GET', '/status');

    expect(json.data).toMatchObject({ price: { unitAmountCents: 10_000, currency: 'usd' }, hasPaymentMethod: false });
  });

  it('does not sell it on Free, and includes it on Enterprise', async () => {
    const free = await seedWorkspace({ planId: FREE });
    const enterprise = await seedWorkspace({ planId: ENTERPRISE });
    stubStripe({});

    const freeStatus = await settings(free, 'GET', '/status');
    const enterpriseStatus = await settings(enterprise, 'GET', '/status');

    expect(freeStatus.json.data).toMatchObject({ purchasable: false, unavailableReason: 'FREE_PLAN' });
    expect(enterpriseStatus.json.data).toMatchObject({
      purchasable: false,
      unavailableReason: 'INCLUDED_IN_PLAN',
      entitlement: { entitled: true, source: 'plan' },
    });
  });

  it('shows the price staff set for the workspace', async () => {
    const ws = await seedWorkspace();
    await db.insert(workspaceSso).values({
      id: `wsso_${ws.id}`,
      workspaceId: ws.id,
      clerkOrgId: ws.orgId,
      priceOverrideCents: 4900,
      priceOverrideCurrency: 'eur',
    });
    stubStripe({ [`GET /v1/customers/${ws.customerId}`]: customer(ws, 'eur', true) });

    const { json } = await settings(ws, 'GET', '/status');

    expect(json.data).toMatchObject({ price: { unitAmountCents: 4900, currency: 'eur', custom: true }, purchasable: true });
  });
});

// ---------------------------------------------------------------------------
// Settings: subscribe, cancel, resume
// ---------------------------------------------------------------------------

describe('POST /subscribe', () => {
  it('is refused to non-admins', async () => {
    const ws = await seedWorkspace();
    stubStripe({});

    const { status, json } = await settings(ws, 'POST', '/subscribe', 'org:member');

    expect(status).toBe(403);
    expect(json.error?.code).toBe('BILLING_ADMIN_REQUIRED');
  });

  it('asks for a card first', async () => {
    const ws = await seedWorkspace();
    const calls = stubStripe({
      [`GET /v1/subscriptions`]: { data: [] },
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, false),
      'GET /v1/payment_methods': { data: [] },
    });

    const { status, json } = await settings(ws, 'POST', '/subscribe');

    expect(status).toBe(402);
    expect(json.error?.code).toBe('PAYMENT_METHOD_REQUIRED');
    expect(writes(calls)).toEqual([]);
  });

  it('starts the add-on at the list price and switches on the waiting connection', async () => {
    const ws = await seedWorkspace();
    const connectionId = await seedConnection(ws);
    const calls = stubStripe({
      [`GET /v1/subscriptions`]: { data: [] },
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true),
      'POST /v1/subscriptions': ssoSubscription('sub_new', ws),
    });

    const { status, json } = await settings(ws, 'POST', '/subscribe');

    expect(status).toBe(200);
    const create = calls.find((call) => call.method === 'POST' && call.path === '/v1/subscriptions')!;
    expect(create.form.get('items[0][price]')).toBe('price_sso');
    expect(create.form.get('metadata[type]')).toBe('weldsuite_sso');
    expect(create.form.get('metadata[workspaceId]')).toBe(ws.id);
    expect(create.form.get('payment_behavior')).toBe('error_if_incomplete');

    expect(await ssoRow(ws.id)).toMatchObject({ stripeSubscriptionId: 'sub_new', subscriptionStatus: 'active' });
    expect(state.clerk.updates).toEqual([{ id: connectionId, active: true }]);
    expect(json.data).toMatchObject({ entitlement: { entitled: true, source: 'subscription' }, purchasable: false });
  });

  it('charges a staff price as price_data on the SSO product', async () => {
    const ws = await seedWorkspace();
    await db.insert(workspaceSso).values({
      id: `wsso_${ws.id}`,
      workspaceId: ws.id,
      clerkOrgId: ws.orgId,
      priceOverrideCents: 7500,
      priceOverrideCurrency: 'eur',
    });
    const calls = stubStripe({
      [`GET /v1/subscriptions`]: { data: [] },
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, 'eur', true),
      'POST /v1/subscriptions': ssoSubscription('sub_custom', ws),
    });

    await settings(ws, 'POST', '/subscribe');

    const create = calls.find((call) => call.method === 'POST' && call.path === '/v1/subscriptions')!;
    expect(create.form.get('items[0][price]')).toBeNull();
    expect(create.form.get('items[0][price_data][product]')).toBe('prod_sso');
    expect(create.form.get('items[0][price_data][unit_amount]')).toBe('7500');
    expect(create.form.get('items[0][price_data][currency]')).toBe('eur');
    expect(create.form.get('items[0][price_data][recurring][interval]')).toBe('month');
  });

  it('will not start a second add-on (a double click, or an id that never reached the row)', async () => {
    const ws = await seedWorkspace();
    const calls = stubStripe({
      [`GET /v1/subscriptions`]: { data: [ssoSubscription('sub_existing', ws)] },
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true),
    });

    const { status, json } = await settings(ws, 'POST', '/subscribe');

    expect(status).toBe(200);
    expect(writes(calls)).toEqual([]);
    expect(await ssoRow(ws.id)).toMatchObject({ stripeSubscriptionId: 'sub_existing', subscriptionStatus: 'active' });
    expect(json.data).toMatchObject({ entitlement: { entitled: true, source: 'subscription' } });
  });
});

describe('an unpaid add-on', () => {
  async function seedUnpaid() {
    const ws = await seedWorkspace();
    await db.insert(workspaceSso).values({
      id: `wsso_${ws.id}`,
      workspaceId: ws.id,
      clerkOrgId: ws.orgId,
      stripeSubscriptionId: 'sub_unpaid',
      subscriptionStatus: 'unpaid',
    });
    return ws;
  }

  it('is shown as overdue, not offered for sale', async () => {
    const ws = await seedUnpaid();
    stubStripe({ [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true) });

    const { json } = await settings(ws, 'GET', '/status');

    expect(json.data).toMatchObject({
      entitlement: { entitled: false },
      purchasable: false,
      subscription: { status: 'unpaid' },
    });
  });

  it('is not bought again: the overdue invoice has to be paid', async () => {
    const ws = await seedUnpaid();
    const calls = stubStripe({
      'GET /v1/subscriptions/sub_unpaid': ssoSubscription('sub_unpaid', ws, 'unpaid'),
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true),
    });

    const { status, json } = await settings(ws, 'POST', '/subscribe');

    expect(status).toBe(402);
    expect(json.error?.code).toBe('SSO_SUBSCRIPTION_UNPAID');
    expect(writes(calls)).toEqual([]);
  });

  it('can be cancelled, which ends it at once', async () => {
    const ws = await seedUnpaid();
    const calls = stubStripe({
      'GET /v1/subscriptions/sub_unpaid': ssoSubscription('sub_unpaid', ws, 'unpaid'),
      'DELETE /v1/subscriptions/sub_unpaid': ssoSubscription('sub_unpaid', ws, 'canceled'),
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true),
    });

    const { status } = await settings(ws, 'POST', '/cancel');

    expect(status).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/subscriptions/sub_unpaid')).toBe(true);
    expect(await ssoRow(ws.id)).toMatchObject({ subscriptionStatus: 'canceled' });
  });
});

describe('POST /cancel and /resume', () => {
  it('ends the add-on at period end and can undo that', async () => {
    const ws = await seedWorkspace();
    await db.insert(workspaceSso).values({
      id: `wsso_${ws.id}`,
      workspaceId: ws.id,
      clerkOrgId: ws.orgId,
      stripeSubscriptionId: 'sub_live',
      subscriptionStatus: 'active',
    });
    const live = ssoSubscription('sub_live', ws);
    const calls = stubStripe({
      'GET /v1/subscriptions/sub_live': live,
      'POST /v1/subscriptions/sub_live': (form: URLSearchParams) => ({
        ...live,
        cancel_at_period_end: form.get('cancel_at_period_end') === 'true',
      }),
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, null, true),
    });

    const cancel = await settings(ws, 'POST', '/cancel');
    expect(cancel.status).toBe(200);
    expect(calls.find((c) => c.method === 'POST')!.form.get('cancel_at_period_end')).toBe('true');
    expect(cancel.json.data).toMatchObject({ subscription: { status: 'active', cancelAtPeriodEnd: true } });

    const resume = await settings(ws, 'POST', '/resume');
    expect(resume.json.data).toMatchObject({ subscription: { cancelAtPeriodEnd: false } });
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

describe('Stripe webhooks', () => {
  it('a deleted add-on switches the connection off and leaves the plan alone', async () => {
    const ws = await seedWorkspace({ stripeSubscriptionId: 'sub_plan', purchasedSeats: 4 });
    const connectionId = await seedConnection(ws, {
      clerkActive: true,
      stripeSubscriptionId: 'sub_gone',
      subscriptionStatus: 'active',
    });
    stubStripe({});

    const res = await sendEvent('customer.subscription.deleted', ssoSubscription('sub_gone', ws, 'canceled'));

    expect(res.status).toBe(200);
    expect(await ssoRow(ws.id)).toMatchObject({ subscriptionStatus: 'canceled', clerkActive: false, enabled: true });
    expect(state.clerk.updates).toEqual([{ id: connectionId, active: false }]);
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(workspace).toMatchObject({ planId: BUSINESS, purchasedSeats: 4, stripeSubscriptionId: 'sub_plan' });
  });

  it('keeps SSO working while a payment is retried', async () => {
    const ws = await seedWorkspace();
    await seedConnection(ws, { clerkActive: true, stripeSubscriptionId: 'sub_late', subscriptionStatus: 'active' });
    stubStripe({});

    await sendEvent('customer.subscription.updated', ssoSubscription('sub_late', ws, 'past_due'));

    expect(await ssoRow(ws.id)).toMatchObject({ subscriptionStatus: 'past_due', clerkActive: true });
    expect(state.clerk.updates).toEqual([]);
  });

  it('unpaid switches SSO off, and paying the overdue invoice switches it back on', async () => {
    const ws = await seedWorkspace();
    const connectionId = await seedConnection(ws, { clerkActive: true, stripeSubscriptionId: 'sub_overdue', subscriptionStatus: 'past_due' });
    stubStripe({});

    await sendEvent('customer.subscription.updated', ssoSubscription('sub_overdue', ws, 'unpaid'));
    expect(await ssoRow(ws.id)).toMatchObject({ subscriptionStatus: 'unpaid', clerkActive: false });

    await sendEvent('customer.subscription.updated', ssoSubscription('sub_overdue', ws, 'active'));
    expect(await ssoRow(ws.id)).toMatchObject({ subscriptionStatus: 'active', clerkActive: true });
    expect(state.clerk.updates).toEqual([
      { id: connectionId, active: false },
      { id: connectionId, active: true },
    ]);
  });

  it('ignores a late event for an old add-on while a newer one runs', async () => {
    const ws = await seedWorkspace();
    await seedConnection(ws, { clerkActive: true, stripeSubscriptionId: 'sub_newer', subscriptionStatus: 'active' });
    stubStripe({});

    await sendEvent('customer.subscription.deleted', ssoSubscription('sub_older', ws, 'canceled'));

    expect(await ssoRow(ws.id)).toMatchObject({ stripeSubscriptionId: 'sub_newer', subscriptionStatus: 'active', clerkActive: true });
  });
});

// ---------------------------------------------------------------------------
// Admin console
// ---------------------------------------------------------------------------

describe('admin: SSO price', () => {
  it('free: cancels the running add-on and keeps the connection on', async () => {
    const ws = await seedWorkspace();
    const connectionId = await seedConnection(ws, {
      clerkActive: true,
      stripeSubscriptionId: 'sub_paid',
      subscriptionStatus: 'active',
    });
    const calls = stubStripe({
      'GET /v1/subscriptions/sub_paid': ssoSubscription('sub_paid', ws),
      'DELETE /v1/subscriptions/sub_paid': ssoSubscription('sub_paid', ws, 'canceled'),
    });

    const { status, json } = await admin(ws, '/grant', { priceCents: 0, switchOn: false });

    expect(status).toBe(200);
    expect(json.data).toMatchObject({ action: 'canceled', entitled: true });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/subscriptions/sub_paid')).toBe(true);
    expect(await ssoRow(ws.id)).toMatchObject({
      priceOverrideCents: 0,
      priceOverrideSetBy: 'ops@weldsuite.org',
      priceOverrideReason: 'sales deal',
      subscriptionStatus: 'canceled',
      clerkActive: true,
    });
    expect(state.clerk.updates.filter((u) => u.id === connectionId)).toEqual([]);

    // The cancellation webhook that follows changes nothing.
    await sendEvent('customer.subscription.deleted', ssoSubscription('sub_paid', ws, 'canceled'));
    expect(await ssoRow(ws.id)).toMatchObject({ clerkActive: true });

    const [audit] = await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.workspaceId, ws.id));
    expect(audit).toMatchObject({ action: 'sso.grant', outcome: 'success' });
  });

  it('custom price + switch on: starts the add-on at that price', async () => {
    const ws = await seedWorkspace();
    const calls = stubStripe({
      [`GET /v1/subscriptions`]: { data: [] },
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, 'eur', true),
      'POST /v1/subscriptions': ssoSubscription('sub_deal', ws, 'active', { id: 'price_inline', unit_amount: 6000, currency: 'eur' }),
    });

    const { json } = await admin(ws, '/grant', { priceCents: 6000, currency: 'eur', switchOn: true });

    expect(json.data).toMatchObject({ action: 'created', subscriptionId: 'sub_deal', entitled: true });
    const create = calls.find((c) => c.method === 'POST' && c.path === '/v1/subscriptions')!;
    expect(create.form.get('items[0][price_data][unit_amount]')).toBe('6000');
    expect(await ssoRow(ws.id)).toMatchObject({ priceOverrideCents: 6000, priceOverrideCurrency: 'eur', subscriptionStatus: 'active' });
  });

  it('custom price on a running add-on: reprices it from the next invoice', async () => {
    const ws = await seedWorkspace();
    await seedConnection(ws, { clerkActive: true, stripeSubscriptionId: 'sub_list', subscriptionStatus: 'active' });
    const calls = stubStripe({
      'GET /v1/subscriptions/sub_list': ssoSubscription('sub_list', ws),
      [`GET /v1/customers/${ws.customerId}`]: customer(ws, 'eur', true),
      'POST /v1/subscription_items/si_sub_list': { id: 'si_sub_list' },
    });

    const { json } = await admin(ws, '/grant', { priceCents: 5000, currency: 'eur', switchOn: false });

    expect(json.data).toMatchObject({ action: 'repriced' });
    const update = calls.find((c) => c.path === '/v1/subscription_items/si_sub_list')!;
    expect(update.form.get('price_data[unit_amount]')).toBe('5000');
    expect(update.form.get('proration_behavior')).toBe('none');
  });

  it('refuses a price in another currency than the customer is billed in', async () => {
    const ws = await seedWorkspace();
    const calls = stubStripe({ [`GET /v1/customers/${ws.customerId}`]: customer(ws, 'usd', true) });

    const { status, json } = await admin(ws, '/grant', { priceCents: 5000, currency: 'eur', switchOn: true });

    expect(status).toBe(400);
    expect(json.error?.code).toBe('CURRENCY_MISMATCH');
    expect(writes(calls)).toEqual([]);
    // Refused before anything was written (the transaction rolled back).
    expect((await ssoRow(ws.id))?.priceOverrideCents ?? null).toBeNull();
  });

  it('does not bill a partner-managed workspace, but can make SSO free there', async () => {
    const ws = await seedWorkspace({ billingMode: 'partner', stripeCustomerId: null });
    stubStripe({});

    const paid = await admin(ws, '/grant', { priceCents: 5000, currency: 'eur', switchOn: true });
    const free = await admin(ws, '/grant', { priceCents: 0, switchOn: false });

    expect(paid.status).toBe(409);
    expect(paid.json.error?.code).toBe('PARTNER_MANAGED');
    expect(free.status).toBe(200);
    expect(free.json.data).toMatchObject({ entitled: true });
  });

  it('revoke: ends the add-on now, clears the price and switches the connection off', async () => {
    const ws = await seedWorkspace();
    const connectionId = await seedConnection(ws, {
      clerkActive: true,
      stripeSubscriptionId: 'sub_revoked',
      subscriptionStatus: 'active',
      priceOverrideCents: 5000,
      priceOverrideCurrency: 'eur',
    });
    stubStripe({
      'GET /v1/subscriptions/sub_revoked': ssoSubscription('sub_revoked', ws),
      'DELETE /v1/subscriptions/sub_revoked': ssoSubscription('sub_revoked', ws, 'canceled'),
    });

    const { json } = await admin(ws, '/revoke', { mode: 'immediately' });

    expect(json.data).toMatchObject({ action: 'canceled', entitled: false });
    expect(await ssoRow(ws.id)).toMatchObject({ priceOverrideCents: null, subscriptionStatus: 'canceled', clerkActive: false });
    expect(state.clerk.updates).toEqual([{ id: connectionId, active: false }]);
  });

  it('turns a connection off without touching billing', async () => {
    const ws = await seedWorkspace({ planId: ENTERPRISE });
    const connectionId = await seedConnection(ws, { clerkActive: true });
    stubStripe({});

    const { json } = await admin(ws, '/connection/disable', {});

    expect(json.data).toEqual({ wasEnabled: true });
    expect(await ssoRow(ws.id)).toMatchObject({ enabled: false, clerkActive: false });
    expect(state.clerk.updates).toEqual([{ id: connectionId, active: false }]);
  });
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

describe('runSsoSweep', () => {
  it('follows plan changes and removes the connections of deleted workspaces', async () => {
    const downgraded = await seedWorkspace({ planId: BUSINESS });
    const downgradedConnection = await seedConnection(downgraded, { clerkActive: true });
    const upgraded = await seedWorkspace({ planId: ENTERPRISE });
    const upgradedConnection = await seedConnection(upgraded, { clerkActive: false });
    const deleted = await seedWorkspace({ planId: ENTERPRISE, deletedAt: new Date(), isActive: false });
    const deletedConnection = await seedConnection(deleted, {
      clerkActive: true,
      stripeSubscriptionId: 'sub_orphan',
      subscriptionStatus: 'active',
    });
    const calls = stubStripe({ 'DELETE /v1/subscriptions/sub_orphan': ssoSubscription('sub_orphan', deleted, 'canceled') });

    const result = await runSsoSweep(env, db);

    expect(result.failed).toBe(0);
    expect(state.clerk.updates).toEqual(
      expect.arrayContaining([
        { id: downgradedConnection, active: false },
        { id: upgradedConnection, active: true },
      ]),
    );
    expect(state.clerk.deletes).toContain(deletedConnection);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/subscriptions/sub_orphan')).toBe(true);
    expect(await ssoRow(deleted.id)).toMatchObject({ clerkConnectionId: null, subscriptionStatus: 'canceled' });
  });
});
