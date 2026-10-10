import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';
import type { AdminContext } from './admin-billing';

const mocks = vi.hoisted(() => ({
  getPartner: vi.fn(),
  validateLicenceTerms: vi.fn(),
  upsertWorkspaceLicence: vi.fn(),
  setLicenceStatus: vi.fn(),
  syncInstalledAppsToLicence: vi.fn(),
  applyLicenceCredits: vi.fn(),
  setPartnerStatus: vi.fn(),
  recomputePartnerStatus: vi.fn(),
  findTerritoryConflicts: vi.fn(),
  setTerritories: vi.fn(),
  inviteMember: vi.fn(),
  partnerWorkspaceOrgIds: vi.fn(),
  getTenantDbForWorkspace: vi.fn(),
  trySyncClerkSeatLimit: vi.fn(),
  createStripeCustomer: vi.fn(),
  updateStripeCustomer: vi.fn(),
  retrieveSubscriptionForAdmin: vi.fn(),
  setCancelAtPeriodEnd: vi.fn(),
  cancelSubscriptionNow: vi.fn(),
  applySubscriptionEnded: vi.fn(),
  sendPartnerInvitationEmail: vi.fn(),
}));

vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  getPartner: mocks.getPartner,
  validateLicenceTerms: mocks.validateLicenceTerms,
  upsertWorkspaceLicence: mocks.upsertWorkspaceLicence,
  setLicenceStatus: mocks.setLicenceStatus,
  syncInstalledAppsToLicence: mocks.syncInstalledAppsToLicence,
  applyLicenceCredits: mocks.applyLicenceCredits,
  setPartnerStatus: mocks.setPartnerStatus,
  recomputePartnerStatus: mocks.recomputePartnerStatus,
  findTerritoryConflicts: mocks.findTerritoryConflicts,
  setTerritories: mocks.setTerritories,
  inviteMember: mocks.inviteMember,
  partnerWorkspaceOrgIds: mocks.partnerWorkspaceOrgIds,
}));
vi.mock('../lib/tenant-db', () => ({ getTenantDbForWorkspace: mocks.getTenantDbForWorkspace }));
vi.mock('../lib/clerk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/clerk')>()),
  trySyncClerkSeatLimit: mocks.trySyncClerkSeatLimit,
}));
vi.mock('../lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe')>()),
  createStripeCustomer: mocks.createStripeCustomer,
  updateStripeCustomer: mocks.updateStripeCustomer,
}));
vi.mock('../lib/stripe-admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe-admin')>()),
  retrieveSubscriptionForAdmin: mocks.retrieveSubscriptionForAdmin,
  setCancelAtPeriodEnd: mocks.setCancelAtPeriodEnd,
  cancelSubscriptionNow: mocks.cancelSubscriptionNow,
}));
vi.mock('./subscription-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./subscription-policy')>()),
  applySubscriptionEnded: mocks.applySubscriptionEnded,
}));
vi.mock('./partner-mail', () => ({
  sendPartnerInvitationEmail: mocks.sendPartnerInvitationEmail,
  sendPartnerDunningEmail: vi.fn(),
  partnerPortalUrl: () => 'https://app.weldsuite.org/partner',
}));

const admin = await import('./partner-admin');
const { LicenceError, TerritoryConflictError } = await import('@weldsuite/core-domain/partners');

const kvDelete = vi.fn(async () => undefined);
const env = { STRIPE_SECRET_KEY: 'sk_test', WORKSPACE_CACHE: { delete: kvDelete } } as unknown as Env;

function ctx(db: unknown): AdminContext {
  return {
    env,
    masterDb: db as AdminContext['masterDb'],
    actor: { email: 'ops@weldsuite.org', userId: 'user_admin' },
    requestId: 'req_12345678',
    reason: '',
  };
}

const partner = { id: 'ptr_a', name: 'Andes', country: 'BR', billingEmail: 'bill@andes.test', stripeCustomerId: 'cus_p', legalName: null };
const directWorkspace = {
  id: 'ws_1',
  clerkOrgId: 'org_1',
  name: 'Acme',
  planId: 'plan_business',
  billingMode: 'direct',
  partnerId: null,
  deletedAt: null,
  stripeSubscriptionId: 'sub_1',
  stripePhoneSubscriptionId: null,
  stripeAgentsSubscriptionId: null,
  deletionRequestedBy: null,
};
const terms = {
  allowedApps: ['welddesk'],
  monthlyCredits: 3000,
  creditRolloverCap: 0,
  maxSeats: 10,
  featurePlanId: 'plan_business',
  storageGb: null,
  resalePricing: { model: 'flat' as const, amount: '199.00' },
};
const licenceRow = {
  ...terms,
  id: 'wsl_1',
  status: 'active',
  packageId: null,
  startsAt: new Date('2026-10-10T00:00:00Z'),
  endsAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getPartner.mockResolvedValue(partner);
  mocks.validateLicenceTerms.mockResolvedValue(undefined);
  mocks.upsertWorkspaceLicence.mockResolvedValue({ licence: licenceRow, previous: null, changeId: 'wlc_1' });
  mocks.setLicenceStatus.mockResolvedValue({ licence: { ...licenceRow, status: 'ended' }, previous: licenceRow, changeId: 'wlc_2' });
  mocks.getTenantDbForWorkspace.mockResolvedValue({ tenant: true });
  mocks.syncInstalledAppsToLicence.mockResolvedValue({ installed: ['welddesk'], deactivated: [] });
  mocks.applyLicenceCredits.mockResolvedValue({ granted: 3000 });
  mocks.retrieveSubscriptionForAdmin.mockResolvedValue({ id: 'sub_1', status: 'active' });
  mocks.setCancelAtPeriodEnd.mockResolvedValue({});
  mocks.cancelSubscriptionNow.mockResolvedValue({});
  mocks.applySubscriptionEnded.mockResolvedValue('grace_period');
  mocks.createStripeCustomer.mockResolvedValue({ id: 'cus_new' });
  mocks.findTerritoryConflicts.mockResolvedValue([]);
  mocks.inviteMember.mockResolvedValue({ id: 'ptm_1', email: 'owner@andes.test', role: 'owner', userId: null, acceptedAt: null, createdAt: new Date() });
  mocks.recomputePartnerStatus.mockResolvedValue({ changed: false });
  mocks.partnerWorkspaceOrgIds.mockResolvedValue(['org_1', 'org_2']);
});

const attachInput = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws_1',
  licence: { ...terms, packageId: null },
  cancelDirectSubscription: 'period_end' as const,
  reason: 'Customer moves to the reseller',
  ...overrides,
});

describe('attachWorkspace', () => {
  it('cancels the direct subscription at period end, writes the licence as admin and syncs apps, credits and seat cap', async () => {
    const { db, written } = createFakeDb({ selects: [[directWorkspace]] });

    const result = await admin.attachWorkspace(ctx(db), 'ptr_a', attachInput());

    expect(result).toEqual({ workspaceId: 'ws_1', subscriptionCanceled: true });
    expect(mocks.setCancelAtPeriodEnd).toHaveBeenCalledWith('sk_test', 'sub_1', true);
    expect(mocks.cancelSubscriptionNow).not.toHaveBeenCalled();
    expect(mocks.upsertWorkspaceLicence).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_1',
        partnerId: 'ptr_a',
        actor: { id: 'user_admin', type: 'admin' },
        reason: 'Customer moves to the reseller',
        packageId: null,
      }),
    );
    expect(mocks.syncInstalledAppsToLicence).toHaveBeenCalledWith({
      tenantDb: { tenant: true },
      allowedApps: ['welddesk'],
      actorUserId: 'user_admin',
    });
    expect(mocks.applyLicenceCredits).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_1', previousMonthlyCredits: null, monthlyCredits: 3000, changeId: 'wlc_1' }),
    );
    expect(mocks.trySyncClerkSeatLimit).toHaveBeenCalledWith(env, db, 'org_1', 'ws_1', null, 0, expect.any(String));
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
    // Comp and the pay-or-delete schedule of the direct plan end here.
    expect(written('update').at(-1)).toMatchObject({
      compGrantedAt: null,
      compEndsAt: null,
      trialExpiredAt: null,
      scheduledDeletionAt: null,
    });
  });

  it('cancels immediately (prorated) by unlinking first, so the deleted-subscription webhook is a no-op', async () => {
    const { db, written } = createFakeDb({ selects: [[directWorkspace]] });
    await admin.attachWorkspace(ctx(db), 'ptr_a', attachInput({ cancelDirectSubscription: 'now' }));
    expect(mocks.cancelSubscriptionNow).toHaveBeenCalledWith('sk_test', 'sub_1');
    expect(written('update')[0]).toMatchObject({ stripeSubscriptionId: null });
    expect(written('update').at(-1)).toMatchObject({ subscriptionStatus: null, subscriptionCancelAtPeriodEnd: false });
  });

  it('re-links the subscription and stops when the immediate cancel fails', async () => {
    mocks.cancelSubscriptionNow.mockRejectedValue(new Error('Stripe API DELETE /v1/subscriptions/sub_1 failed (500): oops'));
    const { db, written } = createFakeDb({ selects: [[directWorkspace]] });
    await expect(admin.attachWorkspace(ctx(db), 'ptr_a', attachInput({ cancelDirectSubscription: 'now' }))).rejects.toThrow('failed (500)');
    expect(written('update').at(-1)).toMatchObject({ stripeSubscriptionId: 'sub_1' });
    expect(mocks.upsertWorkspaceLicence).not.toHaveBeenCalled();
  });

  it('validates the licence before touching Stripe: a bad licence cancels nothing', async () => {
    mocks.validateLicenceTerms.mockRejectedValue(new LicenceError('INVALID_APPS', 'Unknown or unpublished apps: nope'));
    const { db } = createFakeDb({ selects: [[directWorkspace]] });
    await expect(admin.attachWorkspace(ctx(db), 'ptr_a', attachInput())).rejects.toBeInstanceOf(LicenceError);
    expect(mocks.setCancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(mocks.cancelSubscriptionNow).not.toHaveBeenCalled();
    expect(mocks.upsertWorkspaceLicence).not.toHaveBeenCalled();
  });

  it('skips Stripe for a workspace without a live subscription', async () => {
    mocks.retrieveSubscriptionForAdmin.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    const { db } = createFakeDb({ selects: [[directWorkspace]] });
    const result = await admin.attachWorkspace(ctx(db), 'ptr_a', attachInput());
    expect(result.subscriptionCanceled).toBe(false);
    expect(mocks.setCancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it('refuses a workspace that a partner already manages', async () => {
    const managed = { ...directWorkspace, billingMode: 'partner', partnerId: 'ptr_other' };
    await expect(admin.attachWorkspace(ctx(createFakeDb({ selects: [[managed]] }).db), 'ptr_a', attachInput())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      admin.attachWorkspace(ctx(createFakeDb({ selects: [[{ ...managed, partnerId: 'ptr_a' }]] }).db), 'ptr_a', attachInput()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.setCancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it('refuses unknown or deleted workspaces', async () => {
    await expect(admin.attachWorkspace(ctx(createFakeDb({ selects: [[]] }).db), 'ptr_a', attachInput())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const deleted = { ...directWorkspace, deletedAt: new Date() };
    await expect(admin.attachWorkspace(ctx(createFakeDb({ selects: [[deleted]] }).db), 'ptr_a', attachInput())).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('warns about phone and agents subscriptions that stay billed to the workspace', async () => {
    const ws = { ...directWorkspace, stripePhoneSubscriptionId: 'sub_phone' };
    const result = await admin.attachWorkspace(ctx(createFakeDb({ selects: [[ws]] }).db), 'ptr_a', attachInput());
    expect(result.warnings?.[0]).toContain('phone-number subscription');
  });

  it('keeps the licence and reports a warning when the tenant app sync fails', async () => {
    mocks.getTenantDbForWorkspace.mockRejectedValue(new Error('no tenant db'));
    const result = await admin.attachWorkspace(ctx(createFakeDb({ selects: [[directWorkspace]] }).db), 'ptr_a', attachInput());
    expect(result.warnings?.some((w) => w.includes('installed apps'))).toBe(true);
    expect(mocks.applyLicenceCredits).toHaveBeenCalled();
  });
});

describe('detachWorkspace', () => {
  const managed = { ...directWorkspace, billingMode: 'partner', partnerId: 'ptr_a', stripeSubscriptionId: null };

  it('ends the licence, clears the allowance, returns the workspace to direct billing with the paywall and grace window', async () => {
    const { db, written } = createFakeDb({ selects: [[managed], [{ id: 'plan_business', maxUsers: 25 }]] });

    const result = await admin.detachWorkspace(ctx(db), 'ptr_a', 'ws_1', 'Contract ended');

    expect(result).toEqual({ workspaceId: 'ws_1', outcome: 'grace_period' });
    expect(mocks.setLicenceStatus).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_1', partnerId: 'ptr_a', status: 'ended', reason: 'Contract ended', actor: { id: 'user_admin', type: 'admin' } }),
    );
    expect(mocks.applyLicenceCredits).toHaveBeenCalledWith(
      expect.objectContaining({ monthlyCredits: 0, previousMonthlyCredits: 3000 }),
    );
    expect(written('update')[0]).toMatchObject({ billingMode: 'direct', partnerId: null, paidPlanRequired: true });
    // The ended-subscription policy runs on the workspace as it is now: direct, paywalled.
    expect(mocks.applySubscriptionEnded).toHaveBeenCalledWith(
      env,
      db,
      expect.objectContaining({ id: 'ws_1', billingMode: 'direct', partnerId: null, paidPlanRequired: true }),
    );
    expect(mocks.trySyncClerkSeatLimit).toHaveBeenCalledWith(env, db, 'org_1', 'ws_1', { id: 'plan_business', maxUsers: 25 }, 0, expect.any(String));
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
    // The licence is ended before the workspace is switched to direct, never the other way round.
    expect(mocks.setLicenceStatus.mock.invocationCallOrder[0]!).toBeLessThan(mocks.applySubscriptionEnded.mock.invocationCallOrder[0]!);
  });

  it("will not detach another partner's workspace", async () => {
    await expect(admin.detachWorkspace(ctx(createFakeDb({ selects: [[]] }).db), 'ptr_a', 'ws_x', 'r')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.setLicenceStatus).not.toHaveBeenCalled();
  });
});

describe('setWorkspaceLicence', () => {
  it('is the admin override: same write path, actor admin, reason kept', async () => {
    const managed = { ...directWorkspace, billingMode: 'partner', partnerId: 'ptr_a' };
    mocks.upsertWorkspaceLicence.mockResolvedValue({
      licence: licenceRow,
      previous: { ...terms, monthlyCredits: 1000, status: 'active', packageId: null },
      changeId: 'wlc_3',
    });
    const { db } = createFakeDb({ selects: [[managed]] });

    const out = await admin.setWorkspaceLicence(ctx(db), 'ptr_a', 'ws_1', { ...terms, packageId: 'plp_1', reason: 'Price fix' });

    expect(mocks.validateLicenceTerms).toHaveBeenCalledWith(db, 'ptr_a', terms);
    expect(mocks.upsertWorkspaceLicence).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: 'plp_1', reason: 'Price fix', actor: { id: 'user_admin', type: 'admin' } }),
    );
    expect(mocks.applyLicenceCredits).toHaveBeenCalledWith(expect.objectContaining({ previousMonthlyCredits: 1000, monthlyCredits: 3000 }));
    expect(out.monthlyCredits).toBe(3000);
    expect(out.startsAt).toBe('2026-10-10T00:00:00.000Z');
  });

  it("refuses a workspace of another partner", async () => {
    await expect(
      admin.setWorkspaceLicence(ctx(createFakeDb({ selects: [[]] }).db), 'ptr_a', 'ws_x', { ...terms, packageId: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('createPartner', () => {
  const input = {
    name: 'Andes Cloud',
    legalName: null,
    country: 'BR',
    taxId: null,
    billingEmail: 'bill@andes.test',
    supportEmail: null,
    supportUrl: null,
    websiteUrl: null,
    logoUrl: null,
    ownerEmail: 'Owner@Andes.test',
    contract: {
      currency: 'USD' as const,
      revenueShareBps: 7500,
      baseMinimum: '50.00',
      includedCredits: 2000,
      creditFloorPrice: '0.004',
      extraCreditPrice: '0.01',
      allowedFeaturePlanIds: [],
      paymentTermsDays: 30,
      pastDueAfterDays: 14,
      readOnlyAfterDays: 30,
    },
    territories: ['BR', 'AR'],
  };

  it('creates the Stripe customer, then the partner, contract, territories and owner invite in one transaction', async () => {
    const { db, calls } = createFakeDb({ returns: [[{ id: 'ptr_new', name: 'Andes Cloud', country: 'BR' }], []] });

    const row = await admin.createPartner(ctx(db), input);

    expect(row.id).toBe('ptr_new');
    expect(mocks.createStripeCustomer).toHaveBeenCalledWith(
      'sk_test',
      expect.objectContaining({ email: 'bill@andes.test', name: 'Andes Cloud', metadata: expect.objectContaining({ kind: 'partner' }) }),
      'admin:partner.customer:req_12345678',
    );
    const inserts = calls.filter((c) => c.op === 'insert').map((c) => c.steps.find(([n]) => n === 'values')![1][0] as Record<string, unknown>);
    expect(inserts[0]).toMatchObject({ name: 'Andes Cloud', stripeCustomerId: 'cus_new', billingEmail: 'bill@andes.test' });
    expect(inserts[1]).toMatchObject({ revenueShareBps: 7500, baseMinimum: '50.00', createdBy: 'ops@weldsuite.org', effectiveTo: null });
    expect(mocks.setTerritories).toHaveBeenCalledWith(db, expect.stringMatching(/^ptr_/), ['BR', 'AR']);
    expect(mocks.inviteMember).toHaveBeenCalledWith(db, expect.objectContaining({ email: 'Owner@Andes.test', role: 'owner', invitedBy: 'ops@weldsuite.org' }));
    expect(mocks.sendPartnerInvitationEmail).toHaveBeenCalledWith(env, expect.objectContaining({ to: 'Owner@Andes.test', role: 'owner' }));
  });

  it('refuses a territory another partner owns before creating anything', async () => {
    mocks.findTerritoryConflicts.mockResolvedValue(['AR']);
    const { db, calls } = createFakeDb();
    await expect(admin.createPartner(ctx(db), input)).rejects.toBeInstanceOf(TerritoryConflictError);
    expect(mocks.createStripeCustomer).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('fails when Stripe is not configured, before writing anything', async () => {
    const { db, calls } = createFakeDb();
    const c = { ...ctx(db), env: { ...env, STRIPE_SECRET_KEY: '' } as Env };
    await expect(admin.createPartner(c, input)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(calls).toEqual([]);
  });
});

describe('addContract', () => {
  const contract = {
    currency: 'USD' as const,
    revenueShareBps: 7000,
    baseMinimum: '60.00',
    includedCredits: 2000,
    creditFloorPrice: '0.004',
    extraCreditPrice: '0.01',
    allowedFeaturePlanIds: [],
    paymentTermsDays: 30,
    pastDueAfterDays: 14,
    readOnlyAfterDays: 30,
  };

  it('closes the contract in force at the new start and inserts the new one', async () => {
    const { db, written } = createFakeDb({
      selects: [[{ effectiveFrom: new Date('2026-01-01T00:00:00Z') }]],
      returns: [[], [{ id: 'ptc_2', effectiveFrom: new Date('2026-11-01T00:00:00Z'), effectiveTo: null, currency: 'USD', revenueShareBps: 7000, baseMinimum: '60.00', includedCredits: 2000, creditFloorPrice: '0.004', extraCreditPrice: '0.01', allowedFeaturePlanIds: [], paymentTermsDays: 30, pastDueAfterDays: 14, readOnlyAfterDays: 30 }]],
    });
    const view = await admin.addContract(ctx(db), 'ptr_a', { ...contract, effectiveFrom: '2026-11-01T00:00:00.000Z' });
    expect(written('update')[0]).toEqual({ effectiveTo: new Date('2026-11-01T00:00:00Z') });
    expect(view).toMatchObject({ id: 'ptc_2', revenueShareBps: 7000, effectiveTo: null });
  });

  it('refuses a contract that would start before the current one', async () => {
    const { db } = createFakeDb({ selects: [[{ effectiveFrom: new Date('2026-11-01T00:00:00Z') }]] });
    await expect(admin.addContract(ctx(db), 'ptr_a', { ...contract, effectiveFrom: '2026-10-01T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('refuses feature plans that do not exist', async () => {
    const { db } = createFakeDb({ selects: [[{ id: 'plan_a' }]] });
    await expect(admin.addContract(ctx(db), 'ptr_a', { ...contract, allowedFeaturePlanIds: ['plan_a', 'plan_nope'] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('plan_nope'),
    });
  });
});

describe('members', () => {
  it('will not demote or remove the last owner', async () => {
    const owner = { id: 'ptm_1', email: 'owner@andes.test', role: 'owner' };
    await expect(
      admin.addMember(ctx(createFakeDb({ selects: [[owner], [{ count: 1 }]] }).db), 'ptr_a', { email: 'Owner@andes.test', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(admin.removeMember(ctx(createFakeDb({ selects: [[owner], [{ count: 1 }]] }).db), 'ptr_a', 'ptm_1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.inviteMember).not.toHaveBeenCalled();
  });

  it('removes a member when another owner remains, and only emails brand-new invitees', async () => {
    const owner = { id: 'ptm_1', email: 'owner@andes.test', role: 'owner' };
    const { db, calls } = createFakeDb({ selects: [[owner], [{ count: 2 }]] });
    await expect(admin.removeMember(ctx(db), 'ptr_a', 'ptm_1')).resolves.toEqual({ id: 'ptm_1', email: 'owner@andes.test' });
    expect(calls.some((c) => c.op === 'delete')).toBe(true);

    await admin.addMember(ctx(createFakeDb({ selects: [[]] }).db), 'ptr_a', { email: 'new@andes.test', role: 'billing' });
    expect(mocks.sendPartnerInvitationEmail).toHaveBeenCalledTimes(1);
    await admin.addMember(ctx(createFakeDb({ selects: [[{ id: 'ptm_9', email: 'old@andes.test', role: 'viewer' }]] }).db), 'ptr_a', {
      email: 'old@andes.test',
      role: 'admin',
    });
    expect(mocks.sendPartnerInvitationEmail).toHaveBeenCalledTimes(1);
  });
});

describe('setStatusOverride', () => {
  const partnerRow = (overrides: Record<string, unknown> = {}) => ({ ...partner, status: 'suspended', dunningPausedUntil: null, ...overrides });

  it('sets the status and drops the caches of every partner workspace', async () => {
    mocks.getPartner.mockResolvedValueOnce(partnerRow()).mockResolvedValueOnce(partnerRow({ status: 'active' }));
    mocks.setPartnerStatus.mockResolvedValue(true);
    const after = await admin.setStatusOverride(ctx(createFakeDb().db), 'ptr_a', { status: 'active' });
    expect(mocks.setPartnerStatus).toHaveBeenCalledWith(expect.anything(), 'ptr_a', 'active');
    expect(after.status).toBe('active');
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
    expect(kvDelete).toHaveBeenCalledWith('ws:org_2');
  });

  it('a pause alone re-evaluates the partner, so pausing lifts a suspension at once', async () => {
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    mocks.getPartner.mockResolvedValueOnce(partnerRow()).mockResolvedValueOnce(partnerRow({ status: 'active', dunningPausedUntil: new Date(until) }));
    mocks.recomputePartnerStatus.mockResolvedValue({ changed: true });
    const { db, written } = createFakeDb();
    await admin.setStatusOverride(ctx(db), 'ptr_a', { dunningPausedUntil: until });
    expect(written('update')[0]).toMatchObject({ dunningPausedUntil: new Date(until) });
    expect(mocks.recomputePartnerStatus).toHaveBeenCalled();
    expect(mocks.setPartnerStatus).not.toHaveBeenCalled();
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
  });

  it('null clears the pause', async () => {
    mocks.getPartner.mockResolvedValue(partnerRow({ status: 'active', dunningPausedUntil: new Date('2026-12-01T00:00:00Z') }));
    const { db, written } = createFakeDb();
    await admin.setStatusOverride(ctx(db), 'ptr_a', { dunningPausedUntil: null });
    expect(written('update')[0]).toMatchObject({ dunningPausedUntil: null });
  });

  it('needs a status or a pause date', async () => {
    await expect(admin.setStatusOverride(ctx(createFakeDb().db), 'ptr_a', {})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('statements', () => {
  it('previews a bad period as a 400, and an unknown partner as a 404', async () => {
    await expect(admin.previewStatement(createFakeDb().db, 'ptr_a', '2026-13')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    mocks.getPartner.mockResolvedValue(null);
    await expect(admin.previewStatement(createFakeDb().db, 'ptr_x', '2026-09')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
