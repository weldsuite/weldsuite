/**
 * Master-DB half of partner workspace onboarding. Partner tables are not in the
 * pglite test databases (no migration yet), so the db handle is a scripted fake
 * and the licence services are spies: these tests pin what is written and in
 * which mode, not Drizzle's SQL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';

vi.mock('./licences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./licences')>()),
  validateLicenceTerms: vi.fn(async () => undefined),
  upsertWorkspaceLicence: vi.fn(async () => ({ licence: {}, previous: null, changeId: 'wlc_1' })),
  applyLicenceCredits: vi.fn(async () => ({ granted: 500 })),
}));
vi.mock('./partners', () => ({ getPartner: vi.fn() }));

import { applyLicenceCredits, LicenceError, upsertWorkspaceLicence, validateLicenceTerms } from './licences';
import { getPartner } from './partners';
import {
  assertPartnerOnboardAllowed,
  findRecentPartnerWorkspace,
  getPartnerProvisionContext,
  initialiseLicensedCredits,
  registerPartnerWorkspace,
  type PartnerOnboardInput,
} from './provisioning';

interface Op {
  op: 'insert' | 'update';
  table: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  conflictSet?: Record<string, unknown>;
}

/** select() results are consumed in call order; insert/update record what they were given. */
function fakeDb(selects: unknown[][] = [], returnings: unknown[][] = []) {
  const ops: Op[] = [];
  const chain = (result: unknown[], op?: Op): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
          return (...args: unknown[]) => {
            if (op && prop === 'values') op.values = args[0] as Record<string, unknown>;
            if (op && prop === 'set') op.set = args[0] as Record<string, unknown>;
            if (op && prop === 'onConflictDoUpdate') op.conflictSet = (args[0] as { set: Record<string, unknown> }).set;
            return chain(result, op);
          };
        },
      },
    );
  const db = {
    select: () => chain(selects.shift() ?? []),
    insert: (table: unknown) => {
      const op: Op = { op: 'insert', table };
      ops.push(op);
      return chain(returnings.shift() ?? [], op);
    },
    update: (table: unknown) => {
      const op: Op = { op: 'update', table };
      ops.push(op);
      return chain([], op);
    },
  };
  return { db, ops };
}

const licence: PartnerOnboardInput['licence'] = {
  allowedApps: ['weldcrm', 'welddesk'],
  monthlyCredits: 3000,
  creditRolloverCap: 0,
  maxSeats: 10,
  featurePlanId: 'plan_business',
  storageGb: null,
  resalePricing: { model: 'flat', amount: '199.00' },
  packageId: 'plp_1',
};

const input: PartnerOnboardInput = {
  partnerId: 'ptr_1',
  actorUserId: 'user_partner',
  name: 'Acme BV',
  country: 'BR',
  ownerEmail: 'owner@acme.example',
  licence,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertPartnerOnboardAllowed', () => {
  it('refuses an unknown partner', async () => {
    vi.mocked(getPartner).mockResolvedValue(null);
    await expect(assertPartnerOnboardAllowed(fakeDb().db, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(validateLicenceTerms).not.toHaveBeenCalled();
  });

  it('refuses a package that belongs to another partner, or does not exist', async () => {
    vi.mocked(getPartner).mockResolvedValue({ id: 'ptr_1' } as never);
    await expect(
      assertPartnerOnboardAllowed(fakeDb([[{ partnerId: 'ptr_other' }]]).db, input),
    ).rejects.toMatchObject({ code: 'WRONG_PARTNER' });
    await expect(assertPartnerOnboardAllowed(fakeDb([[]]).db, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('validates the licence terms against the contract', async () => {
    vi.mocked(getPartner).mockResolvedValue({ id: 'ptr_1' } as never);
    const { db } = fakeDb([[{ partnerId: 'ptr_1' }]]);
    await assertPartnerOnboardAllowed(db, input);
    expect(validateLicenceTerms).toHaveBeenCalledWith(db, 'ptr_1', licence);
  });

  it('lets the contract errors through unchanged', async () => {
    vi.mocked(getPartner).mockResolvedValue({ id: 'ptr_1' } as never);
    vi.mocked(validateLicenceTerms).mockRejectedValueOnce(new LicenceError('INVALID_APPS', 'Unknown apps: x'));
    await expect(
      assertPartnerOnboardAllowed(fakeDb([[{ partnerId: 'ptr_1' }]]).db, input),
    ).rejects.toMatchObject({ code: 'INVALID_APPS' });
  });

  it('skips the package lookup when the licence has no package', async () => {
    vi.mocked(getPartner).mockResolvedValue({ id: 'ptr_1' } as never);
    await assertPartnerOnboardAllowed(fakeDb().db, { ...input, licence: { ...licence, packageId: null } });
    expect(validateLicenceTerms).toHaveBeenCalled();
  });
});

describe('findRecentPartnerWorkspace', () => {
  it('returns the workspace this partner just created', async () => {
    const { db } = fakeDb([[{ id: 'ws_1', clerkOrgId: 'org_1', slug: 'acme' }]]);
    expect(await findRecentPartnerWorkspace(db, { partnerId: 'ptr_1', name: 'Acme BV' })).toEqual({
      id: 'ws_1',
      clerkOrgId: 'org_1',
      slug: 'acme',
    });
  });

  it('returns null when there is none, or it has no Clerk org', async () => {
    expect(await findRecentPartnerWorkspace(fakeDb([[]]).db, { partnerId: 'ptr_1', name: 'x' })).toBeNull();
    expect(
      await findRecentPartnerWorkspace(fakeDb([[{ id: 'ws_1', clerkOrgId: null, slug: null }]]).db, {
        partnerId: 'ptr_1',
        name: 'x',
      }),
    ).toBeNull();
  });
});

describe('registerPartnerWorkspace', () => {
  const args = {
    clerkOrgId: 'org_1',
    name: 'Acme BV',
    slug: 'acme-bv',
    partnerId: 'ptr_1',
    actorUserId: 'user_partner',
    licence,
    defaultPlanId: 'plan_free',
  };

  it('inserts a partner-billed workspace on the licence\'s feature plan, then the licence', async () => {
    const { db, ops } = fakeDb([[]], [[{ id: 'ws_1' }]]);
    const out = await registerPartnerWorkspace(db, args);

    expect(out).toEqual({ workspaceId: 'ws_1', created: true });
    const insert = ops.find((o) => o.op === 'insert' && o.table === masterSchema.workspaces)!;
    expect(insert.values).toMatchObject({
      clerkOrgId: 'org_1',
      name: 'Acme BV',
      slug: 'acme-bv',
      planId: 'plan_business',
      isActive: true,
      partnerId: 'ptr_1',
      billingMode: 'partner',
      paidPlanRequired: false,
    });
    expect(upsertWorkspaceLicence).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        workspaceId: 'ws_1',
        partnerId: 'ptr_1',
        terms: licence,
        packageId: 'plp_1',
        actor: { id: 'user_partner', type: 'partner' },
      }),
    );
  });

  it('falls back to the default plan when the licence names none', async () => {
    const { db, ops } = fakeDb([[]], [[{ id: 'ws_1' }]]);
    await registerPartnerWorkspace(db, { ...args, licence: { ...licence, featurePlanId: null } });
    const insert = ops.find((o) => o.table === masterSchema.workspaces)!;
    expect(insert.values).toMatchObject({ planId: 'plan_free' });
    // ...and never overwrites an existing plan on conflict.
    expect(insert.conflictSet).not.toHaveProperty('planId');
  });

  it('takes the row over when the Clerk webhook inserted it first (conflict on the org id)', async () => {
    const { db, ops } = fakeDb([[]], [[{ id: 'ws_webhook' }]]);
    const out = await registerPartnerWorkspace(db, args);
    expect(out.workspaceId).toBe('ws_webhook');
    const insert = ops.find((o) => o.table === masterSchema.workspaces)!;
    expect(insert.conflictSet).toMatchObject({
      partnerId: 'ptr_1',
      billingMode: 'partner',
      paidPlanRequired: false,
      planId: 'plan_business',
    });
    expect(upsertWorkspaceLicence).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_webhook' }));
  });

  it('does not write a second licence change when re-run', async () => {
    const { db } = fakeDb([[{ id: 'wsl_1' }]], [[{ id: 'ws_1' }]]);
    const out = await registerPartnerWorkspace(db, args);
    expect(out).toEqual({ workspaceId: 'ws_1', created: false });
    expect(upsertWorkspaceLicence).not.toHaveBeenCalled();
  });
});

describe('getPartnerProvisionContext', () => {
  it('is null for a direct workspace', async () => {
    expect(await getPartnerProvisionContext(fakeDb([[{ billingMode: 'direct' }]]).db, 'ws_1')).toBeNull();
    expect(await getPartnerProvisionContext(fakeDb([[]]).db, 'ws_missing')).toBeNull();
  });

  it('is the licence of a partner workspace', async () => {
    const { db } = fakeDb([
      [{ billingMode: 'partner' }],
      [{ allowedApps: ['weldcrm'], monthlyCredits: 3000, creditRolloverCap: 100 }],
    ]);
    expect(await getPartnerProvisionContext(db, 'ws_1')).toEqual({
      allowedApps: ['weldcrm'],
      monthlyCredits: 3000,
      creditRolloverCap: 100,
    });
  });

  it('is core-only with no credits when a partner workspace has no licence row', async () => {
    expect(await getPartnerProvisionContext(fakeDb([[{ billingMode: 'partner' }], []]).db, 'ws_1')).toEqual({
      allowedApps: [],
      monthlyCredits: 0,
      creditRolloverCap: 0,
    });
  });
});

describe('initialiseLicensedCredits', () => {
  it('grants the licence allowance under a fixed key and marks the wallet as reset', async () => {
    const { db, ops } = fakeDb();
    const out = await initialiseLicensedCredits(db, 'ws_1', {
      allowedApps: ['weldcrm'],
      monthlyCredits: 3000,
      creditRolloverCap: 100,
    });
    expect(out).toEqual({ granted: 500 });
    expect(applyLicenceCredits).toHaveBeenCalledWith({
      db,
      workspaceId: 'ws_1',
      previousMonthlyCredits: null,
      monthlyCredits: 3000,
      creditRolloverCap: 100,
      changeId: 'init:ws_1',
    });
    const update = ops.find((o) => o.op === 'update' && o.table === masterSchema.workspaceCredits)!;
    expect(update.set).toHaveProperty('lastResetAt');
  });
});
