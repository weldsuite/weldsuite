import { describe, it, expect, vi, beforeEach } from 'vitest';

const tenantDbFor = vi.fn(async (_env: unknown, workspaceId: string) => ({ workspaceId }));
const activeWorkspaces = [
  { id: 'ws_1', clerkOrgId: 'org_1', stripeCustomerId: 'cus_1' },
  { id: 'ws_2', clerkOrgId: 'org_2', stripeCustomerId: 'cus_2' },
  { id: 'ws_3', clerkOrgId: 'org_3', stripeCustomerId: null },
  { id: 'ws_4', clerkOrgId: null, stripeCustomerId: 'cus_4' },
];
// Master reads: the backfill lists every active workspace; the sweep lists
// the active ones among the due ids (the where clause is opaque here, so the
// test filters by the ids the index returned).
let dueIds: string[] = [];
const masterWorkspaces = vi.fn(async (kind: 'backfill' | 'due') =>
  kind === 'backfill'
    ? activeWorkspaces
    : activeWorkspaces.filter((w) => w.clerkOrgId && dueIds.includes(w.clerkOrgId)),
);
const masterDb = {
  select: (cols: Record<string, unknown>) => ({
    from: () => ({ where: () => masterWorkspaces('stripeCustomerId' in cols ? 'due' : 'backfill') }),
  }),
};

vi.mock('../db', () => ({
  getTenantDbForWorkspace: (env: unknown, id: string) => tenantDbFor(env, id),
  getMasterDb: () => masterDb,
  masterSchema: {
    workspaces: { id: 'id', clerkOrgId: 'clerk_org_id', stripeCustomerId: 'stripe_customer_id', isActive: 'is_active' },
  },
}));

vi.mock('../lib/realtime-registrar', () => ({ getRealtimeRegistrar: () => ({}) }));
vi.mock('../services/domains', () => ({ pollRenewalProcess: vi.fn() }));

const dueDomains = vi.fn(async () => [
  { id: 'dom_1', fullDomain: 'acme.com', registrationStatus: 'active' },
]);
const chargeAndRenew = vi.fn(async () => ({ ok: true, invoiceId: 'in_1', renewed: true, pending: false }));
vi.mock('../services/domain-renewal-billing', () => ({
  listDomainsDueForAutoRenew: (...args: unknown[]) => dueDomains(...(args as [])),
  chargeAndRenewDomain: (...args: unknown[]) => chargeAndRenew(...(args as [])),
}));

const reindex = vi.fn(async () => true);
const listDue = vi.fn(async () => dueIds);
const computeDueAt = vi.fn(async (): Promise<Date | null> => null);
const writeIndex = vi.fn(async () => undefined);
vi.mock('@weldsuite/db/lib/domain-renewal-index', () => ({
  reindexWorkspaceDomainRenewals: (...args: unknown[]) => reindex(...(args as [])),
  listWorkspacesWithDueDomainRenewals: (...args: unknown[]) => listDue(...(args as [])),
  computeDomainRenewalDueAt: (...args: unknown[]) => computeDueAt(...(args as [])),
  writeDomainRenewalIndex: (...args: unknown[]) => writeIndex(...(args as [])),
}));

import {
  runDomainAutoRenewSweep,
  DOMAIN_RENEWAL_INDEX_BACKFILL_KEY,
  DOMAIN_AUTO_RENEW_MAX_PER_SWEEP,
} from './domain-auto-renew';

function makeEnv(backfilled: boolean) {
  const kv = new Map<string, string>(backfilled ? [[DOMAIN_RENEWAL_INDEX_BACKFILL_KEY, 'done']] : []);
  return {
    STRIPE_SECRET_KEY: 'sk_test',
    WORKSPACE_CACHE: {
      get: vi.fn(async (k: string) => kv.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => void kv.set(k, v)),
    },
    kv,
  };
}

describe('runDomainAutoRenewSweep', () => {
  beforeEach(() => {
    dueIds = ['org_2'];
    for (const fn of [tenantDbFor, dueDomains, chargeAndRenew, reindex, listDue, computeDueAt, writeIndex, masterWorkspaces]) {
      fn.mockClear();
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('opens only tenants with a renewal due in the master index, then re-indexes them', async () => {
    const env = makeEnv(true);
    const result = await runDomainAutoRenewSweep(env as never);
    expect(listDue).toHaveBeenCalledOnce();
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(tenantDbFor).toHaveBeenCalledWith(env, 'org_2');
    expect(chargeAndRenew).toHaveBeenCalledOnce();
    expect(reindex).toHaveBeenCalledWith(masterDb, { workspaceId: 'org_2' }, 'org_2');
    expect(result).toMatchObject({ workspacesScanned: 1, invoiced: 1, renewed: 1 });
  });

  it('opens no tenant at all when nothing is due', async () => {
    dueIds = [];
    await runDomainAutoRenewSweep(makeEnv(true) as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
    expect(masterWorkspaces).not.toHaveBeenCalled();
  });

  it('never opens a due workspace that is suspended or has no Stripe customer', async () => {
    dueIds = ['org_3', 'org_suspended'];
    await runDomainAutoRenewSweep(makeEnv(true) as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('stops opening tenants once the per-run cap is hit', async () => {
    dueIds = ['org_1', 'org_2'];
    dueDomains.mockResolvedValueOnce(
      Array.from({ length: DOMAIN_AUTO_RENEW_MAX_PER_SWEEP + 1 }, (_, i) => ({
        id: `dom_${i}`,
        fullDomain: `d${i}.com`,
        registrationStatus: 'active',
      })),
    );
    const result = await runDomainAutoRenewSweep(makeEnv(true) as never);
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    expect(chargeAndRenew).toHaveBeenCalledTimes(DOMAIN_AUTO_RENEW_MAX_PER_SWEEP);
    expect(result.skipped).toBe(1);
    // The capped workspace is still re-indexed; its leftover domain keeps it due.
    expect(reindex).toHaveBeenCalledOnce();
  });

  it('back-fills every tenant exactly once, then sets the flag', async () => {
    dueIds = [];
    const env = makeEnv(false);
    await runDomainAutoRenewSweep(env as never);
    expect(tenantDbFor).toHaveBeenCalledTimes(3); // ws_4 has no clerkOrgId
    expect(writeIndex).toHaveBeenCalledTimes(3);
    expect(chargeAndRenew).not.toHaveBeenCalled(); // backfill only indexes
    expect(env.kv.has(DOMAIN_RENEWAL_INDEX_BACKFILL_KEY)).toBe(true);

    tenantDbFor.mockClear();
    await runDomainAutoRenewSweep(env as never);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('marks an unreadable tenant due now during backfill so the sweep retries it', async () => {
    dueIds = [];
    tenantDbFor.mockRejectedValueOnce(new Error('neon down'));
    const before = Date.now();
    await runDomainAutoRenewSweep(makeEnv(false) as never);
    const [, workspaceId, dueAt] = writeIndex.mock.calls[0] as unknown as [unknown, string, Date];
    expect(workspaceId).toBe('org_1');
    expect(dueAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('retries the backfill next run when an index write failed', async () => {
    dueIds = [];
    writeIndex.mockRejectedValueOnce(new Error('master down'));
    const env = makeEnv(false);
    await runDomainAutoRenewSweep(env as never);
    expect(env.kv.has(DOMAIN_RENEWAL_INDEX_BACKFILL_KEY)).toBe(false);
  });

  it('never falls back to a tenant fan-out when the index read fails', async () => {
    listDue.mockRejectedValueOnce(new Error('connection refused'));
    const result = await runDomainAutoRenewSweep(makeEnv(true) as never);
    expect(result.workspacesScanned).toBe(0);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });
});
