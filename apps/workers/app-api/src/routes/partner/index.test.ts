/**
 * Partner portal routes: partnerAuth (memberships, X-Partner-Id), the
 * permission matrix, the licence write flow, managed workspace creation and
 * the guards on team / credits / settings.
 *
 * The partner tables are not in pglite (no migration exists yet), so the
 * master-DB services of `@weldsuite/core-domain/partners` are mocked and the
 * tests assert how the routes call them. The partner maths and SQL live in
 * the domain package.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';

const masterDb = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  // `users.email` lookup of the caller.
  chain.limit = async () => [{ email: 'user@partner.test' }];
  return chain;
});

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => masterDb };
});

vi.mock('@weldsuite/core-domain/partners', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/core-domain/partners')>();
  return {
    ...actual,
    listPartnerMemberships: vi.fn(),
    partnerOverview: vi.fn(),
    listManagedWorkspaces: vi.fn(),
    getManagedWorkspace: vi.fn(),
    listLicenceHistory: vi.fn(),
    getPartnerWorkspace: vi.fn(),
    getPackage: vi.fn(),
    validateLicenceTerms: vi.fn(),
    upsertWorkspaceLicence: vi.fn(),
    setLicenceStatus: vi.fn(),
    grantPartnerExtraCredits: vi.fn(),
    markRequestProvisioned: vi.fn(),
    updateRequestStatus: vi.fn(),
    inviteTeamMember: vi.fn(),
    updateTeamMemberRole: vi.fn(),
    removeTeamMember: vi.fn(),
    updatePartnerSettings: vi.fn(),
    listPackages: vi.fn(),
    listTeam: vi.fn(),
    partnerStatementList: vi.fn(),
    partnerStatement: vi.fn(),
    currentStatementPreview: vi.fn(),
  };
});

vi.mock('../../services/partner/licence-effects', () => ({
  applyLicenceEffects: vi.fn(async () => ({ warnings: [] as string[] })),
}));
vi.mock('../../services/partner/notify', () => ({
  sendPartnerInviteEmail: vi.fn(async () => undefined),
}));

import * as domain from '@weldsuite/core-domain/partners';
import { applyLicenceEffects } from '../../services/partner/licence-effects';
import { sendPartnerInviteEmail } from '../../services/partner/notify';
import { partnerRoutes } from './index';
import type { Env } from '../../types';

const m = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const PARTNER = { id: 'ptr_1', name: 'Acme Reseller', status: 'active' } as domain.PartnerRow;
const OTHER_PARTNER = { id: 'ptr_2', name: 'Other Reseller', status: 'active' } as domain.PartnerRow;

type Role = 'owner' | 'admin' | 'billing' | 'viewer';

function memberships(...rows: Array<[domain.PartnerRow, Role]>) {
  m(domain.listPartnerMemberships).mockResolvedValue(
    rows.map(([partner, role], i) => ({ partner, memberId: `ptm_${i + 1}`, role })),
  );
}

const onboardPartnerWorkspace = vi.fn();

function app(env: Partial<Env> = {}) {
  return createTestApp('/api/partner', partnerRoutes, {
    context: { userId: 'user_1' },
    env: {
      DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db',
      WORKSPACE_WORKER: { onboard: vi.fn(), onboardPartnerWorkspace },
      ...env,
    } as Partial<Env>,
  });
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const LICENCE_BODY = {
  allowedApps: ['welddesk', 'weldcrm'],
  monthlyCredits: 3000,
  creditRolloverCap: 0,
  maxSeats: 5,
  featurePlanId: 'pln_business',
  storageGb: null,
  resalePricing: { model: 'flat', amount: '199.00' },
  packageId: 'plp_1',
  reason: 'upgrade',
};

beforeEach(() => {
  vi.clearAllMocks();
  m(domain.getPartnerWorkspace).mockResolvedValue({ id: 'ws_1', clerkOrgId: 'org_1' });
  m(domain.getManagedWorkspace).mockResolvedValue({ workspaceId: 'ws_1', name: 'Customer' });
  m(domain.getPackage).mockResolvedValue({ id: 'plp_1' });
  m(domain.validateLicenceTerms).mockResolvedValue(undefined);
});

describe('partnerAuth', () => {
  it('refuses a user who belongs to no partner', async () => {
    memberships();
    const res = await app().request('/api/partner/overview');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_A_PARTNER');
  });

  it('claims invitations with the email on record for the user', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.partnerOverview).mockResolvedValue({ workspaceCount: 0 });
    await app().request('/api/partner/overview');
    expect(domain.listPartnerMemberships).toHaveBeenCalledWith(masterDb, {
      id: 'user_1',
      emails: ['user@partner.test'],
    });
  });

  it('acts for the only partner without X-Partner-Id', async () => {
    memberships([PARTNER, 'viewer']);
    m(domain.partnerOverview).mockResolvedValue({ workspaceCount: 3 });
    const res = await app().request('/api/partner/overview');
    expect(res.status).toBe(200);
    expect(domain.partnerOverview).toHaveBeenCalledWith(
      masterDb,
      expect.objectContaining({ partner: PARTNER, role: 'viewer', includeBilling: false }),
    );
  });

  it('needs X-Partner-Id when the user has several partners', async () => {
    memberships([PARTNER, 'owner'], [OTHER_PARTNER, 'viewer']);
    const res = await app().request('/api/partner/overview');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PARTNER_REQUIRED');
  });

  it('picks the partner named by X-Partner-Id and uses the role held there', async () => {
    memberships([PARTNER, 'owner'], [OTHER_PARTNER, 'viewer']);
    m(domain.partnerOverview).mockResolvedValue({});
    const res = await app().request('/api/partner/overview', { headers: { 'X-Partner-Id': 'ptr_2' } });
    expect(res.status).toBe(200);
    expect(domain.partnerOverview).toHaveBeenCalledWith(
      masterDb,
      expect.objectContaining({ partner: OTHER_PARTNER, role: 'viewer' }),
    );
  });

  it('refuses a partner the user does not belong to', async () => {
    memberships([PARTNER, 'owner']);
    const res = await app().request('/api/partner/overview', { headers: { 'X-Partner-Id': 'ptr_other' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_A_PARTNER');
  });
});

describe('GET /me', () => {
  it('lists memberships without X-Partner-Id', async () => {
    memberships([PARTNER, 'admin'], [OTHER_PARTNER, 'billing']);
    const res = await app().request('/api/partner/me');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual([
      { partnerId: 'ptr_1', partnerName: 'Acme Reseller', role: 'admin', status: 'active' },
      { partnerId: 'ptr_2', partnerName: 'Other Reseller', role: 'billing', status: 'active' },
    ]);
  });

  it('answers a non-partner with an empty list, not an error', async () => {
    memberships();
    const res = await app().request('/api/partner/me');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual([]);
  });
});

describe('permission matrix', () => {
  // [method, path, body, roles that may call it]
  const cases: Array<[string, string, unknown, Role[]]> = [
    ['GET', '/workspaces', undefined, ['owner', 'admin', 'billing', 'viewer']],
    ['GET', '/workspaces/ws_1', undefined, ['owner', 'admin', 'billing', 'viewer']],
    ['GET', '/packages', undefined, ['owner', 'admin', 'billing', 'viewer']],
    ['GET', '/team', undefined, ['owner', 'admin', 'billing', 'viewer']],
    ['GET', '/statements', undefined, ['owner', 'admin', 'billing']],
    ['GET', '/statements/current', undefined, ['owner', 'admin', 'billing']],
    ['PUT', '/workspaces/ws_1/licence', LICENCE_BODY, ['owner', 'admin']],
    ['POST', '/workspaces/ws_1/status', { status: 'suspended' }, ['owner', 'admin']],
    ['POST', '/packages', undefined, ['owner', 'admin']],
    ['PATCH', '/requests/pwr_1', { status: 'contacted' }, ['owner', 'admin']],
    ['POST', '/team', { email: 'new@partner.test', role: 'viewer' }, ['owner']],
    ['PATCH', '/team/ptm_9', { role: 'admin' }, ['owner']],
    ['DELETE', '/team/ptm_9', undefined, ['owner']],
    ['PATCH', '/settings', { supportEmail: 'help@partner.test' }, ['owner']],
  ];
  const roles: Role[] = ['owner', 'admin', 'billing', 'viewer'];

  it.each(cases)('%s %s', async (method, path, body, allowed) => {
    // Domain calls return something harmless; the point is 403 vs not-403.
    m(domain.listManagedWorkspaces).mockResolvedValue({ rows: [], totalCount: 0 });
    m(domain.listLicenceHistory).mockResolvedValue([]);
    m(domain.listPackages).mockResolvedValue([]);
    m(domain.listTeam).mockResolvedValue([]);
    m(domain.partnerStatementList).mockResolvedValue([]);
    m(domain.currentStatementPreview).mockResolvedValue({ lines: [] });
    m(domain.upsertWorkspaceLicence).mockResolvedValue({ licence: LICENCE_ROW, previous: null, changeId: 'wlc_1' });
    m(domain.setLicenceStatus).mockResolvedValue({ licence: LICENCE_ROW, previous: null, changeId: 'wlc_1' });
    m(domain.updateTeamMemberRole).mockResolvedValue({ id: 'ptm_9' });
    m(domain.updateRequestStatus).mockResolvedValue({ id: 'pwr_1' });
    m(domain.removeTeamMember).mockResolvedValue(true);
    m(domain.inviteTeamMember).mockResolvedValue({ id: 'ptm_9', email: 'new@partner.test', role: 'viewer' });
    m(domain.updatePartnerSettings).mockResolvedValue({ id: 'ptr_1' });

    for (const role of roles) {
      memberships([PARTNER, role]);
      const { request } = app();
      const res = await request(
        `/api/partner${path}`,
        method === 'GET' || method === 'DELETE' ? { method } : { method, ...json(body ?? {}) },
      );
      if (allowed.includes(role)) {
        expect(res.status, `${role} should reach ${method} ${path}`).not.toBe(403);
      } else {
        expect(res.status, `${role} must not reach ${method} ${path}`).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('shows the billing totals in the overview only with billing:read', async () => {
    m(domain.partnerOverview).mockResolvedValue({});
    for (const [role, includeBilling] of [
      ['owner', true],
      ['billing', true],
      ['viewer', false],
    ] as const) {
      memberships([PARTNER, role]);
      await app().request('/api/partner/overview');
      expect(domain.partnerOverview).toHaveBeenLastCalledWith(masterDb, expect.objectContaining({ includeBilling }));
    }
  });
});

const LICENCE_ROW = {
  status: 'active',
  allowedApps: ['welddesk', 'weldcrm'],
  monthlyCredits: 3000,
  creditRolloverCap: 0,
  maxSeats: 5,
  featurePlanId: 'pln_business',
  storageGb: null,
  resalePricing: { model: 'flat', amount: '199.00' },
  packageId: 'plp_1',
};

describe('PUT /workspaces/:id/licence', () => {
  it('validates, writes the licence as the partner user, then applies its effects', async () => {
    memberships([PARTNER, 'admin']);
    m(domain.upsertWorkspaceLicence).mockResolvedValue({
      licence: LICENCE_ROW,
      previous: { monthlyCredits: 1000 },
      changeId: 'wlc_9',
    });

    const res = await app().request('/api/partner/workspaces/ws_1/licence', { method: 'PUT', ...json(LICENCE_BODY) });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { workspaceId: string } }).data.workspaceId).toBe('ws_1');

    const terms = {
      allowedApps: ['welddesk', 'weldcrm'],
      monthlyCredits: 3000,
      creditRolloverCap: 0,
      maxSeats: 5,
      featurePlanId: 'pln_business',
      storageGb: null,
      resalePricing: { model: 'flat', amount: '199.00' },
    };
    expect(domain.validateLicenceTerms).toHaveBeenCalledWith(masterDb, 'ptr_1', terms);
    expect(domain.upsertWorkspaceLicence).toHaveBeenCalledWith({
      db: masterDb,
      workspaceId: 'ws_1',
      partnerId: 'ptr_1',
      terms,
      packageId: 'plp_1',
      actor: { id: 'user_1', type: 'partner' },
      reason: 'upgrade',
    });
    expect(applyLicenceEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: { id: 'ws_1', clerkOrgId: 'org_1' },
        previous: { monthlyCredits: 1000 },
        changeId: 'wlc_9',
        actor: { id: 'user_1', type: 'partner' },
        licence: expect.objectContaining({ monthlyCredits: 3000, allowedApps: ['welddesk', 'weldcrm'] }),
      }),
    );
    // Validation happens before anything is written.
    const validated = m(domain.validateLicenceTerms).mock.invocationCallOrder[0]!;
    const written = m(domain.upsertWorkspaceLicence).mock.invocationCallOrder[0]!;
    const applied = vi.mocked(applyLicenceEffects).mock.invocationCallOrder[0]!;
    expect(validated).toBeLessThan(written);
    expect(written).toBeLessThan(applied);
  });

  it('404s for a workspace of another partner and writes nothing', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.getPartnerWorkspace).mockResolvedValue(null);
    const res = await app().request('/api/partner/workspaces/ws_x/licence', { method: 'PUT', ...json(LICENCE_BODY) });
    expect(res.status).toBe(404);
    expect(domain.upsertWorkspaceLicence).not.toHaveBeenCalled();
    expect(applyLicenceEffects).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_APPS', 400],
    ['PLAN_NOT_ALLOWED', 400],
    ['NO_CONTRACT', 409],
    ['WRONG_PARTNER', 404],
  ] as const)('maps LicenceError %s to %i', async (code, status) => {
    memberships([PARTNER, 'owner']);
    m(domain.validateLicenceTerms).mockRejectedValue(new domain.LicenceError(code, 'nope'));
    const res = await app().request('/api/partner/workspaces/ws_1/licence', { method: 'PUT', ...json(LICENCE_BODY) });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(domain.upsertWorkspaceLicence).not.toHaveBeenCalled();
  });

  it('refuses a package that is not the partner’s', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.getPackage).mockResolvedValue(null);
    const res = await app().request('/api/partner/workspaces/ws_1/licence', { method: 'PUT', ...json(LICENCE_BODY) });
    expect(res.status).toBe(400);
    expect(domain.upsertWorkspaceLicence).not.toHaveBeenCalled();
  });

  it('reports a failed post-write step in a header without failing the write', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.upsertWorkspaceLicence).mockResolvedValue({ licence: LICENCE_ROW, previous: null, changeId: 'wlc_1' });
    vi.mocked(applyLicenceEffects).mockResolvedValueOnce({ warnings: ['installed_apps'] });
    const res = await app().request('/api/partner/workspaces/ws_1/licence', { method: 'PUT', ...json(LICENCE_BODY) });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Partner-Warnings')).toBe('installed_apps');
  });
});

describe('POST /workspaces/:id/status', () => {
  it('changes the licence status and applies its effects', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.setLicenceStatus).mockResolvedValue({
      licence: { ...LICENCE_ROW, status: 'suspended' },
      previous: LICENCE_ROW,
      changeId: 'wlc_2',
    });
    const res = await app().request('/api/partner/workspaces/ws_1/status', {
      method: 'POST',
      ...json({ status: 'suspended', reason: 'unpaid' }),
    });
    expect(res.status).toBe(200);
    expect(domain.setLicenceStatus).toHaveBeenCalledWith({
      db: masterDb,
      workspaceId: 'ws_1',
      partnerId: 'ptr_1',
      status: 'suspended',
      actor: { id: 'user_1', type: 'partner' },
      reason: 'unpaid',
    });
    expect(applyLicenceEffects).toHaveBeenCalledWith(
      expect.objectContaining({ licence: expect.objectContaining({ status: 'suspended' }), changeId: 'wlc_2' }),
    );
  });
});

describe('POST /workspaces (managed workspace creation)', () => {
  const body = {
    name: 'Customer BV',
    country: 'br',
    ownerEmail: 'Owner@Customer.test',
    licence: LICENCE_BODY,
    requestId: 'pwr_1',
  };

  it('creates the workspace through workspace-worker and marks the request provisioned', async () => {
    memberships([PARTNER, 'admin']);
    onboardPartnerWorkspace.mockResolvedValue({ workspaceId: 'ws_new', clerkOrgId: 'org_new' });
    m(domain.markRequestProvisioned).mockResolvedValue(true);

    const res = await app().request('/api/partner/workspaces', { method: 'POST', ...json(body) });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ workspaceId: 'ws_new' });
    expect(onboardPartnerWorkspace).toHaveBeenCalledWith({
      partnerId: 'ptr_1',
      actorUserId: 'user_1',
      name: 'Customer BV',
      country: 'BR',
      region: undefined,
      ownerEmail: 'owner@customer.test',
      licence: {
        allowedApps: ['welddesk', 'weldcrm'],
        monthlyCredits: 3000,
        creditRolloverCap: 0,
        maxSeats: 5,
        featurePlanId: 'pln_business',
        storageGb: null,
        resalePricing: { model: 'flat', amount: '199.00' },
        packageId: 'plp_1',
      },
    });
    expect(domain.validateLicenceTerms).toHaveBeenCalled();
    expect(domain.markRequestProvisioned).toHaveBeenCalledWith(masterDb, 'ptr_1', 'pwr_1', 'ws_new');
  });

  it('does not touch a request when none was given', async () => {
    memberships([PARTNER, 'admin']);
    onboardPartnerWorkspace.mockResolvedValue({ workspaceId: 'ws_new', clerkOrgId: 'org_new' });
    const { requestId: _omit, ...noRequest } = body;
    const res = await app().request('/api/partner/workspaces', { method: 'POST', ...json(noRequest) });
    expect(res.status).toBe(201);
    expect(domain.markRequestProvisioned).not.toHaveBeenCalled();
  });

  it('does not create anything when the licence is invalid', async () => {
    memberships([PARTNER, 'admin']);
    m(domain.validateLicenceTerms).mockRejectedValue(new domain.LicenceError('INVALID_APPS', 'Unknown apps'));
    const res = await app().request('/api/partner/workspaces', { method: 'POST', ...json(body) });
    expect(res.status).toBe(400);
    expect(onboardPartnerWorkspace).not.toHaveBeenCalled();
  });

  it('pauses creation for a suspended partner', async () => {
    memberships([{ ...PARTNER, status: 'suspended' } as domain.PartnerRow, 'owner']);
    const res = await app().request('/api/partner/workspaces', { method: 'POST', ...json(body) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PARTNER_SUSPENDED');
    expect(onboardPartnerWorkspace).not.toHaveBeenCalled();
  });

  it('answers 502 when workspace-worker fails', async () => {
    memberships([PARTNER, 'owner']);
    onboardPartnerWorkspace.mockRejectedValue(new Error('boom'));
    const res = await app().request('/api/partner/workspaces', { method: 'POST', ...json(body) });
    expect(res.status).toBe(502);
    expect(domain.markRequestProvisioned).not.toHaveBeenCalled();
  });

  it('answers 500 when the RPC method is not deployed yet', async () => {
    memberships([PARTNER, 'owner']);
    const res = await app({ WORKSPACE_WORKER: { onboard: vi.fn() } as unknown as Env['WORKSPACE_WORKER'] }).request(
      '/api/partner/workspaces',
      { method: 'POST', ...json(body) },
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /workspaces/:id/credits', () => {
  const grant = { credits: 500, note: 'goodwill' };

  it('needs an Idempotency-Key', async () => {
    memberships([PARTNER, 'owner']);
    const res = await app().request('/api/partner/workspaces/ws_1/credits', { method: 'POST', ...json(grant) });
    expect(res.status).toBe(400);
    expect(domain.grantPartnerExtraCredits).not.toHaveBeenCalled();
  });

  it('grants once per key, scoped to partner and workspace', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.getManagedWorkspace).mockResolvedValue({ workspaceId: 'ws_1', licence: { status: 'active' } });
    m(domain.grantPartnerExtraCredits).mockResolvedValue({ grantId: 'pcg_1', newBalance: 3500, amount: '2.00', duplicate: false });

    const res = await app().request('/api/partner/workspaces/ws_1/credits', {
      method: 'POST',
      ...json(grant, { 'Idempotency-Key': 'abc' }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ newBalance: 3500, amount: 500, charge: '2.00' });
    expect(domain.grantPartnerExtraCredits).toHaveBeenCalledWith({
      db: masterDb,
      partnerId: 'ptr_1',
      workspaceId: 'ws_1',
      credits: 500,
      grantedBy: 'user_1',
      note: 'goodwill',
      idempotencyKey: 'ptr_1:ws_1:abc',
    });
  });

  it('refuses a workspace whose licence is not active', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.getManagedWorkspace).mockResolvedValue({ workspaceId: 'ws_1', licence: { status: 'suspended' } });
    const res = await app().request('/api/partner/workspaces/ws_1/credits', {
      method: 'POST',
      ...json(grant, { 'Idempotency-Key': 'abc' }),
    });
    expect(res.status).toBe(409);
    expect(domain.grantPartnerExtraCredits).not.toHaveBeenCalled();
  });
});

describe('team', () => {
  it('invites a member and emails the invitation', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.inviteTeamMember).mockResolvedValue({ id: 'ptm_5', email: 'new@partner.test', role: 'billing' });
    const res = await app().request('/api/partner/team', {
      method: 'POST',
      ...json({ email: 'new@partner.test', role: 'billing' }),
    });
    expect(res.status).toBe(201);
    expect(domain.inviteTeamMember).toHaveBeenCalledWith(masterDb, {
      partnerId: 'ptr_1',
      email: 'new@partner.test',
      role: 'billing',
      invitedBy: 'user_1',
    });
    expect(sendPartnerInviteEmail).toHaveBeenCalledWith(expect.anything(), {
      to: 'new@partner.test',
      partnerName: 'Acme Reseller',
      role: 'billing',
    });
  });

  it('answers 409 for an email that is already a member', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.inviteTeamMember).mockRejectedValue(new domain.PartnerPortalError('ALREADY_MEMBER', 'already'));
    const res = await app().request('/api/partner/team', {
      method: 'POST',
      ...json({ email: 'new@partner.test', role: 'viewer' }),
    });
    expect(res.status).toBe(409);
    expect(sendPartnerInviteEmail).not.toHaveBeenCalled();
  });

  it('refuses to demote or remove the last owner with 409 LAST_OWNER', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.updateTeamMemberRole).mockRejectedValue(new domain.PartnerPortalError('LAST_OWNER', 'last'));
    m(domain.removeTeamMember).mockRejectedValue(new domain.PartnerPortalError('LAST_OWNER', 'last'));

    const demote = await app().request('/api/partner/team/ptm_1', { method: 'PATCH', ...json({ role: 'admin' }) });
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: { code: string } }).error.code).toBe('LAST_OWNER');

    const remove = await app().request('/api/partner/team/ptm_1', { method: 'DELETE' });
    expect(remove.status).toBe(409);
    expect(((await remove.json()) as { error: { code: string } }).error.code).toBe('LAST_OWNER');
  });

  it('removes a member with 204', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.removeTeamMember).mockResolvedValue(true);
    const res = await app().request('/api/partner/team/ptm_2', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(domain.removeTeamMember).toHaveBeenCalledWith(masterDb, 'ptr_1', 'ptm_2');
  });
});

describe('settings', () => {
  it('rejects non-http(s) URLs that would be rendered to customers', async () => {
    memberships([PARTNER, 'owner']);
    for (const field of ['websiteUrl', 'supportUrl', 'logoUrl']) {
      const res = await app().request('/api/partner/settings', {
        method: 'PATCH',
        ...json({ [field]: 'javascript:alert(1)' }),
      });
      expect(res.status, field).toBe(400);
    }
    expect(domain.updatePartnerSettings).not.toHaveBeenCalled();
  });

  it('updates the contact details shown to customers', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.updatePartnerSettings).mockResolvedValue({ id: 'ptr_1', supportEmail: 'help@partner.test' });
    const res = await app().request('/api/partner/settings', {
      method: 'PATCH',
      ...json({ supportEmail: 'help@partner.test', websiteUrl: 'https://partner.test' }),
    });
    expect(res.status).toBe(200);
    expect(domain.updatePartnerSettings).toHaveBeenCalledWith(masterDb, 'ptr_1', {
      supportEmail: 'help@partner.test',
      websiteUrl: 'https://partner.test',
    });
  });
});

describe('statements', () => {
  it('serves the current statement as CSV, one row per workspace line', async () => {
    memberships([PARTNER, 'billing']);
    m(domain.currentStatementPreview).mockResolvedValue({
      id: null,
      periodStart: '2026-10-01T00:00:00.000Z',
      lines: [
        {
          workspaceId: 'ws_1',
          workspaceName: 'Acme, Inc',
          daysActive: 31,
          daysInPeriod: 31,
          seatsBilled: 0,
          resale: '199.00',
          shareAmount: '149.25',
          floorAmount: '50.00',
          creditFloorAmount: '0.00',
          extraCreditsAmount: '0.00',
          due: '149.25',
          margin: '49.75',
        },
      ],
    });
    const res = await app().request('/api/partner/statements/current/csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('statement-2026-10.csv');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('"Acme, Inc",ws_1,31,31,0,199.00,149.25,50.00,0.00,0.00,149.25,49.75');
  });

  it('404s an unknown statement', async () => {
    memberships([PARTNER, 'owner']);
    m(domain.partnerStatement).mockResolvedValue(null);
    const res = await app().request('/api/partner/statements/pst_nope');
    expect(res.status).toBe(404);
  });
});
