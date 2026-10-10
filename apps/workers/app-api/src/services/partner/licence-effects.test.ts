/**
 * What follows a licence write: installed apps, credits, Clerk seat cap and
 * the workspace-context cache. The master-DB services are mocked (no partner
 * tables in pglite); these tests pin the arguments and the failure policy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tenantDb = vi.hoisted(() => ({ tenant: true }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: vi.fn(async () => tenantDb) };
});
vi.mock('@weldsuite/core-domain/partners', () => ({
  applyLicenceCredits: vi.fn(async () => ({ granted: 0 })),
  countActiveMembers: vi.fn(async () => new Map([['ws_1', 4]])),
  invalidateWorkspaceContexts: vi.fn(async () => undefined),
  syncInstalledAppsToLicence: vi.fn(async () => ({ installed: [], deactivated: [] })),
}));
vi.mock('../billing', () => ({ syncClerkSeatLimit: vi.fn(async () => undefined) }));

import * as domain from '@weldsuite/core-domain/partners';
import { getTenantDbForWorkspace, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { LicenceSnapshot } from '@weldsuite/app-api-client/schemas/partners';
import { syncClerkSeatLimit } from '../billing';
import { applyLicenceEffects, clerkSeatCap } from './licence-effects';
import type { Env } from '../../types';

const kv = { delete: vi.fn() };
const env = { CLERK_SECRET_KEY: 'sk_test', WORKSPACE_CACHE: kv } as unknown as Env;
const masterDb = { master: true } as unknown as MasterDatabase;

const licence: LicenceSnapshot = {
  status: 'active',
  allowedApps: ['welddesk'],
  monthlyCredits: 3000,
  creditRolloverCap: 100,
  maxSeats: 10,
  featurePlanId: 'pln_business',
  storageGb: null,
  resalePricing: { model: 'flat', amount: '199.00' },
  packageId: null,
};

const input = (overrides: Partial<Parameters<typeof applyLicenceEffects>[0]> = {}) => ({
  env,
  masterDb,
  workspace: { id: 'ws_1', clerkOrgId: 'org_1' },
  licence,
  previous: { ...licence, monthlyCredits: 1000 },
  changeId: 'wlc_1',
  actor: { id: 'user_1', type: 'partner' as const },
  ...overrides,
});

beforeEach(() => vi.clearAllMocks());

describe('clerkSeatCap', () => {
  it('clears the cap when seats are unlimited', () => {
    expect(clerkSeatCap(null, 7)).toBe(0);
  });
  it('uses the licence seat cap', () => {
    expect(clerkSeatCap(10, 4)).toBe(10);
  });
  it('never goes below who is already in', () => {
    expect(clerkSeatCap(3, 5)).toBe(5);
  });
});

describe('applyLicenceEffects', () => {
  it('syncs apps on the tenant DB, applies the credit allowance, sets the Clerk cap and drops the cache', async () => {
    const res = await applyLicenceEffects(input());

    expect(res.warnings).toEqual([]);
    expect(getTenantDbForWorkspace).toHaveBeenCalledWith(env, 'org_1');
    expect(domain.syncInstalledAppsToLicence).toHaveBeenCalledWith({
      tenantDb,
      allowedApps: ['welddesk'],
      actorUserId: 'user_1',
    });
    expect(domain.applyLicenceCredits).toHaveBeenCalledWith({
      db: masterDb,
      workspaceId: 'ws_1',
      previousMonthlyCredits: 1000,
      monthlyCredits: 3000,
      creditRolloverCap: 100,
      changeId: 'wlc_1',
    });
    expect(syncClerkSeatLimit).toHaveBeenCalledWith('sk_test', 'org_1', 10);
    expect(domain.invalidateWorkspaceContexts).toHaveBeenCalledWith(kv, ['org_1']);
  });

  it('treats a first licence as having no previous credits', async () => {
    await applyLicenceEffects(input({ previous: null }));
    expect(domain.applyLicenceCredits).toHaveBeenCalledWith(expect.objectContaining({ previousMonthlyCredits: null }));
  });

  it('leaves installed apps alone while the licence is not active', async () => {
    await applyLicenceEffects(input({ licence: { ...licence, status: 'suspended' } }));
    expect(domain.syncInstalledAppsToLicence).not.toHaveBeenCalled();
    // Everything else still runs: the gate and read-only mode read the cache.
    expect(domain.invalidateWorkspaceContexts).toHaveBeenCalled();
  });

  it('removes the Clerk cap for unlimited seats', async () => {
    await applyLicenceEffects(input({ licence: { ...licence, maxSeats: null } }));
    expect(syncClerkSeatLimit).toHaveBeenCalledWith('sk_test', 'org_1', 0);
  });

  it('keeps going and reports which step failed', async () => {
    vi.mocked(domain.syncInstalledAppsToLicence).mockRejectedValueOnce(new Error('tenant not ready'));
    vi.mocked(domain.applyLicenceCredits).mockRejectedValueOnce(new Error('db'));
    const res = await applyLicenceEffects(input());
    expect(res.warnings).toEqual(['installed_apps', 'credits']);
    expect(syncClerkSeatLimit).toHaveBeenCalled();
    expect(domain.invalidateWorkspaceContexts).toHaveBeenCalled();
  });

  it('skips the tenant and Clerk steps for a workspace without an org id', async () => {
    await applyLicenceEffects(input({ workspace: { id: 'ws_1', clerkOrgId: null } }));
    expect(getTenantDbForWorkspace).not.toHaveBeenCalled();
    expect(syncClerkSeatLimit).not.toHaveBeenCalled();
    expect(domain.applyLicenceCredits).toHaveBeenCalled();
  });
});
