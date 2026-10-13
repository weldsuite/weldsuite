/**
 * /api/reach/billing: the proxy to billing-worker. The real client runs against
 * a stubbed fetch, so the path, the method, the body and the forwarded Clerk
 * token are all checked as billing-worker would see them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { BILLING_WORKER_PRODUCTION_URL } from '@weldsuite/worker-kit/billing-worker';
import { createReachBilling, PaymentMethodRequiredError, ReachBillingError } from '../../lib/billing';
import { approvedAccess, withAppAccess } from '../../lib/mailpool/testing-routes';
import { default as billingRoutes } from './index';

const summary = {
  status: 'active',
  hasPaymentMethod: true,
  inboxCount: 3,
  unitAmountCents: 500,
  currency: 'usd',
  currentPeriodEnd: '2026-11-12T00:00:00.000Z',
};

let fetchMock: ReturnType<typeof vi.fn>;

function api(keys: string[]) {
  return createTestApp('/api/reach/billing', withAppAccess(billingRoutes, approvedAccess()), {
    context: { permissions: permissions(...keys) },
    // Production resolves the HTTPS billing-worker URL, the only one the caller's token is forwarded to.
    env: { ENVIRONMENT: 'production' } as never,
  }).request;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: summary }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const authed = { headers: { Authorization: 'Bearer clerk_jwt', 'Content-Type': 'application/json' } };

describe('GET /api/reach/billing', () => {
  it('returns billing-worker\'s subscription summary, forwarding the caller\'s token', async () => {
    const res = await api(['reach_settings:read'])('/api/reach/billing', authed);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: summary });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BILLING_WORKER_PRODUCTION_URL}/api/billing/reach/status`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer clerk_jwt');
  });

  it('needs reach_settings:read', async () => {
    expect((await api(['reach_mailboxes:read'])('/api/reach/billing', authed)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 without leaking billing-worker\'s details when it fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'STRIPE_DOWN', message: 'stripe key sk_live_abc invalid' } }), { status: 500 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await api(['reach_settings:read'])('/api/reach/billing', authed);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sk_live');
    error.mockRestore();
  });

  it('answers 502 when billing-worker cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await api(['reach_settings:read'])('/api/reach/billing', authed)).status).toBe(502);
    error.mockRestore();
  });
});

describe('POST /api/reach/billing/setup', () => {
  const body = { successUrl: 'https://app.weldsuite.org/weldreach/setup?ok=1', cancelUrl: 'https://app.weldsuite.org/weldreach/setup' };

  it('starts a setup-mode Checkout through billing-worker', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: 'https://checkout.stripe.com/c/pay/cs_test' } }), { status: 200 }));

    const res = await api(['reach_mailboxes:create'])('/api/reach/billing/setup', { method: 'POST', body: JSON.stringify(body), ...authed });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/pay/cs_test' } });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BILLING_WORKER_PRODUCTION_URL}/api/billing/reach/setup`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('validates the URLs and needs reach_mailboxes:create', async () => {
    const post = (keys: string[], payload: unknown) =>
      api(keys)('/api/reach/billing/setup', { method: 'POST', body: JSON.stringify(payload), ...authed });

    expect((await post(['reach_mailboxes:create'], { successUrl: 'nope', cancelUrl: 'x' })).status).toBe(400);
    expect((await post(['reach_settings:read'], body)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createReachBilling', () => {
  const ctx = { env: { ENVIRONMENT: 'production' }, req: { header: () => 'Bearer clerk_jwt' } };

  it('adjusts the inbox quantity by mailbox', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { quantity: 4 } }), { status: 200 }));
    const result = await createReachBilling(ctx).adjustInboxes(1, 'rmbx_1');

    expect(result).toEqual({ quantity: 4 });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BILLING_WORKER_PRODUCTION_URL}/api/billing/reach/inboxes`);
    expect(JSON.parse(init.body as string)).toEqual({ delta: 1, mailboxId: 'rmbx_1' });
  });

  it('turns a 402 PAYMENT_METHOD_REQUIRED into its own error, and other failures into ReachBillingError', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'PAYMENT_METHOD_REQUIRED' } }), { status: 402 }));
    await expect(createReachBilling(ctx).adjustInboxes(1, 'rmbx_1')).rejects.toBeInstanceOf(PaymentMethodRequiredError);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'X', message: 'boom' } }), { status: 500 }));
    await expect(createReachBilling(ctx).adjustInboxes(-1, 'rmbx_1')).rejects.toMatchObject({ status: 500, code: 'X' });

    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(createReachBilling(ctx).status()).rejects.toBeInstanceOf(ReachBillingError);
  });
});
