/**
 * POST /api/credits/checkout when billing-worker answers: the Checkout URL,
 * and how its refusals map onto the API's errors. Against a pglite master
 * (the partner-managed check reads it) and a stubbed billing-worker,
 * answering by URL.
 *
 * Left out of the Rust conformance suite on purpose: billing (Stripe, through
 * billing-worker) is Global-only, so the Rust backend never reaches it and
 * answers as when billing-worker cannot be reached
 * (./credits.integration.test.ts covers that and every other route).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master };
});

import { creditsRoutes } from './index';

const CHECKOUT = 'https://billing-worker-test.weldsuite.org/api/billing/credits/checkout';

let tenant: Database;

beforeAll(async () => {
  const master = (await createMasterPgliteDb()).db;
  state.master = master;
  tenant = (await createPgliteDb()).db;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: 'ws_cb', clerkOrgId: 'org_cb', name: 'Billing', slug: 'cb' });
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** billing-worker's checkout answering `status` with `body`; other URLs go out as usual. */
function stubBilling(status: number, body: unknown) {
  const realFetch = globalThis.fetch;
  const billing = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json(body, { status }),
  );
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === CHECKOUT) return billing(url, init);
    return realFetch(input, init);
  });
  return billing;
}

function checkout(body: unknown = { packageId: 'pkg_cb' }) {
  const { request } = createTestApp('/api/credits', creditsRoutes, {
    context: { workspaceId: 'ws_cb', orgId: 'org_cb', tenantDb: tenant, permissions: permissions('billing:manage') },
  });
  return request('/api/credits/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token_cb' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/credits/checkout with billing-worker', () => {
  it('answers the Checkout URL and forwards the body and the caller’s token', async () => {
    const billing = stubBilling(200, { url: 'https://checkout.stripe.com/c/pay/cs_cb' });
    const res = await checkout({ packageId: 'pkg_cb', successUrl: 'https://app.weldsuite.org/done' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/pay/cs_cb' } });
    const [, init = {}] = billing.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ packageId: 'pkg_cb', successUrl: 'https://app.weldsuite.org/done' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token_cb');
  });

  it("maps billing-worker's 400 and 404", async () => {
    stubBilling(400, { error: 'Package is not for sale' });
    const bad = await checkout();
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Package is not for sale' } });

    stubBilling(404, { error: 'No such package' });
    const missing = await checkout();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Credit package not found' } });
  });

  it('fails when billing-worker answers without a URL', async () => {
    stubBilling(200, {});
    const res = await checkout();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Billing worker returned no checkout URL' },
    });
  });
});
