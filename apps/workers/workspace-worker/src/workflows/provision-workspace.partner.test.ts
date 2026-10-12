/**
 * ProvisionWorkspaceWorkflow for a partner-managed workspace: the licence (not
 * the signup payload) decides the installed apps and the credits, the owner is
 * invited once the database exists, and Stripe billing is skipped. A direct
 * workspace keeps the old behaviour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { workspaceInstalledApps } from '@weldsuite/db/schema/workspace-installed-apps';

const state = {
  partnerContext: null as null | { allowedApps: string[]; monthlyCredits: number; creditRolloverCap: number },
  workspaceRow: { clerkOrgId: 'org_1', billingMode: 'direct', planId: 'plan_free' } as Record<string, unknown>,
  inserts: [] as Array<{ table: unknown; values: unknown }>,
};

/** Any query chain: awaiting it yields `result`; insert().values() is recorded. */
function chain(result: unknown, record?: { table: unknown }): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
        return (...args: unknown[]) => {
          if (record && prop === 'values') state.inserts.push({ table: record.table, values: args[0] });
          return chain(result, record);
        };
      },
    },
  );
}
const fakeDb = {
  select: () => chain([state.workspaceRow]),
  insert: (table: unknown) => chain([], { table }),
  update: () => chain([]),
};

vi.mock('drizzle-orm/neon-http', () => ({ drizzle: () => fakeDb }));
vi.mock('@neondatabase/serverless', () => ({ neon: () => ({}) }));
vi.mock('../db', () => ({ getMasterDb: () => fakeDb }));
vi.mock('../lib/tenant-migrations', () => ({ applyTenantMigrations: async () => ({ applied: 0, skipped: 0, remaining: 0 }) }));
vi.mock('../services/mail-provisioning', () => ({ provisionMailDomain: vi.fn() }));
vi.mock('../services/provisioning', () => ({
  setupWorkspaceBilling: vi.fn(async () => ({ customerId: 'cus_1', subscriptionId: 'sub_1' })),
  resolveOwnerEmail: vi.fn(async () => 'owner@example.com'),
}));
vi.mock('../services/partner-onboarding', () => ({ ensurePartnerOwnerInvited: vi.fn(async () => true) }));
vi.mock('@weldsuite/core-domain/partners', () => ({
  getPartnerProvisionContext: vi.fn(async () => state.partnerContext),
  initialiseLicensedCredits: vi.fn(async () => ({ granted: 3000 })),
}));
vi.mock('./seed-data', () => ({ seedSampleData: vi.fn(async () => ({ seeded: [], errors: [] })) }));

import { initialiseLicensedCredits } from '@weldsuite/core-domain/partners';
import { ensurePartnerOwnerInvited } from '../services/partner-onboarding';
import { setupWorkspaceBilling } from '../services/provisioning';
import { ProvisionWorkspaceWorkflow, type ProvisionWorkspaceParams } from './provision-workspace';
import type { Env } from '../index';

async function run(params: Partial<ProvisionWorkspaceParams> = {}) {
  const steps: string[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      steps.push(name);
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      return fn();
    },
  };
  const wf = new ProvisionWorkspaceWorkflow({} as never, { ENVIRONMENT: 'test', DATABASE_URL_MASTER: 'x' } as unknown as Env);
  const result = await wf.run(
    { payload: { workspaceId: 'ws_1', databaseUrl: 'postgres://t', workspaceName: 'Acme', slug: 'acme', ...params } } as never,
    step as never,
  );
  return { steps, result };
}

const installedAppCodes = () =>
  state.inserts
    .filter((i) => i.table === workspaceInstalledApps)
    .map((i) => (i.values as { appCode: string }).appCode)
    .sort();

beforeEach(() => {
  vi.clearAllMocks();
  state.inserts = [];
  state.partnerContext = null;
  state.workspaceRow = { clerkOrgId: 'org_1', billingMode: 'direct', planId: 'plan_free' };
});

describe('ProvisionWorkspaceWorkflow · partner-managed workspace', () => {
  beforeEach(() => {
    state.partnerContext = { allowedApps: ['weldcrm'], monthlyCredits: 3000, creditRolloverCap: 0 };
    state.workspaceRow = { clerkOrgId: 'org_1', billingMode: 'partner', planId: 'plan_business' };
  });

  it('installs the licensed apps, not the payload\'s', async () => {
    await run({ selectedApps: ['weldcrm', 'welddesk', 'weldbooks'] });
    expect(installedAppCodes()).toEqual(['weldcrm']);
  });

  it('grants the licence credits through applyLicenceCredits instead of the plan allocation', async () => {
    const { steps } = await run({ selectedApps: ['weldcrm'] });
    expect(initialiseLicensedCredits).toHaveBeenCalledWith(expect.anything(), 'ws_1', state.partnerContext);
    expect(steps).toContain('initialize-credits');
    // the plan-credit path writes workspace_credits / credit_transactions itself
    expect(state.inserts.some((i) => i.table === masterSchema.workspaceCredits)).toBe(false);
  });

  it('skips Stripe billing', async () => {
    const { steps } = await run({ selectedApps: ['weldcrm'] });
    expect(steps).toContain('setup-billing');
    expect(setupWorkspaceBilling).not.toHaveBeenCalled();
  });

  it('invites the workspace owner once the database is provisioned', async () => {
    const { steps } = await run({ selectedApps: ['weldcrm'] });
    expect(ensurePartnerOwnerInvited).toHaveBeenCalledWith(expect.anything(), 'org_1');
    expect(steps.indexOf('invite-owner')).toBeGreaterThan(steps.indexOf('mark-provisioned'));
  });

  it('carries on provisioning when the owner invitation fails', async () => {
    vi.mocked(ensurePartnerOwnerInvited).mockRejectedValue(new Error('clerk down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { steps, result } = await run({ selectedApps: ['weldcrm'] });
    consoleError.mockRestore();
    expect(result).toMatchObject({ provisioned: true });
    expect(steps).toContain('setup-billing');
  });

  it('installs nothing for a licence without apps', async () => {
    state.partnerContext = { allowedApps: [], monthlyCredits: 0, creditRolloverCap: 0 };
    await run({ selectedApps: ['weldcrm'] });
    expect(installedAppCodes()).toEqual([]);
  });
});

describe('ProvisionWorkspaceWorkflow · direct workspace', () => {
  it('keeps the signup flow: payload apps, plan credits, Stripe billing, no owner invite', async () => {
    const { steps } = await run({ selectedApps: ['weldcrm', 'welddesk'] });
    expect(installedAppCodes()).toEqual(['weldcrm', 'welddesk']);
    expect(initialiseLicensedCredits).not.toHaveBeenCalled();
    expect(setupWorkspaceBilling).toHaveBeenCalledTimes(1);
    expect(ensurePartnerOwnerInvited).not.toHaveBeenCalled();
    expect(steps).not.toContain('invite-owner');
  });

  it('skips billing for any workspace whose row says partner, even without a licence context', async () => {
    state.workspaceRow = { clerkOrgId: 'org_1', billingMode: 'partner', planId: null };
    await run({ selectedApps: ['weldcrm'] });
    expect(setupWorkspaceBilling).not.toHaveBeenCalled();
  });
});
