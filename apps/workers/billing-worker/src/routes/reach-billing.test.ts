/**
 * WeldReach billing routes (GET /status, POST /setup, POST /inboxes) against a
 * scripted master DB and a stubbed Stripe API (global fetch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../test/fake-db';
import type { Env } from '../index';

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

const { reachBillingRoutes } = await import('./reach-billing');

const baseEnv = { STRIPE_SECRET_KEY: 'sk_test', ENVIRONMENT: 'test' } as unknown as Env;

// ---------------------------------------------------------------------------
// Stripe stub
// ---------------------------------------------------------------------------

interface StripeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  idempotencyKey: string | null;
}
class StripeReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
type Responder = unknown | ((call: StripeCall) => unknown);

const stripe = { calls: [] as StripeCall[], routes: {} as Record<string, Responder> };

function stubStripe(routes: Record<string, Responder>) {
  stripe.calls = [];
  stripe.routes = routes;
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: StripeCall = {
      method,
      path: url.pathname,
      query: url.searchParams,
      form: new URLSearchParams(String(init?.body ?? '')),
      idempotencyKey: headers['Idempotency-Key'] ?? null,
    };
    stripe.calls.push(call);
    const responder = stripe.routes[`${method} ${url.pathname}`];
    if (responder === undefined) {
      return new Response(JSON.stringify({ error: { message: `unexpected Stripe call ${method} ${url.pathname}` } }), {
        status: 500,
      });
    }
    const result = typeof responder === 'function' ? (responder as (c: StripeCall) => unknown)(call) : responder;
    if (result instanceof StripeReply) return new Response(JSON.stringify(result.body), { status: result.status });
    return new Response(JSON.stringify(result), { status: 200 });
  });
}

const writes = (method: string) => stripe.calls.filter((c) => c.method === method);
const callTo = (method: string, path: string) => stripe.calls.find((c) => c.method === method && c.path === path);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workspace = (over: Record<string, unknown> = {}) => ({
  id: 'ws_1',
  name: 'Acme',
  clerkOrgId: 'org_1',
  stripeCustomerId: 'cus_1',
  ...over,
});

const access = (over: Record<string, unknown> = {}) => ({
  id: 'waa_1',
  workspaceId: 'ws_1',
  appCode: 'weldreach',
  status: 'approved',
  stripeSubscriptionId: null,
  billingStatus: 'none',
  billingStatusAt: null,
  ...over,
});

const subscription = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  current_period_end: 1_790_000_000,
  metadata: { type: 'weldreach', workspaceId: 'ws_1' },
  items: { data: [{ id: 'si_1', quantity: 3, metadata: {}, price: { id: 'price_inbox' }, ...item }] },
  ...over,
});

const customerWithCard = { id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } };
const customerWithoutCard = { id: 'cus_1', invoice_settings: { default_payment_method: null } };

function useDb(script: Parameters<typeof createFakeDb>[0]): FakeDb {
  const fake = createFakeDb(script);
  // The fake has no `execute`, which the advisory lock needs; a transaction is the same handle.
  const db = { ...fake.db, execute: vi.fn(async () => []) };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  mocks.db.current = db;
  return fake;
}

function call(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; role?: string | null; org?: string | null; env?: Partial<Env> } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const role = options.role === undefined ? 'org:admin' : options.role;
  const org = options.org === undefined ? 'org_1' : options.org;
  if (role) headers['x-test-role'] = role;
  if (org) headers['x-test-org'] = org;
  return reachBillingRoutes.request(
    path,
    { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) },
    { ...baseEnv, ...options.env } as Env,
  );
}

const addInbox = (mailboxId = 'rmb_1', options: Parameters<typeof call>[2] = {}) =>
  call('POST', '/inboxes', { ...options, body: { delta: 1, mailboxId } });
const removeInbox = (mailboxId = 'rmb_1', options: Parameters<typeof call>[2] = {}) =>
  call('POST', '/inboxes', { ...options, body: { delta: -1, mailboxId } });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
  it('reports "none" for a workspace without a subscription', async () => {
    useDb({ selects: [[workspace()], []] });
    stubStripe({ 'GET /v1/customers/cus_1': customerWithCard });

    const res = await call('GET', '/status');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        status: 'none',
        hasPaymentMethod: true,
        inboxCount: 0,
        unitAmountCents: 500,
        currency: 'usd',
        currentPeriodEnd: null,
      },
    });
    // read-only: a status read never touches the customer
    expect(writes('POST')).toEqual([]);
  });

  it('reports the access row status, the item quantity and the period end', async () => {
    useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'past_due' })]],
    });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions/sub_1': subscription({ status: 'past_due' }),
    });

    const body = (await (await call('GET', '/status')).json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({
      status: 'past_due',
      hasPaymentMethod: true,
      inboxCount: 3,
      currentPeriodEnd: new Date(1_790_000_000 * 1000).toISOString(),
    });
  });

  it('counts no inboxes once the subscription is cancelled', async () => {
    useDb({ selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'canceled' })]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions/sub_1': subscription({ status: 'canceled' }),
    });

    const body = (await (await call('GET', '/status')).json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({ status: 'canceled', inboxCount: 0, currentPeriodEnd: null });
  });

  it('has no payment method without a Stripe customer, and makes no Stripe call for it', async () => {
    useDb({ selects: [[workspace({ stripeCustomerId: null })], []] });
    stubStripe({});

    const body = (await (await call('GET', '/status')).json()) as { data: Record<string, unknown> };

    expect(body.data.hasPaymentMethod).toBe(false);
    expect(stripe.calls).toEqual([]);
  });

  it('is open to a plain org member', async () => {
    useDb({ selects: [[workspace()], []] });
    stubStripe({ 'GET /v1/customers/cus_1': customerWithCard });
    expect((await call('GET', '/status', { role: 'org:member' })).status).toBe(200);
  });

  it('needs an organization', async () => {
    useDb({});
    stubStripe({});
    const res = await call('GET', '/status', { org: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'NO_ORGANIZATION' } });
  });

  it('answers 502 when Stripe fails, without leaking its message', async () => {
    useDb({ selects: [[workspace()], []] });
    stubStripe({ 'GET /v1/customers/cus_1': new StripeReply(500, { error: { message: 'secret internals' } }) });

    const res = await call('GET', '/status');

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('secret internals');
  });
});

// ---------------------------------------------------------------------------
// POST /setup
// ---------------------------------------------------------------------------

describe('POST /setup', () => {
  const urls = { successUrl: 'https://app.weldsuite.org/weldreach?billing=ok', cancelUrl: 'https://app.weldsuite.org/weldreach' };

  it('opens a setup-mode Checkout session for the workspace customer', async () => {
    useDb({ selects: [[workspace()]] });
    stubStripe({ 'POST /v1/checkout/sessions': { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } });

    const res = await call('POST', '/setup', { body: urls });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/pay/cs_1' } });
    const form = callTo('POST', '/v1/checkout/sessions')?.form;
    expect(form?.get('mode')).toBe('setup');
    expect(form?.get('customer')).toBe('cus_1');
    expect(form?.get('success_url')).toBe(urls.successUrl);
    expect(form?.get('cancel_url')).toBe(urls.cancelUrl);
    expect(form?.get('payment_method_types[0]')).toBe('card');
    expect(form?.get('metadata[type]')).toBe('weldreach_setup');
    expect(form?.get('metadata[workspaceId]')).toBe('ws_1');
    expect(form?.has('line_items[0][price]')).toBe(false);
  });

  it('creates and stores the Stripe customer when the workspace has none', async () => {
    const fake = useDb({ selects: [[workspace({ stripeCustomerId: null })]] });
    stubStripe({
      'POST /v1/customers': { id: 'cus_new' },
      'POST /v1/checkout/sessions': { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' },
    });

    const res = await call('POST', '/setup', { body: urls });

    expect(res.status).toBe(200);
    expect(callTo('POST', '/v1/customers')?.idempotencyKey).toBe('weldreach-customer:ws_1');
    expect(callTo('POST', '/v1/checkout/sessions')?.form.get('customer')).toBe('cus_new');
    expect(fake.written('update')[0]).toMatchObject({ stripeCustomerId: 'cus_new' });
  });

  it('is for workspace admins only', async () => {
    useDb({});
    stubStripe({});
    expect((await call('POST', '/setup', { body: urls, role: 'org:member' })).status).toBe(403);
    expect(stripe.calls).toEqual([]);
  });

  it.each([
    ['missing urls', {}],
    ['a malformed url', { successUrl: 'nope', cancelUrl: urls.cancelUrl }],
    ['a non-web url', { successUrl: 'javascript:alert(1)', cancelUrl: urls.cancelUrl }],
  ])('rejects %s', async (_label, body) => {
    useDb({});
    stubStripe({});
    const res = await call('POST', '/setup', { body });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('answers 503 when Stripe is not configured', async () => {
    useDb({});
    stubStripe({});
    const res = await call('POST', '/setup', { body: urls, env: { STRIPE_SECRET_KEY: '' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'BILLING_NOT_CONFIGURED' } });
  });
});

// ---------------------------------------------------------------------------
// POST /inboxes: guards
// ---------------------------------------------------------------------------

describe('POST /inboxes guards', () => {
  it.each([
    ['delta 2', { delta: 2, mailboxId: 'rmb_1' }],
    ['delta 0', { delta: 0, mailboxId: 'rmb_1' }],
    ['no mailboxId', { delta: 1 }],
    ['an empty mailboxId', { delta: 1, mailboxId: '  ' }],
    ['no body', undefined],
  ])('rejects %s', async (_label, body) => {
    useDb({});
    stubStripe({});
    const res = await call('POST', '/inboxes', { body });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('is for workspace admins only', async () => {
    useDb({});
    stubStripe({});
    expect((await addInbox('rmb_1', { role: 'org:member' })).status).toBe(403);
    expect(stripe.calls).toEqual([]);
  });

  it('answers 404 for an unknown workspace', async () => {
    useDb({ selects: [[]] });
    stubStripe({});
    expect((await addInbox()).status).toBe(404);
  });

  it('answers 403 APP_ACCESS_REQUIRED when the workspace has no WeldReach access row', async () => {
    useDb({ selects: [[workspace()], []] });
    stubStripe({});

    const res = await addInbox();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_ACCESS_REQUIRED' } });
    expect(stripe.calls).toEqual([]);
  });

  it.each(['requested', 'rejected', 'suspended', 'revoked'])(
    'does not add an inbox while access is %s',
    async (status) => {
      useDb({ selects: [[workspace()], [access({ status })]] });
      stubStripe({});

      const res = await addInbox();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'APP_ACCESS_REQUIRED' } });
      expect(stripe.calls).toEqual([]);
    },
  );

  it('answers 402 PAYMENT_METHOD_REQUIRED without a card, before any subscription is made', async () => {
    useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithoutCard,
      'GET /v1/payment_methods': { data: [] },
    });

    const res = await addInbox();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYMENT_METHOD_REQUIRED' } });
    expect(callTo('POST', '/v1/subscriptions')).toBeUndefined();
  });

  it('answers 409 BILLING_BUSY when the workspace lock cannot be taken in time', async () => {
    useDb({});
    const db = mocks.db.current as { transaction: unknown };
    db.transaction = async () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    };
    // findWorkspaceByOrg still runs on the same handle
    const fake = createFakeDb({ selects: [[workspace()]] });
    (mocks.db.current as { select: unknown }).select = fake.db.select;
    stubStripe({});

    const res = await addInbox();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'BILLING_BUSY' } });
  });
});

// ---------------------------------------------------------------------------
// POST /inboxes: +1
// ---------------------------------------------------------------------------

describe('POST /inboxes delta +1', () => {
  it('creates the subscription for the first inbox (price found by lookup key)', async () => {
    const fake = useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/prices': { data: [{ id: 'price_inbox' }] },
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': subscription({ id: 'sub_new' }, { quantity: 1 }),
    });

    const res = await addInbox('rmb_1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { quantity: 1 } });

    const created = callTo('POST', '/v1/subscriptions');
    expect(created?.form.get('customer')).toBe('cus_1');
    expect(created?.form.get('items[0][price]')).toBe('price_inbox');
    expect(created?.form.get('items[0][quantity]')).toBe('1');
    expect(created?.form.get('items[0][metadata][lastOp]')).toBe('rmb_1:1');
    expect(created?.form.get('payment_behavior')).toBe('error_if_incomplete');
    expect(created?.form.get('metadata[type]')).toBe('weldreach');
    expect(created?.form.get('metadata[workspaceId]')).toBe('ws_1');
    expect(created?.form.get('metadata[clerkOrgId]')).toBe('org_1');
    expect(created?.form.get('metadata[appCode]')).toBe('weldreach');
    expect(created?.idempotencyKey).toBe('weldreach-sub:ws_1:rmb_1:none:pm_1');
    expect(callTo('GET', '/v1/prices')?.query.get('lookup_keys[]')).toBe('weldreach_inbox_monthly_v1');

    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_new', billingStatus: 'active' });
    expect((fake.written('update')[0] as { billingStatusAt: unknown }).billingStatusAt).toBeInstanceOf(Date);
  });

  it('creates the $5 USD monthly price lazily when none exists', async () => {
    useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/prices': { data: [] },
      'POST /v1/products': { id: 'prod_inbox' },
      'POST /v1/prices': { id: 'price_new' },
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': subscription({ id: 'sub_new' }, { quantity: 1 }),
    });

    expect((await addInbox()).status).toBe(200);

    expect(callTo('POST', '/v1/products')?.form.get('metadata[type]')).toBe('weldreach');
    const price = callTo('POST', '/v1/prices')?.form;
    expect(price?.get('product')).toBe('prod_inbox');
    expect(price?.get('unit_amount')).toBe('500');
    expect(price?.get('currency')).toBe('usd');
    expect(price?.get('recurring[interval]')).toBe('month');
    expect(price?.get('lookup_key')).toBe('weldreach_inbox_monthly_v1');
    expect(callTo('POST', '/v1/subscriptions')?.form.get('items[0][price]')).toBe('price_new');
  });

  it('uses the price pinned in STRIPE_PRICE_WELDREACH_INBOX without looking one up', async () => {
    useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': subscription({ id: 'sub_new' }, { quantity: 1 }),
    });

    await addInbox('rmb_1', { env: { STRIPE_PRICE_WELDREACH_INBOX: 'price_pinned' } });

    expect(callTo('GET', '/v1/prices')).toBeUndefined();
    expect(callTo('POST', '/v1/subscriptions')?.form.get('items[0][price]')).toBe('price_pinned');
  });

  it('makes the first card the default payment method, since Checkout does not', async () => {
    useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithoutCard,
      'GET /v1/payment_methods': { data: [{ id: 'pm_first' }] },
      'POST /v1/customers/cus_1': { id: 'cus_1' },
      'GET /v1/prices': { data: [{ id: 'price_inbox' }] },
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': subscription({ id: 'sub_new' }, { quantity: 1 }),
    });

    expect((await addInbox()).status).toBe(200);

    expect(callTo('POST', '/v1/customers/cus_1')?.form.get('invoice_settings[default_payment_method]')).toBe('pm_first');
    expect(callTo('POST', '/v1/subscriptions')?.idempotencyKey).toBe('weldreach-sub:ws_1:rmb_1:none:pm_first');
  });

  it('bumps the item quantity on an existing subscription, with the proration default', async () => {
    const fake = useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]],
    });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions/sub_1': subscription(),
      'POST /v1/subscription_items/si_1': { id: 'si_1', quantity: 4 },
    });

    const res = await addInbox('rmb_9');

    expect(await res.json()).toEqual({ data: { quantity: 4 } });
    const update = callTo('POST', '/v1/subscription_items/si_1')?.form;
    expect(update?.get('quantity')).toBe('4');
    expect(update?.get('proration_behavior')).toBe('create_prorations');
    expect(update?.get('metadata[lastOp]')).toBe('rmb_9:1');
    expect(callTo('POST', '/v1/subscriptions')).toBeUndefined();
    // status unchanged (already active): billingStatusAt stays where it was
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_1', billingStatus: 'active', billingStatusAt: null });
  });

  it('does not bump the quantity again for a retry of an operation Stripe already applied', async () => {
    useDb({ selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions/sub_1': subscription({}, { quantity: 4, metadata: { lastOp: 'rmb_9:1' } }),
    });

    const res = await addInbox('rmb_9');

    expect(await res.json()).toEqual({ data: { quantity: 4 } });
    expect(writes('POST')).toEqual([]);
  });

  it('finds a subscription whose id never reached the row, instead of creating a second one', async () => {
    const fake = useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions': {
        data: [
          { id: 'sub_plan', status: 'active', metadata: {}, items: { data: [{ id: 'si_plan', quantity: 5 }] } },
          subscription({ id: 'sub_lost' }, { id: 'si_lost', quantity: 1 }),
        ],
      },
      'POST /v1/subscription_items/si_lost': { id: 'si_lost', quantity: 2 },
    });

    const res = await addInbox('rmb_2');

    expect(await res.json()).toEqual({ data: { quantity: 2 } });
    expect(callTo('POST', '/v1/subscriptions')).toBeUndefined();
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_lost', billingStatus: 'active' });
  });

  it('ignores a cancelled stored subscription and starts a new one with its own idempotency key', async () => {
    const fake = useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_old', billingStatus: 'canceled' })]],
    });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions/sub_old': subscription({ id: 'sub_old', status: 'canceled' }),
      'GET /v1/subscriptions': { data: [] },
      'GET /v1/prices': { data: [{ id: 'price_inbox' }] },
      'POST /v1/subscriptions': subscription({ id: 'sub_new' }, { quantity: 1 }),
    });

    expect((await addInbox('rmb_1')).status).toBe(200);

    expect(callTo('POST', '/v1/subscriptions')?.idempotencyKey).toBe('weldreach-sub:ws_1:rmb_1:sub_old:pm_1');
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_new', billingStatus: 'active' });
    expect((fake.written('update')[0] as { billingStatusAt: unknown }).billingStatusAt).toBeInstanceOf(Date);
  });

  it.each(['past_due', 'unpaid'])('refuses a new inbox while the subscription is %s', async (status) => {
    const fake = useDb({ selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'past_due' })]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/subscriptions/sub_1': subscription({ status }),
    });

    const res = await addInbox();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYMENT_PAST_DUE' } });
    expect(writes('POST')).toEqual([]);
    expect(fake.written('update')).toEqual([]);
  });

  it('answers 402 PAYMENT_FAILED when the card is declined, and stores nothing', async () => {
    const fake = useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/prices': { data: [{ id: 'price_inbox' }] },
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': new StripeReply(402, {
        error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
      }),
    });

    const res = await addInbox();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYMENT_FAILED' } });
    expect(fake.written('update')).toEqual([]);
  });

  it('answers 402 PAYMENT_FAILED when the card needs an authentication it cannot do off-session', async () => {
    useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/prices': { data: [{ id: 'price_inbox' }] },
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': new StripeReply(402, {
        error: { code: 'subscription_payment_intent_requires_action', message: 'This payment requires additional user action.' },
      }),
    });

    const res = await addInbox();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYMENT_FAILED' } });
  });

  it('answers 502 for any other Stripe failure', async () => {
    useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/customers/cus_1': customerWithCard,
      'GET /v1/prices': { data: [{ id: 'price_inbox' }] },
      'GET /v1/subscriptions': { data: [] },
      'POST /v1/subscriptions': new StripeReply(500, { error: { message: 'api down' } }),
    });

    const res = await addInbox();

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'BILLING_PROVIDER_ERROR' } });
  });
});

// ---------------------------------------------------------------------------
// POST /inboxes: -1
// ---------------------------------------------------------------------------

describe('POST /inboxes delta -1', () => {
  it('lowers the item quantity by one', async () => {
    const fake = useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]],
    });
    stubStripe({
      'GET /v1/subscriptions/sub_1': subscription(),
      'POST /v1/subscription_items/si_1': { id: 'si_1', quantity: 2 },
    });

    const res = await removeInbox('rmb_3');

    expect(await res.json()).toEqual({ data: { quantity: 2 } });
    const update = callTo('POST', '/v1/subscription_items/si_1')?.form;
    expect(update?.get('quantity')).toBe('2');
    expect(update?.get('metadata[lastOp]')).toBe('rmb_3:-1');
    expect(callTo('DELETE', '/v1/subscriptions/sub_1')).toBeUndefined();
    expect(fake.written('update')).toEqual([]);
  });

  it('cancels the subscription at the last inbox and marks billing canceled', async () => {
    const fake = useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]],
    });
    stubStripe({
      'GET /v1/subscriptions/sub_1': subscription({}, { quantity: 1 }),
      'DELETE /v1/subscriptions/sub_1': { id: 'sub_1', status: 'canceled' },
    });

    const res = await removeInbox('rmb_1');

    expect(await res.json()).toEqual({ data: { quantity: 0 } });
    expect(callTo('DELETE', '/v1/subscriptions/sub_1')).toBeDefined();
    expect(callTo('POST', '/v1/subscription_items/si_1')).toBeUndefined();
    // the cancelled id stays on the row, so a late webhook for it is recognisable
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_1', billingStatus: 'canceled' });
    expect((fake.written('update')[0] as { billingStatusAt: unknown }).billingStatusAt).toBeInstanceOf(Date);
  });

  it('is a no-op when no inbox is billed, and still records that on a stale row', async () => {
    const fake = useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]],
    });
    stubStripe({
      'GET /v1/subscriptions/sub_1': new StripeReply(404, { error: { message: 'No such subscription' } }),
      'GET /v1/subscriptions': { data: [] },
    });

    const res = await removeInbox();

    expect(await res.json()).toEqual({ data: { quantity: 0 } });
    expect(writes('POST')).toEqual([]);
    expect(writes('DELETE')).toEqual([]);
    expect(fake.written('update')[0]).toMatchObject({ billingStatus: 'canceled' });
  });

  it('does nothing for a workspace that never billed an inbox', async () => {
    const fake = useDb({ selects: [[workspace({ stripeCustomerId: null })], [access()]] });
    stubStripe({});

    const res = await removeInbox();

    expect(await res.json()).toEqual({ data: { quantity: 0 } });
    expect(stripe.calls).toEqual([]);
    expect(fake.written('update')).toEqual([]);
  });

  it('does not lower the quantity again for a retry of an operation Stripe already applied', async () => {
    useDb({ selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]] });
    stubStripe({
      'GET /v1/subscriptions/sub_1': subscription({}, { quantity: 2, metadata: { lastOp: 'rmb_3:-1' } }),
    });

    const res = await removeInbox('rmb_3');

    expect(await res.json()).toEqual({ data: { quantity: 2 } });
    expect(writes('POST')).toEqual([]);
  });

  it('stays possible while access is suspended: removing an inbox only lowers the bill', async () => {
    useDb({
      selects: [[workspace()], [access({ status: 'suspended', stripeSubscriptionId: 'sub_1', billingStatus: 'active' })]],
    });
    stubStripe({
      'GET /v1/subscriptions/sub_1': subscription(),
      'POST /v1/subscription_items/si_1': { id: 'si_1', quantity: 2 },
    });

    expect((await removeInbox()).status).toBe(200);
  });

  it('keeps the past_due status when an inbox is removed from a past due subscription', async () => {
    const fake = useDb({
      selects: [[workspace()], [access({ stripeSubscriptionId: 'sub_1', billingStatus: 'past_due' })]],
    });
    stubStripe({
      'GET /v1/subscriptions/sub_1': subscription({ status: 'past_due' }),
      'POST /v1/subscription_items/si_1': { id: 'si_1', quantity: 2 },
    });

    expect((await removeInbox()).status).toBe(200);
    expect(fake.written('update')).toEqual([]);
  });

  it('records a found-by-search subscription on the row', async () => {
    const fake = useDb({ selects: [[workspace()], [access()]] });
    stubStripe({
      'GET /v1/subscriptions': { data: [subscription({ id: 'sub_lost' }, { id: 'si_lost', quantity: 2 })] },
      'POST /v1/subscription_items/si_lost': { id: 'si_lost', quantity: 1 },
    });

    expect(await (await removeInbox()).json()).toEqual({ data: { quantity: 1 } });
    expect(fake.written('update')[0]).toMatchObject({ stripeSubscriptionId: 'sub_lost', billingStatus: 'active' });
  });
});
