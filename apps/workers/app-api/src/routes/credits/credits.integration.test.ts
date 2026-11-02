/**
 * Every /api/credits route against a real pglite master database, refusals
 * included: the wallet reads (and the empty wallet the first read creates),
 * the transaction pages and filters, the availability check, the packages,
 * the plan's rates, this period's usage, and the checkout's gates.
 *
 * Nothing is mocked but `getMasterDb`, which hands out the test's master
 * database through `conformanceMasterDb`, so the conformance suite runs these
 * against the Rust backend too. The checkout's billing-worker call is only
 * reached here when billing-worker cannot be: the answers it gives when it
 * can are in ./checkout-billing.test.ts, outside the suite (billing is
 * Global-only).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { creditsRoutes } from './index';

const { workspaces, plans, partners, workspaceCredits, creditTransactions, creditPackages } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let tenant: Database;

const now = new Date();
const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const hour = 60 * 60 * 1000;
const at = (offset: number) => new Date(periodStart.getTime() + offset);

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  tenant = (await createPgliteDb()).db;

  await master.insert(plans).values([
    { id: 'plan_cr', name: 'Pro', slug: 'cr-pro', features: { creditRates: { aiTokens: 3, parcelLabel: 12 } } },
    { id: 'plan_cr_plain', name: 'Plain', slug: 'cr-plain', features: {} },
  ]);
  await master.insert(partners).values({
    id: 'ptr_cr',
    name: 'Acme Partner',
    billingEmail: 'billing@acme.test',
    supportEmail: 'help@acme.test',
    websiteUrl: 'https://acme.test',
  });
  await master.insert(workspaces).values([
    { id: 'ws_cr', clerkOrgId: 'org_cr', name: 'Credits', slug: 'cr', planId: 'plan_cr' },
    { id: 'ws_cr_plain', clerkOrgId: 'org_cr_plain', name: 'Plain', slug: 'cr-plain', planId: 'plan_cr_plain' },
    { id: 'ws_cr_new', clerkOrgId: 'org_cr_new', name: 'New', slug: 'cr-new' },
    { id: 'ws_cr_fresh', clerkOrgId: 'org_cr_fresh', name: 'Fresh', slug: 'cr-fresh' },
    {
      id: 'ws_cr_partner',
      clerkOrgId: 'org_cr_partner',
      name: 'Managed',
      slug: 'cr-partner',
      billingMode: 'partner',
      partnerId: 'ptr_cr',
    },
  ]);
  await master.insert(workspaceCredits).values([
    {
      id: 'wcr_cr',
      workspaceId: 'ws_cr',
      currentBalance: 50,
      planCredits: 100,
      subscribedCredits: 100,
      monthlyAllocation: 200,
      rolledOverCredits: 20,
      stripeCreditsItemId: 'si_cr',
      periodStart,
      periodEnd,
    },
    {
      id: 'wcr_cr_plain',
      workspaceId: 'ws_cr_plain',
      currentBalance: 500,
      periodStart,
      periodEnd,
    },
  ]);
  await master.insert(creditTransactions).values([
    { id: 'ctx_cr_1', workspaceId: 'ws_cr', type: 'consumption', amount: -10, balanceAfter: 90, serviceType: 'ai_tokens', createdAt: at(hour) },
    { id: 'ctx_cr_2', workspaceId: 'ws_cr', type: 'consumption', amount: -5, balanceAfter: 85, serviceType: 'ai_tokens', createdAt: at(2 * hour) },
    {
      id: 'ctx_cr_3',
      workspaceId: 'ws_cr',
      type: 'consumption',
      amount: -10,
      balanceAfter: 75,
      serviceType: 'parcel_label',
      referenceId: 'lbl_1',
      referenceType: 'parcel_label',
      metadata: { carrier: 'dhl', trackingNumber: 'JJD01' },
      userId: 'user_cr',
      createdAt: at(3 * hour),
    },
    {
      id: 'ctx_cr_4',
      workspaceId: 'ws_cr',
      type: 'purchase',
      amount: 100,
      balanceAfter: 175,
      amountPaid: '12.50',
      currency: 'EUR',
      stripeCheckoutSessionId: 'cs_cr',
      description: 'Top-up',
      createdAt: at(4 * hour),
    },
    { id: 'ctx_cr_5', workspaceId: 'ws_cr', type: 'consumption', amount: -7, balanceAfter: 60, serviceType: 'ai_tokens', createdAt: at(-24 * hour) },
    { id: 'ctx_cr_plain', workspaceId: 'ws_cr_plain', type: 'consumption', amount: -3, balanceAfter: 500, serviceType: 'sms', createdAt: at(hour) },
  ]);
  await master.insert(creditPackages).values([
    { id: 'pkg_cr_small', name: 'Small', description: '1k credits', credits: 1000, price: '9.99', sortOrder: 2, isPopular: 0 },
    { id: 'pkg_cr_big', name: 'Big', credits: 5000, price: '20.00', currency: 'USD', sortOrder: 1, isPopular: 1, stripePriceId: 'price_big' },
    { id: 'pkg_cr_old', name: 'Retired', credits: 10, price: '1.00', sortOrder: 0, isActive: 0 },
  ]);
}, 60_000);

function app(workspaceId = 'ws_cr', orgId: string | null = 'org_cr', perms = permissions('*')) {
  return createTestApp('/api/credits', creditsRoutes, {
    context: { workspaceId, orgId, tenantDb: tenant, masterDb: master, permissions: perms },
    // A local billing-worker (http://localhost:8788), which the checkout test makes unreachable.
    env: { ENVIRONMENT: 'development' },
  });
}

function post(t: ReturnType<typeof app>, path: string, body: unknown) {
  return t.request(`/api/credits${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ORG_REQUIRED = { error: 'org_required', message: 'Organization context required' };

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: T };
  expect(body.success).toBe(true);
  return body.data;
}

describe('GET /api/credits/balance', () => {
  it('is a 403 without a workspace', async () => {
    const res = await app('').request('/api/credits/balance');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORG_REQUIRED);
  });

  it("reads the workspace's wallet", async () => {
    const balance = await data(await app().request('/api/credits/balance'));
    expect(balance).toEqual({
      currentBalance: 50,
      planCredits: 100,
      subscribedCredits: 100,
      monthlyAllocation: 200,
      rolledOverCredits: 20,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      daysRemaining: expect.any(Number),
      // (200 - 50 + 20) / 200
      usagePercentage: 85,
      isLow: true,
      isExhausted: false,
    });
    expect(balance.daysRemaining).toBeGreaterThanOrEqual(0);
  });

  it('a wallet without an allocation is 0% used and not low above the threshold', async () => {
    const balance = await data(await app('ws_cr_plain').request('/api/credits/balance'));
    expect(balance).toMatchObject({ currentBalance: 500, usagePercentage: 0, isLow: false, isExhausted: false });
  });

  it('creates an empty wallet for this month on the first read', async () => {
    const balance = await data(await app('ws_cr_new').request('/api/credits/balance'));
    expect(balance).toMatchObject({
      currentBalance: 0,
      planCredits: 0,
      monthlyAllocation: 0,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      usagePercentage: 0,
      isLow: true,
      isExhausted: true,
    });
    const rows = await master.select().from(workspaceCredits).where(eq(workspaceCredits.workspaceId, 'ws_cr_new'));
    expect(rows).toHaveLength(1);
  });
});

describe('GET /api/credits/transactions', () => {
  it('is a 403 without a workspace', async () => {
    const res = await app('').request('/api/credits/transactions');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORG_REQUIRED);
  });

  it("pages the workspace's transactions, newest first", async () => {
    const res = await app().request('/api/credits/transactions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; pagination: unknown };
    expect(body.data.map((t) => t.id)).toEqual(['ctx_cr_4', 'ctx_cr_3', 'ctx_cr_2', 'ctx_cr_1', 'ctx_cr_5']);
    expect(body.pagination).toEqual({ page: 1, pageSize: 20, totalCount: 5, totalPages: 1, hasMore: false });
    expect(body.data[0]).toMatchObject({
      type: 'purchase',
      amount: 100,
      amountPaid: '12.50',
      currency: 'EUR',
      createdAt: at(4 * hour).toISOString(),
    });
    expect(body.data[1]).toMatchObject({ metadata: { carrier: 'dhl', trackingNumber: 'JJD01' }, userId: 'user_cr' });
  });

  it('filters by type and service, and pages by page and pageSize', async () => {
    const ids = async (query: string) => {
      const res = await app().request(`/api/credits/transactions${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { data: Array<{ id: string }>; pagination: unknown };
    };
    expect((await ids('?type=consumption&serviceType=ai_tokens')).data.map((t) => t.id)).toEqual([
      'ctx_cr_2',
      'ctx_cr_1',
      'ctx_cr_5',
    ]);
    // An empty filter is no filter.
    expect((await ids('?type=&serviceType=')).data).toHaveLength(5);
    const page = await ids('?pageSize=2&page=2');
    expect(page.data.map((t) => t.id)).toEqual(['ctx_cr_2', 'ctx_cr_1']);
    expect(page.pagination).toEqual({ page: 2, pageSize: 2, totalCount: 5, totalPages: 3, hasMore: true });
    const beyond = await ids('?page=9');
    expect(beyond.data).toEqual([]);
    expect(beyond.pagination).toMatchObject({ page: 9, hasMore: false });
  });

  it('filters by a from/to window, as timestamps or dates', async () => {
    const window = new URLSearchParams({ from: periodStart.toISOString(), to: at(2.5 * hour).toISOString() });
    const res = await app().request(`/api/credits/transactions?${window}`);
    expect(((await res.json()) as { data: Array<{ id: string }> }).data.map((t) => t.id)).toEqual([
      'ctx_cr_2',
      'ctx_cr_1',
    ]);
    const since = periodStart.toISOString().slice(0, 10);
    const dated = await app().request(`/api/credits/transactions?from=${since}`);
    expect(((await dated.json()) as { pagination: { totalCount: number } }).pagination.totalCount).toBe(4);
  });

  it('refuses a page below 1 and a page size above 100', async () => {
    for (const query of ['?page=0', '?pageSize=101', '?pageSize=abc', '?type=a&type=b']) {
      const res = await app().request(`/api/credits/transactions${query}`);
      expect(res.status).toBe(400);
    }
  });

  it('fails on a date it cannot read', async () => {
    const res = await app().request('/api/credits/transactions?from=yesterday');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error', message: 'Failed to fetch transactions' });
  });
});

describe('POST /api/credits/check', () => {
  it('validates the amount', async () => {
    for (const body of [{ amount: 0 }, {}, { amount: '5' }]) {
      const res = await post(app(), '/check', body);
      expect(res.status).toBe(400);
    }
  });

  it('is a 403 without a workspace', async () => {
    const res = await post(app(''), '/check', { amount: 5 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORG_REQUIRED);
  });

  it('answers whether the balance covers an amount, and by how much it falls short', async () => {
    expect(await data(await post(app(), '/check', { amount: 30 }))).toEqual({
      available: true,
      currentBalance: 50,
      required: 30,
      shortfall: 0,
    });
    expect(await data(await post(app(), '/check', { amount: 80 }))).toEqual({
      available: false,
      currentBalance: 50,
      required: 80,
      shortfall: 30,
      message: 'Insufficient credits. You need 30 more credits.',
    });
    expect(await data(await post(app(), '/check', { amount: 50.5 }))).toMatchObject({
      available: false,
      shortfall: 0.5,
      message: 'Insufficient credits. You need 0.5 more credits.',
    });
  });

  it('creates the empty wallet of a workspace that has none', async () => {
    expect(await data(await post(app('ws_cr_fresh'), '/check', { amount: 1 }))).toMatchObject({
      available: false,
      currentBalance: 0,
      shortfall: 1,
    });
    const [row] = await master.select().from(workspaceCredits).where(eq(workspaceCredits.workspaceId, 'ws_cr_fresh'));
    expect(row).toMatchObject({ currentBalance: 0, monthlyAllocation: 0 });
    expect(row.periodStart.toISOString()).toBe(periodStart.toISOString());
    expect(row.periodEnd.toISOString()).toBe(periodEnd.toISOString());
  });
});

describe('GET /api/credits/packages', () => {
  it('lists the active packages in their order, prices as numbers', async () => {
    expect(await data(await app().request('/api/credits/packages'))).toEqual([
      {
        id: 'pkg_cr_big',
        name: 'Big',
        description: null,
        credits: 5000,
        price: 20,
        currency: 'USD',
        stripePriceId: 'price_big',
        isPopular: true,
      },
      {
        id: 'pkg_cr_small',
        name: 'Small',
        description: '1k credits',
        credits: 1000,
        price: 9.99,
        currency: 'EUR',
        stripePriceId: null,
        isPopular: false,
      },
    ]);
  });
});

describe('GET /api/credits/rates', () => {
  const DEFAULTS = {
    aiTokens: 1,
    parcelLabel: 10,
    meetingBotMinute: 2,
    callTranscriptionMinute: 2,
    voipCallMinute: 3,
    transcriptionProvider: 'assemblyai',
    hunterEmailFinder: 2,
    hunterEmailVerifier: 1,
    hunterDomainSearch: 5,
  };

  it('is a 403 without a workspace', async () => {
    const res = await app('').request('/api/credits/rates');
    expect(res.status).toBe(403);
  });

  it("overrides the defaults with the plan's credit rates", async () => {
    expect(await data(await app().request('/api/credits/rates'))).toEqual({ ...DEFAULTS, aiTokens: 3, parcelLabel: 12 });
  });

  it('keeps the defaults for a plan without rates and a workspace without a plan', async () => {
    expect(await data(await app('ws_cr_plain').request('/api/credits/rates'))).toEqual(DEFAULTS);
    expect(await data(await app('ws_cr_new').request('/api/credits/rates'))).toEqual(DEFAULTS);
    expect(await data(await app('ws_cr_unknown').request('/api/credits/rates'))).toEqual(DEFAULTS);
  });
});

describe('GET /api/credits/usage', () => {
  it('is a 403 without a workspace', async () => {
    const res = await app('').request('/api/credits/usage');
    expect(res.status).toBe(403);
  });

  it("sums this period's consumption by service", async () => {
    expect(await data(await app().request('/api/credits/usage'))).toEqual({
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      totalAllocated: 220,
      totalConsumed: 25,
      totalRemaining: 50,
      byService: {
        ai_tokens: { credits: 15, count: 2 },
        parcel_label: { credits: 10, count: 1 },
      },
    });
  });
});

describe('GET /api/credits/subscription', () => {
  it('is a 403 without a workspace', async () => {
    const res = await app('').request('/api/credits/subscription');
    expect(res.status).toBe(403);
  });

  it('reads the subscribed allocation and its Stripe item', async () => {
    expect(await data(await app().request('/api/credits/subscription'))).toEqual({
      planCredits: 100,
      subscribedCredits: 100,
      totalMonthly: 200,
      stripeItemId: 'si_cr',
      stripePriceId: null,
    });
  });
});

describe('POST /api/credits/checkout', () => {
  const valid = {
    packageId: 'pkg_cr_big',
    successUrl: 'https://app.weldsuite.org/settings/billing?credits=success',
    cancelUrl: 'http://localhost:5173/settings/billing',
  };

  it('needs billing:manage, before the partner check', async () => {
    for (const [workspace, org] of [
      ['ws_cr', 'org_cr'],
      ['ws_cr_partner', 'org_cr_partner'],
    ]) {
      const res = await post(app(workspace, org, permissions('billing:read')), '/checkout', valid);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    }
  });

  it('refuses a partner-managed workspace, naming its partner', async () => {
    const res = await post(app('ws_cr_partner', 'org_cr_partner'), '/checkout', { packageId: '' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'PARTNER_MANAGED',
        message: 'This workspace is billed by Acme Partner. Contact them to change your subscription.',
        details: {
          partner: {
            id: 'ptr_cr',
            name: 'Acme Partner',
            logoUrl: null,
            websiteUrl: 'https://acme.test',
            supportEmail: 'help@acme.test',
            supportUrl: null,
          },
        },
      },
    });
  });

  it('validates the package and keeps the return URLs on platform origins', async () => {
    const missing = await post(app(), '/checkout', {});
    expect(missing.status).toBe(400);
    const foreign = await post(app(), '/checkout', {
      packageId: 'pkg_cr_big',
      successUrl: 'not a url',
      cancelUrl: 'https://evil.example/return',
    });
    expect(foreign.status).toBe(400);
    const body = (await foreign.json()) as { error: { issues: Array<{ path: string[]; code: string }> } };
    expect(body.error.issues.map((i) => [i.path[0], i.code])).toEqual([
      ['successUrl', 'invalid_string'],
      ['successUrl', 'custom'],
      ['cancelUrl', 'custom'],
    ]);
  });

  it('needs an organization once the body is valid', async () => {
    const res = await post(app('ws_cr', null), '/checkout', valid);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORG_REQUIRED');
  });

  it('fails when billing-worker cannot be reached', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Connection refused, as undici reports it.
      if (url.startsWith('http://localhost:8788/')) return Promise.reject(new TypeError('fetch failed'));
      return realFetch(input, init);
    });
    try {
      const res = await post(app(), '/checkout', valid);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'fetch failed' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
