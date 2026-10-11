import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../test/fake-db';
import type { Env } from '../index';

const mocks = vi.hoisted(() => ({
  fakeDb: { current: null as unknown },
  svc: {
    addContract: vi.fn(),
    addMember: vi.fn(),
    attachWorkspace: vi.fn(),
    createPartner: vi.fn(),
    detachWorkspace: vi.fn(),
    getPartnerDetail: vi.fn(),
    getStatement: vi.fn(),
    listPartners: vi.fn(),
    previewStatement: vi.fn(),
    removeMember: vi.fn(),
    replaceTerritories: vi.fn(),
    runStatement: vi.fn(),
    setStatusOverride: vi.fn(),
    setWorkspaceLicence: vi.fn(),
    updatePartner: vi.fn(),
    voidStatement: vi.fn(),
  },
}));

vi.mock('../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/db')>()),
  getMasterDb: () => (mocks.fakeDb.current as FakeDb).db,
}));
vi.mock('../services/partner-admin', () => mocks.svc);

const { adminRoutes } = await import('./admin');
const { AdminBillingError } = await import('../services/admin-billing');
const { LicenceError, TerritoryConflictError } = await import('@weldsuite/core-domain/partners');

const SECRET = 'a'.repeat(40);
const env = { BILLING_ADMIN_SECRET: SECRET } as Env;
const REQ = 'req_12345678';

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return adminRoutes.request(
    `/partners${path === '/' ? '' : path}`,
    {
      method,
      headers: {
        'x-admin-secret': SECRET,
        'x-admin-email': 'ops@weldsuite.org',
        'x-admin-user-id': 'user_admin',
        'x-request-id': REQ,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

const json = async (res: Response) => (await res.json()) as { data?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } };

let fake: FakeDb;
const audits = () => fake.written('insert') as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fake = createFakeDb();
  mocks.fakeDb.current = fake;
});

describe('auth', () => {
  it('uses the admin secret and acting-admin checks of the other admin routes', async () => {
    expect((await call('GET', '/', undefined, { 'x-admin-secret': 'b'.repeat(40) })).status).toBe(401);
    expect((await call('GET', '/', undefined, { 'x-admin-email': 'nobody' })).status).toBe(400);
    const noSecret = await adminRoutes.request('/partners', { headers: { 'x-admin-secret': SECRET, 'x-admin-email': 'ops@weldsuite.org' } }, { BILLING_ADMIN_SECRET: undefined } as Env);
    expect(noSecret.status).toBe(503);
    expect(mocks.svc.listPartners).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('lists partners and returns one in detail', async () => {
    mocks.svc.listPartners.mockResolvedValue([{ id: 'ptr_a', name: 'Andes' }]);
    mocks.svc.getPartnerDetail.mockResolvedValue({ partner: { id: 'ptr_a' }, contracts: [], territories: [], members: [], workspaces: [], statements: [] });
    expect(await json(await call('GET', '/'))).toEqual({ data: [{ id: 'ptr_a', name: 'Andes' }] });
    expect((await json(await call('GET', '/ptr_a'))).data).toMatchObject({ partner: { id: 'ptr_a' } });
    expect(mocks.svc.getPartnerDetail).toHaveBeenCalledWith(fake.db, 'ptr_a');
    expect(audits()).toEqual([]);
  });

  it('serves the statement preview before the :statementId route, with the period', async () => {
    mocks.svc.previewStatement.mockResolvedValue({ id: null, status: 'preview' });
    mocks.svc.getStatement.mockResolvedValue({ id: 'pst_1' });
    expect((await json(await call('GET', '/ptr_a/statements/preview?period=2026-09'))).data).toEqual({ id: null, status: 'preview' });
    expect(mocks.svc.previewStatement).toHaveBeenCalledWith(fake.db, 'ptr_a', '2026-09');
    expect((await json(await call('GET', '/ptr_a/statements/pst_1'))).data).toEqual({ id: 'pst_1' });
    expect(mocks.svc.getStatement).toHaveBeenCalledWith(fake.db, 'ptr_a', 'pst_1');
  });

  it('maps a missing partner to 404', async () => {
    mocks.svc.getPartnerDetail.mockRejectedValue(new AdminBillingError('NOT_FOUND', 'Partner not found'));
    const res = await call('GET', '/ptr_x');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toEqual({ code: 'NOT_FOUND', message: 'Partner not found' });
  });
});

describe('writes', () => {
  it('need a usable x-request-id, before anything runs', async () => {
    const res = await call('POST', '/ptr_a/members', { email: 'a@b.co', role: 'admin' }, { 'x-request-id': 'short' });
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toContain('x-request-id');
    expect(mocks.svc.addMember).not.toHaveBeenCalled();
    expect(audits()).toEqual([]);
  });

  it('validate the body with the shared schemas', async () => {
    const res = await call('POST', '/ptr_a/members', { email: 'not-an-email', role: 'admin' });
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toContain('email');
    expect((await call('POST', '/ptr_a/members', { email: 'a@b.co', role: 'god' })).status).toBe(400);
    expect((await call('POST', '/ptr_a/contracts', { baseMinimum: '50', revenueShareBps: 7500, pastDueAfterDays: 30, readOnlyAfterDays: 14 })).status).toBe(400);
    expect(mocks.svc.addMember).not.toHaveBeenCalled();
    expect(mocks.svc.addContract).not.toHaveBeenCalled();
  });

  it('create a partner and audit it against the new partner id', async () => {
    mocks.svc.createPartner.mockResolvedValue({ id: 'ptr_new', name: 'Andes' });
    const res = await call('POST', '/', {
      name: 'Andes',
      billingEmail: 'bill@andes.test',
      ownerEmail: 'owner@andes.test',
      contract: { baseMinimum: '50.00' },
      territories: ['br', 'ar'],
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ id: 'ptr_new', name: 'Andes' });
    // Defaults come from the shared schema; country codes are normalised.
    expect(mocks.svc.createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQ, actor: { email: 'ops@weldsuite.org', userId: 'user_admin' } }),
      expect.objectContaining({
        territories: ['BR', 'AR'],
        contract: expect.objectContaining({ revenueShareBps: 7500, paymentTermsDays: 30, pastDueAfterDays: 14, readOnlyAfterDays: 30 }),
      }),
    );
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      targetType: 'partner',
      targetId: 'ptr_new',
      action: 'partner.create',
      outcome: 'success',
      actorEmail: 'ops@weldsuite.org',
      actorUserId: 'user_admin',
    });
  });

  it('answer 409 TERRITORY_CONFLICT with the conflicting countries, and audit the failure', async () => {
    mocks.svc.replaceTerritories.mockRejectedValue(new TerritoryConflictError(['AR', 'CL']));
    const res = await call('PUT', '/ptr_a/territories', { countries: ['AR', 'CL', 'BR'] });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: 'TERRITORY_CONFLICT', details: { countries: ['AR', 'CL'] } });
    expect(audits()[0]).toMatchObject({ action: 'partner.territories.set', outcome: 'failure', targetId: 'ptr_a' });
  });

  it('return the territory list on success', async () => {
    mocks.svc.replaceTerritories.mockResolvedValue(['AR', 'BR']);
    const res = await call('PUT', '/ptr_a/territories', { countries: ['br', 'ar'] });
    expect((await json(res)).data).toEqual(['AR', 'BR']);
    expect(mocks.svc.replaceTerritories).toHaveBeenCalledWith(expect.anything(), 'ptr_a', ['BR', 'AR']);
  });

  it('delete a member with 204 and audit it', async () => {
    mocks.svc.removeMember.mockResolvedValue({ id: 'ptm_1', email: 'x@y.co' });
    const res = await call('DELETE', '/ptr_a/members/ptm_1');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(mocks.svc.removeMember).toHaveBeenCalledWith(expect.anything(), 'ptr_a', 'ptm_1');
    expect(audits()[0]).toMatchObject({ action: 'partner.member.remove', outcome: 'success' });
  });

  it('map licence refusals: bad apps 400, no contract 409', async () => {
    const body = {
      allowedApps: ['welddesk'],
      monthlyCredits: 100,
      resalePricing: { model: 'flat', amount: '10.00' },
    };
    mocks.svc.setWorkspaceLicence.mockRejectedValueOnce(new LicenceError('INVALID_APPS', 'Unknown or unpublished apps: nope'));
    const bad = await call('PUT', '/ptr_a/workspaces/ws_1/licence', body);
    expect(bad.status).toBe(400);
    expect((await json(bad)).error?.code).toBe('INVALID_APPS');
    mocks.svc.setWorkspaceLicence.mockRejectedValueOnce(new LicenceError('NO_CONTRACT', 'This partner has no contract in force'));
    expect((await call('PUT', '/ptr_a/workspaces/ws_1/licence', body)).status).toBe(409);
  });

  it('pass the workspace and licence to attach, with the reason kept in the audit', async () => {
    mocks.svc.attachWorkspace.mockResolvedValue({ workspaceId: 'ws_1' });
    const res = await call('POST', '/ptr_a/workspaces/attach', {
      workspaceId: 'ws_1',
      licence: { allowedApps: ['welddesk'], monthlyCredits: 100, resalePricing: { model: 'flat', amount: '10.00' } },
      cancelDirectSubscription: 'now',
      reason: 'Customer moves to the reseller',
    });
    expect(res.status).toBe(200);
    expect(mocks.svc.attachWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      'ptr_a',
      expect.objectContaining({ workspaceId: 'ws_1', cancelDirectSubscription: 'now', licence: expect.objectContaining({ packageId: null, maxSeats: null }) }),
    );
    expect(audits()[0]).toMatchObject({ action: 'partner.workspace.attach', reason: 'Customer moves to the reseller', targetId: 'ptr_a' });
  });

  it('detach needs a reason and audits against the workspace', async () => {
    expect((await call('POST', '/ptr_a/workspaces/ws_1/detach', {})).status).toBe(400);
    mocks.svc.detachWorkspace.mockResolvedValue({ workspaceId: 'ws_1', outcome: 'grace_period' });
    const res = await call('POST', '/ptr_a/workspaces/ws_1/detach', { reason: 'Contract ended' });
    expect(res.status).toBe(200);
    expect(mocks.svc.detachWorkspace).toHaveBeenCalledWith(expect.anything(), 'ptr_a', 'ws_1', 'Contract ended');
    expect(audits().at(-1)).toMatchObject({ action: 'partner.workspace.detach', workspaceId: 'ws_1' });
  });

  it('status override takes a status and/or a pause date, with a reason', async () => {
    mocks.svc.setStatusOverride.mockResolvedValue({ id: 'ptr_a', status: 'active' });
    expect((await call('POST', '/ptr_a/status', { status: 'active' })).status).toBe(400); // no reason
    const until = '2026-12-01T00:00:00.000Z';
    const res = await call('POST', '/ptr_a/status', { dunningPausedUntil: until, reason: 'Payment plan agreed' });
    expect(res.status).toBe(200);
    expect(mocks.svc.setStatusOverride).toHaveBeenCalledWith(expect.anything(), 'ptr_a', expect.objectContaining({ dunningPausedUntil: until }));
    expect(audits().at(-1)).toMatchObject({ action: 'partner.status.override', reason: 'Payment plan agreed' });
  });

  it('run a statement for a period with no body, and void one with a reason', async () => {
    mocks.svc.runStatement.mockResolvedValue({ id: 'pst_1', action: 'invoiced' });
    const run = await call('POST', '/ptr_a/statements/run?period=2026-09');
    expect(run.status).toBe(200);
    expect(mocks.svc.runStatement).toHaveBeenCalledWith(expect.anything(), 'ptr_a', '2026-09');

    expect((await call('POST', '/ptr_a/statements/pst_1/void', {})).status).toBe(400);
    mocks.svc.voidStatement.mockResolvedValue({ id: 'pst_1', status: 'void' });
    const voided = await call('POST', '/ptr_a/statements/pst_1/void', { reason: 'Wrong seat count' });
    expect((await json(voided)).data).toEqual({ id: 'pst_1', status: 'void' });
    expect(mocks.svc.voidStatement).toHaveBeenCalledWith(expect.anything(), 'ptr_a', 'pst_1');
    expect(audits().at(-1)).toMatchObject({ action: 'partner.statement.void', reason: 'Wrong seat count' });
  });

  it('turn a Stripe failure into a console-readable error and audit it', async () => {
    mocks.svc.runStatement.mockRejectedValue(
      new Error('Stripe API POST /v1/invoices failed (400): {"error":{"message":"Customer has no email."}}'),
    );
    const res = await call('POST', '/ptr_a/statements/run?period=2026-09');
    expect(res.status).toBe(400);
    expect((await json(res)).error).toEqual({ code: 'STRIPE_REJECTED', message: 'Stripe: Customer has no email.' });
    expect(audits()[0]).toMatchObject({ outcome: 'failure', error: 'Stripe: Customer has no email.' });
  });
});
