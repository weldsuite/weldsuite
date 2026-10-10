/**
 * Workspace-facing reseller rules in the billing and credits routes:
 *   - PARTNER_MANAGED on billing / credit mutations of a partner workspace
 *   - PARTNER_TERRITORY on checkout for a direct workspace with no subscription
 *   - GET /api/billing/managed
 *   - `partnerManaged` on the plans endpoints
 *
 * The partner tables are not in pglite, so the master-DB lookups are mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';

const state = vi.hoisted(() => ({ limitRows: [] as unknown[], orderByRows: [] as unknown[] }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = async () => state.limitRows;
  chain.orderBy = async () => state.orderByRows;
  return { ...actual, getMasterDb: () => chain };
});

vi.mock('../services/partner/managed', async (orig) => {
  const actual = await orig<typeof import('../services/partner/managed')>();
  return { ...actual, getManagedContext: vi.fn(), territoryPartnerInfo: vi.fn() };
});
vi.mock('../services/billing', async (orig) => {
  const actual = await orig<typeof import('../services/billing')>();
  return {
    ...actual,
    getWorkspaceByOrgId: vi.fn(),
    getPlanById: vi.fn(),
    getAccurateMemberCount: vi.fn(async () => 3),
  };
});
vi.mock('../services/plan-country-pricing', async (orig) => {
  const actual = await orig<typeof import('../services/plan-country-pricing')>();
  return {
    ...actual,
    resolvePlanPricesForCaller: vi.fn(async () => ({ country: 'BR', currency: null, plans: {} })),
  };
});
vi.mock('@weldsuite/core-domain/partners', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/core-domain/partners')>();
  return { ...actual, creditsUsedBetween: vi.fn(async () => 120) };
});

import { billingRoutes } from './billing';
import { creditsRoutes } from './credits';
import * as managed from '../services/partner/managed';
import * as billingService from '../services/billing';

const mManaged = vi.mocked(managed.getManagedContext);
const mTerritory = vi.mocked(managed.territoryPartnerInfo);
const mWorkspace = vi.mocked(billingService.getWorkspaceByOrgId);
const mPlan = vi.mocked(billingService.getPlanById);

const PARTNER = { id: 'ptr_1', name: 'Acme Reseller', logoUrl: null, websiteUrl: 'https://acme.test', supportEmail: 'help@acme.test', supportUrl: null };

const env = {
  DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db',
  STRIPE_SECRET_KEY: 'sk_test',
};

function billing(perms: string[] = ['billing:manage']) {
  return createTestApp('/api/billing', billingRoutes, { context: { permissions: permissions(...perms) }, env });
}

const MANAGED = {
  workspaceId: 'ws_1',
  partner: PARTNER,
  partnerStatus: 'active' as const,
  licence: { status: 'active' as const, allowedApps: ['welddesk'], monthlyCredits: 3000, maxSeats: 10 },
};

const post = (body: unknown = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  state.limitRows = [];
  state.orderByRows = [];
  mManaged.mockResolvedValue(null);
  mTerritory.mockResolvedValue(null);
});

describe('PARTNER_MANAGED guard', () => {
  const mutations: Array<[string, string, unknown]> = [
    ['POST', '/api/billing/checkout', { planId: 'pln_1', seats: 2, cycle: 'monthly' }],
    ['POST', '/api/billing/seats', { seatCount: 4 }],
    ['POST', '/api/billing/cancel', {}],
    ['POST', '/api/billing/reactivate', {}],
    ['POST', '/api/billing/payment-methods/setup-intent', {}],
    ['POST', '/api/billing/payment-methods/pm_1/default', {}],
    ['DELETE', '/api/billing/payment-methods/pm_1', undefined],
  ];

  it.each(mutations)('refuses %s %s on a partner workspace', async (method, path, body) => {
    mManaged.mockResolvedValue(MANAGED);
    const { request } = billing();
    const res = await request(path, method === 'DELETE' ? { method } : post(body));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; details: { partner: { name: string } } } };
    expect(json.error.code).toBe('PARTNER_MANAGED');
    expect(json.error.details.partner.name).toBe('Acme Reseller');
    expect(mWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a credit top-up checkout on a partner workspace', async () => {
    mManaged.mockResolvedValue(MANAGED);
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:manage') },
      env,
    });
    const res = await request('/api/credits/checkout', post({ packageId: 'pkg_1' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PARTNER_MANAGED');
  });

  it('checks the permission first: no billing:manage is a plain 403', async () => {
    mManaged.mockResolvedValue(MANAGED);
    const { request } = billing(['billing:read']);
    const res = await request('/api/billing/cancel', post());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/billing/checkout territory', () => {
  const body = { planId: 'pln_1', seats: 5, cycle: 'monthly' };
  const workspace = { id: 'ws_1', name: 'Customer', stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null };

  beforeEach(() => {
    mWorkspace.mockResolvedValue(workspace as never);
    mPlan.mockResolvedValue({ id: 'pln_1', slug: 'business', name: 'Business', maxUsers: null } as never);
  });

  it('answers 409 PARTNER_TERRITORY with the partner for a workspace with no subscription', async () => {
    mTerritory.mockResolvedValue(PARTNER);
    const res = await billing().request('/api/billing/checkout', post(body));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'PARTNER_TERRITORY',
        message: 'WeldSuite in BR is provided by Acme Reseller.',
        details: { country: 'BR', partner: PARTNER },
      },
    });
  });

  it('also closes checkout when the old subscription was canceled', async () => {
    mTerritory.mockResolvedValue(PARTNER);
    mWorkspace.mockResolvedValue({ ...workspace, stripeSubscriptionId: 'sub_1', subscriptionStatus: 'canceled' } as never);
    const res = await billing().request('/api/billing/checkout', post(body));
    expect(res.status).toBe(409);
  });

  it('leaves a workspace with a running subscription alone', async () => {
    mTerritory.mockResolvedValue(PARTNER);
    mWorkspace.mockResolvedValue({ ...workspace, stripeSubscriptionId: 'sub_1', subscriptionStatus: 'active' } as never);
    const res = await billing().request('/api/billing/checkout', post(body));
    // Past the territory check (the plan is "on request" in this test: a 400, not a 409).
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('on request');
    expect(mTerritory).not.toHaveBeenCalled();
  });

  it('lets a country without a partner check out as before', async () => {
    mTerritory.mockResolvedValue(null);
    const res = await billing().request('/api/billing/checkout', post(body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('on request');
  });
});

describe('GET /api/billing/managed', () => {
  it('is null for a direct workspace', async () => {
    const res = await billing([]).request('/api/billing/managed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it('describes a partner workspace: partner, licence, usage and read-only state', async () => {
    mManaged.mockResolvedValue(MANAGED);
    state.limitRows = [{ balance: 2400 }];
    const res = await billing([]).request('/api/billing/managed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        partner: PARTNER,
        partnerStatus: 'active',
        licence: { status: 'active', allowedApps: ['welddesk'], monthlyCredits: 3000, maxSeats: 10 },
        creditsUsedThisPeriod: 120,
        creditBalance: 2400,
        activeMembers: 3,
        readOnly: false,
      },
    });
  });

  it('is read-only when the partner is suspended or the licence is not active', async () => {
    state.limitRows = [];
    mManaged.mockResolvedValue({ ...MANAGED, partnerStatus: 'suspended' });
    let res = await billing([]).request('/api/billing/managed');
    expect(((await res.json()) as { data: { readOnly: boolean } }).data.readOnly).toBe(true);

    mManaged.mockResolvedValue({ ...MANAGED, licence: { ...MANAGED.licence, status: 'suspended' } });
    res = await billing([]).request('/api/billing/managed');
    expect(((await res.json()) as { data: { readOnly: boolean; creditBalance: number } }).data).toMatchObject({
      readOnly: true,
      creditBalance: 0,
    });
  });
});

describe('plans endpoints', () => {
  it('/plans-page carries the territory partner of the caller’s country', async () => {
    mTerritory.mockResolvedValue(PARTNER);
    const res = await billing([]).request('/api/billing/plans-page');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { partnerManaged: unknown } };
    expect(body.data.partnerManaged).toEqual(PARTNER);
    expect(mTerritory).toHaveBeenCalledWith(expect.anything(), 'BR');
  });

  it('/plans-page has partnerManaged null outside every territory', async () => {
    const res = await billing([]).request('/api/billing/plans-page');
    expect(((await res.json()) as { data: { partnerManaged: unknown } }).data.partnerManaged).toBeNull();
  });

  it('/plans carries partnerManaged on every plan', async () => {
    mTerritory.mockResolvedValue(PARTNER);
    state.orderByRows = [{ id: 'pln_1', name: 'Business', slug: 'business', features: {} }];
    const res = await billing([]).request('/api/billing/plans');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; partnerManaged: unknown }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.partnerManaged).toEqual(PARTNER);
  });
});
