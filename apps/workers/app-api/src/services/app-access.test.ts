/**
 * App access (apps that are on request only) against a real pglite master DB:
 * the request / re-request rules, the install check, the status listing the
 * catalog uses, and the view that must never carry staff-only columns.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { MasterDatabase } from '@weldsuite/worker-kit/db';
import {
  WELDREACH_APP_CODE,
  WELDREACH_DEFAULT_LIMITS,
  WELDREACH_TERMS,
  WELDREACH_TERMS_VERSION,
  type AppAccessRequestInput,
  type AppAccessStatus,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  checkInstallAccess,
  getAppAccessView,
  getWorkspaceAccess,
  listAccessStatuses,
  listRequiresApprovalCodes,
  requestAppAccess,
  toAppAccessView,
  validateTerms,
} from './app-access';
import { listCatalogApps } from './app-catalog';

const { workspaces, workspaceAppAccess, appCatalog } = masterSchema;

let db: MasterDatabase;
let seq = 0;

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db as MasterDatabase;
  await db.insert(appCatalog).values([
    {
      id: 'app_t_reach',
      code: WELDREACH_APP_CODE,
      name: 'WeldReach',
      description: 'Cold email',
      icon: 'Mail',
      category: 'Marketing',
      path: '/weldreach',
      isPublished: true,
      requiresApproval: true,
    },
    {
      id: 'app_t_crm',
      code: 'weldcrm',
      name: 'WeldCRM',
      description: 'CRM',
      icon: 'Users',
      category: 'Sales',
      path: '/crm',
      isPublished: true,
    },
  ]);
}, 60_000);

async function seedWorkspace(): Promise<{ id: string; orgId: string }> {
  seq += 1;
  const id = `ws_acc_${seq}`;
  const orgId = `org_acc_${seq}`;
  await db.insert(workspaces).values({ id, clerkOrgId: orgId, name: `Workspace ${seq}`, slug: `ws-acc-${seq}` });
  return { id, orgId };
}

async function seedAccess(
  workspaceId: string,
  status: AppAccessStatus,
  extra: Partial<typeof workspaceAppAccess.$inferInsert> = {},
): Promise<void> {
  await db.insert(workspaceAppAccess).values({
    id: `waa_t_${workspaceId}`,
    workspaceId,
    appCode: WELDREACH_APP_CODE,
    status,
    ...extra,
  });
}

function input(overrides: Partial<AppAccessRequestInput> = {}): AppAccessRequestInput {
  return {
    companyName: 'Acme B.V.',
    website: 'https://acme.example',
    contactName: 'Lisa de Vries',
    contactEmail: 'lisa@acme.example',
    useCase: 'We email past customers about a new service tier.',
    expectedDailySends: 200,
    targetCountries: ['BE', 'FR'],
    listSource: 'own_customers',
    termsVersion: WELDREACH_TERMS_VERSION,
    termsAccepted: [...WELDREACH_TERMS],
    ...overrides,
  };
}

async function rowOf(workspaceId: string) {
  const [row] = await db.select().from(workspaceAppAccess).where(eq(workspaceAppAccess.workspaceId, workspaceId));
  return row;
}

describe('validateTerms', () => {
  it('accepts the current version with every term ticked', () => {
    expect(validateTerms(WELDREACH_APP_CODE, input())).toBeNull();
  });

  it('refuses an old terms version', () => {
    expect(validateTerms(WELDREACH_APP_CODE, input({ termsVersion: 'weldreach-2025-01' }))).toMatch(/terms have changed/);
  });

  it('names the term that was not ticked', () => {
    const accepted = WELDREACH_TERMS.filter((t) => t !== 'lawful_lists');
    expect(validateTerms(WELDREACH_APP_CODE, input({ termsAccepted: accepted }))).toMatch(/lawful_lists/);
  });

  it('has no terms of its own for other apps', () => {
    expect(validateTerms('someotherapp', input({ termsVersion: 'x', termsAccepted: ['x'] }))).toBeNull();
  });
});

describe('requestAppAccess', () => {
  it('files a first request with the default limits and the terms receipt', async () => {
    const ws = await seedWorkspace();
    const now = new Date('2026-10-12T10:00:00.000Z');

    const result = await requestAppAccess({
      masterDb: db,
      clerkOrgId: ws.orgId,
      appCode: WELDREACH_APP_CODE,
      userId: 'user_owner',
      input: input({ listSourceDetails: 'CRM export' }),
      now,
    });

    expect(result.ok).toBe(true);
    const row = await rowOf(ws.id);
    expect(row?.status).toBe('requested');
    expect(row?.limits).toEqual(WELDREACH_DEFAULT_LIMITS);
    expect(row?.requestedBy).toBe('user_owner');
    expect(row?.requestedAt?.toISOString()).toBe(now.toISOString());
    expect(row?.request).toMatchObject({
      companyName: 'Acme B.V.',
      listSource: 'own_customers',
      listSourceDetails: 'CRM export',
      termsVersion: WELDREACH_TERMS_VERSION,
      termsAcceptedAt: now.toISOString(),
      termsAcceptedBy: 'user_owner',
    });
    expect(row?.request?.termsAccepted).toEqual([...WELDREACH_TERMS]);
  });

  it('does not store empty list details', async () => {
    const ws = await seedWorkspace();
    await requestAppAccess({
      masterDb: db,
      clerkOrgId: ws.orgId,
      appCode: WELDREACH_APP_CODE,
      userId: 'u',
      input: input(),
    });
    expect(Object.keys((await rowOf(ws.id))?.request ?? {})).not.toContain('listSourceDetails');
  });

  it.each(['requested', 'approved', 'suspended'] as const)('refuses a new request while %s', async (status) => {
    const ws = await seedWorkspace();
    await seedAccess(ws.id, status);

    const result = await requestAppAccess({
      masterDb: db,
      clerkOrgId: ws.orgId,
      appCode: WELDREACH_APP_CODE,
      userId: 'u',
      input: input(),
    });

    expect(result).toEqual({ ok: false, reason: 'exists', status });
    expect((await rowOf(ws.id))?.status).toBe(status);
  });

  it.each(['rejected', 'revoked'] as const)(
    'files again after %s: back to requested, reason cleared, limits and history kept',
    async (status) => {
      const ws = await seedWorkspace();
      const limits = { ...WELDREACH_DEFAULT_LIMITS, maxMailboxes: 25 };
      await seedAccess(ws.id, status, {
        limits,
        rejectionReason: 'Lists unclear',
        suspendedReason: 'Complaints',
        reviewedBy: 'staff@weldsuite.org',
        reviewedAt: new Date('2026-10-01T00:00:00Z'),
        reviewNotes: 'internal',
        stripeSubscriptionId: 'sub_123',
        billingStatus: 'active',
      });

      const result = await requestAppAccess({
        masterDb: db,
        clerkOrgId: ws.orgId,
        appCode: WELDREACH_APP_CODE,
        userId: 'user_again',
        input: input({ companyName: 'Acme Holding' }),
      });

      expect(result.ok).toBe(true);
      const row = await rowOf(ws.id);
      expect(row?.status).toBe('requested');
      expect(row?.rejectionReason).toBeNull();
      expect(row?.suspendedReason).toBeNull();
      expect(row?.reviewedBy).toBeNull();
      expect(row?.reviewedAt).toBeNull();
      expect(row?.requestedBy).toBe('user_again');
      expect(row?.request?.companyName).toBe('Acme Holding');
      // Kept: what staff set before, their notes and the billing link.
      expect(row?.limits).toEqual(limits);
      expect(row?.reviewNotes).toBe('internal');
      expect(row?.stripeSubscriptionId).toBe('sub_123');
      expect(row?.billingStatus).toBe('active');
    },
  );

  it('lets exactly one of two simultaneous first requests through', async () => {
    const ws = await seedWorkspace();
    const file = () =>
      requestAppAccess({ masterDb: db, clerkOrgId: ws.orgId, appCode: WELDREACH_APP_CODE, userId: 'u', input: input() });

    const results = await Promise.all([file(), file()]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'exists', status: 'requested' });
  });

  it('reports an org without a workspace row', async () => {
    const result = await requestAppAccess({
      masterDb: db,
      clerkOrgId: 'org_unknown',
      appCode: WELDREACH_APP_CODE,
      userId: 'u',
      input: input(),
    });
    expect(result).toEqual({ ok: false, reason: 'workspace_not_found' });
  });

  it('keeps one workspace out of another one', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    await seedAccess(a.id, 'approved');

    const result = await requestAppAccess({
      masterDb: db,
      clerkOrgId: b.orgId,
      appCode: WELDREACH_APP_CODE,
      userId: 'u',
      input: input(),
    });

    expect(result.ok).toBe(true);
    expect((await rowOf(a.id))?.status).toBe('approved');
  });
});

describe('toAppAccessView / getAppAccessView', () => {
  it('is null when the workspace never asked', async () => {
    const ws = await seedWorkspace();
    expect(await getAppAccessView(db, ws.orgId, WELDREACH_APP_CODE)).toBeNull();
  });

  it('is null for an org without a workspace row', async () => {
    expect(await getAppAccessView(db, 'org_nobody', WELDREACH_APP_CODE)).toBeNull();
  });

  it('never carries staff notes, reviewer, ids or billing columns', async () => {
    const ws = await seedWorkspace();
    await requestAppAccess({ masterDb: db, clerkOrgId: ws.orgId, appCode: WELDREACH_APP_CODE, userId: 'u', input: input() });
    await db
      .update(workspaceAppAccess)
      .set({
        status: 'rejected',
        rejectionReason: 'Please explain your lists',
        reviewNotes: 'looks like a spammer',
        reviewedBy: 'staff@weldsuite.org',
        reviewedAt: new Date('2026-10-02T00:00:00Z'),
        stripeSubscriptionId: 'sub_secret',
      })
      .where(eq(workspaceAppAccess.workspaceId, ws.id));

    const view = await getAppAccessView(db, ws.orgId, WELDREACH_APP_CODE);

    expect(view).toMatchObject({
      appCode: WELDREACH_APP_CODE,
      status: 'rejected',
      rejectionReason: 'Please explain your lists',
      suspendedReason: null,
      reviewedAt: '2026-10-02T00:00:00.000Z',
    });
    const json = JSON.stringify(view);
    for (const secret of ['looks like a spammer', 'staff@weldsuite.org', 'sub_secret', 'reviewNotes', 'reviewedBy', 'stripe']) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(view ?? {}).sort()).toEqual(
      ['appCode', 'limits', 'rejectionReason', 'request', 'requestedAt', 'reviewedAt', 'status', 'suspendedReason'].sort(),
    );
  });

  it('has a null request when staff created the row themselves', () => {
    const view = toAppAccessView({
      id: 'waa_x',
      workspaceId: 'ws_x',
      appCode: WELDREACH_APP_CODE,
      status: 'approved',
      request: null,
      limits: {},
      requestedBy: null,
      requestedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
      rejectionReason: null,
      suspendedReason: null,
      stripeSubscriptionId: null,
      billingStatus: 'none',
      billingStatusAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(view.request).toBeNull();
    expect(view.requestedAt).toBeNull();
  });
});

describe('checkInstallAccess', () => {
  it('lets an app that is not on request through, whatever the workspace', async () => {
    expect(await checkInstallAccess(db, null, 'weldcrm')).toEqual({ ok: true });
    expect(await checkInstallAccess(db, 'org_nobody', 'weldcrm')).toEqual({ ok: true });
  });

  it('leaves an unknown app to the install itself (404)', async () => {
    expect(await checkInstallAccess(db, 'org_nobody', 'doesnotexist')).toEqual({ ok: true });
  });

  it('refuses a workspace that never asked, with status none', async () => {
    const ws = await seedWorkspace();
    expect(await checkInstallAccess(db, ws.orgId, WELDREACH_APP_CODE)).toEqual({ ok: false, status: 'none' });
  });

  it('fails closed without an org or a workspace row', async () => {
    expect(await checkInstallAccess(db, null, WELDREACH_APP_CODE)).toEqual({ ok: false, status: 'none' });
    expect(await checkInstallAccess(db, 'org_nobody', WELDREACH_APP_CODE)).toEqual({ ok: false, status: 'none' });
  });

  it.each(['requested', 'rejected', 'suspended', 'revoked'] as const)('refuses while %s', async (status) => {
    const ws = await seedWorkspace();
    await seedAccess(ws.id, status);
    expect(await checkInstallAccess(db, ws.orgId, WELDREACH_APP_CODE)).toEqual({ ok: false, status });
  });

  it('allows an approved workspace', async () => {
    const ws = await seedWorkspace();
    await seedAccess(ws.id, 'approved');
    expect(await checkInstallAccess(db, ws.orgId, WELDREACH_APP_CODE)).toEqual({ ok: true });
  });

  it('does not let another workspace\'s approval through', async () => {
    const approved = await seedWorkspace();
    const other = await seedWorkspace();
    await seedAccess(approved.id, 'approved');
    expect(await checkInstallAccess(db, other.orgId, WELDREACH_APP_CODE)).toEqual({ ok: false, status: 'none' });
  });
});

describe('getWorkspaceAccess / listAccessStatuses / listRequiresApprovalCodes', () => {
  it('resolves the workspace by Clerk org and returns its name', async () => {
    const ws = await seedWorkspace();
    const found = await getWorkspaceAccess(db, ws.orgId, WELDREACH_APP_CODE);
    expect(found).toMatchObject({ workspaceId: ws.id, access: null });
    expect(found?.workspaceName).toMatch(/^Workspace \d+$/);
  });

  it('lists the statuses of the caller\'s workspace only', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    await seedAccess(mine.id, 'suspended');
    await seedAccess(theirs.id, 'approved');

    const statuses = await listAccessStatuses(db, mine.orgId);

    expect([...statuses.entries()]).toEqual([[WELDREACH_APP_CODE, 'suspended']]);
  });

  it('lists the apps that are on request only', async () => {
    expect([...(await listRequiresApprovalCodes(db))]).toEqual([WELDREACH_APP_CODE]);
  });
});

describe('catalog items for on-request apps', () => {
  // listCatalogApps reads the installed codes from the tenant DB; none here.
  const tenantDb = { select: () => ({ from: () => ({ where: async () => [] }) }) } as never;

  it('flags the app and reports none before the workspace asked', async () => {
    const apps = await listCatalogApps(db, tenantDb, new Map());
    const reach = apps.find((a) => a.code === WELDREACH_APP_CODE);
    expect(reach).toMatchObject({ requiresApproval: true, accessStatus: 'none' });
  });

  it('reports the workspace\'s status', async () => {
    const apps = await listCatalogApps(db, tenantDb, new Map([[WELDREACH_APP_CODE, 'requested']]));
    expect(apps.find((a) => a.code === WELDREACH_APP_CODE)).toMatchObject({ accessStatus: 'requested' });
  });

  it('leaves accessStatus off apps that are not on request', async () => {
    const apps = await listCatalogApps(db, tenantDb, new Map([['weldcrm', 'approved']]));
    const crm = apps.find((a) => a.code === 'weldcrm');
    expect(crm).toMatchObject({ requiresApproval: false });
    expect(crm).not.toHaveProperty('accessStatus');
  });
});
