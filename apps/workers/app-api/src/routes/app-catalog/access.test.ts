/**
 * Apps that are on request only in the catalog routes: the install guard
 * (403 APP_ACCESS_REQUIRED until staff approve the workspace) and the access
 * status the list and detail hand to the store. The service layer is mocked;
 * the guard's own rules run against a real master DB in
 * services/app-access.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';

vi.mock('../../services/app-catalog', async (orig) => {
  const actual = await orig<typeof import('../../services/app-catalog')>();
  return {
    ...actual,
    listCatalogApps: vi.fn(),
    getCatalogApp: vi.fn(),
    installCatalogApp: vi.fn(),
  };
});
vi.mock('../../services/app-access', async (orig) => {
  const actual = await orig<typeof import('../../services/app-access')>();
  return { ...actual, checkInstallAccess: vi.fn(), listAccessStatuses: vi.fn() };
});
vi.mock('@weldsuite/mail-domain/access', () => ({ isAdminOrOwner: vi.fn(async () => true) }));
vi.mock('../../services/partner/managed', async (orig) => {
  const actual = await orig<typeof import('../../services/partner/managed')>();
  return { ...actual, getManagedContext: vi.fn(async () => null) };
});

import { isAdminOrOwner } from '@weldsuite/mail-domain/access';
import { appCatalogRoutes } from './index';
import * as catalogService from '../../services/app-catalog';
import * as accessService from '../../services/app-access';
import * as managedService from '../../services/partner/managed';

const mockedList = vi.mocked(catalogService.listCatalogApps);
const mockedGetApp = vi.mocked(catalogService.getCatalogApp);
const mockedInstall = vi.mocked(catalogService.installCatalogApp);
const mockedCheckAccess = vi.mocked(accessService.checkInstallAccess);
const mockedStatuses = vi.mocked(accessService.listAccessStatuses);
const mockedManaged = vi.mocked(managedService.getManagedContext);
const mockedAdmin = vi.mocked(isAdminOrOwner);

// Well-formed URL so `getMasterDb` can construct the (unused, mocked) client.
const env = { DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db' };
const ORG = 'org_test_default';

beforeEach(() => {
  vi.clearAllMocks();
  mockedAdmin.mockResolvedValue(true);
  mockedManaged.mockResolvedValue(null);
  mockedCheckAccess.mockResolvedValue({ ok: true });
  mockedStatuses.mockResolvedValue(new Map());
});

describe('POST /api/app-catalog/:code/install on an app that is on request only', () => {
  const install = (code: string, orgId: string | null = ORG) =>
    createTestApp('/api/app-catalog', appCatalogRoutes, { env, context: { orgId } }).request(
      `/api/app-catalog/${code}/install`,
      { method: 'POST' },
    );

  it.each(['none', 'requested', 'rejected', 'suspended', 'revoked'] as const)(
    'refuses with APP_ACCESS_REQUIRED while the access status is %s',
    async (status) => {
      mockedCheckAccess.mockResolvedValueOnce({ ok: false, status });

      const res = await install('weldreach');

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: 'APP_ACCESS_REQUIRED',
          message: 'This workspace has no approved access to weldreach.',
          details: { appCode: 'weldreach', status },
        },
      });
      expect(mockedInstall).not.toHaveBeenCalled();
    },
  );

  it('installs once the workspace is approved', async () => {
    mockedInstall.mockResolvedValueOnce({
      ok: true,
      app: { id: 'wia_1', appCode: 'weldreach', isActive: true, displayOrder: 0, settings: {}, installedAt: null },
    });

    const res = await install('weldreach');

    expect(res.status).toBe(201);
    expect(mockedCheckAccess).toHaveBeenCalledWith(expect.anything(), ORG, 'weldreach');
    expect(mockedInstall).toHaveBeenCalledWith(expect.objectContaining({ appCode: 'weldreach' }));
  });

  it('checks the canonical code when a legacy one is sent', async () => {
    mockedInstall.mockResolvedValueOnce({
      ok: true,
      app: { id: 'wia_1', appCode: 'welddesk', isActive: true, displayOrder: 0, settings: {}, installedAt: null },
    });

    await install('helpdesk');

    expect(mockedCheckAccess).toHaveBeenCalledWith(expect.anything(), ORG, 'welddesk');
  });

  it('hands a missing org to the check, which fails closed', async () => {
    mockedCheckAccess.mockResolvedValueOnce({ ok: false, status: 'none' });

    const res = await install('weldreach', null);

    expect(res.status).toBe(403);
    expect(mockedCheckAccess).toHaveBeenCalledWith(expect.anything(), null, 'weldreach');
  });

  it('answers the licence refusal before the access one on a partner workspace', async () => {
    mockedManaged.mockResolvedValueOnce({
      workspaceId: 'ws_1',
      partner: { id: 'ptr_1', name: 'Acme Reseller' },
      partnerStatus: 'active',
      licence: { status: 'active', allowedApps: ['welddesk'], monthlyCredits: 1000, maxSeats: null },
    } as unknown as Awaited<ReturnType<typeof managedService.getManagedContext>>);

    const res = await install('weldreach');

    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_NOT_LICENSED');
    expect(mockedCheckAccess).not.toHaveBeenCalled();
  });

  it('does not let a plain member reach the guard', async () => {
    mockedAdmin.mockResolvedValueOnce(false);

    const res = await install('weldreach');

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(mockedCheckAccess).not.toHaveBeenCalled();
    expect(mockedInstall).not.toHaveBeenCalled();
  });
});

describe('catalog list and detail: access status for the store', () => {
  const statuses = new Map<string, 'requested'>([['weldreach', 'requested']]);

  it('hands the workspace\'s access statuses to the list', async () => {
    mockedStatuses.mockResolvedValueOnce(statuses);
    mockedList.mockResolvedValueOnce([
      { code: 'weldreach', requiresApproval: true, accessStatus: 'requested' },
      { code: 'weldcrm', requiresApproval: false },
    ] as unknown as Awaited<ReturnType<typeof catalogService.listCatalogApps>>);
    const { request } = createTestApp('/api/app-catalog', appCatalogRoutes, { env });

    const res = await request('/api/app-catalog?codes=canonical');

    expect(res.status).toBe(200);
    expect(mockedStatuses).toHaveBeenCalledWith(expect.anything(), ORG);
    expect(mockedList).toHaveBeenCalledWith(expect.anything(), expect.anything(), statuses);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ code: 'weldreach', requiresApproval: true, accessStatus: 'requested' });
    expect(body.data[1]).not.toHaveProperty('accessStatus');
  });

  it('hands them to the detail too', async () => {
    mockedStatuses.mockResolvedValueOnce(statuses);
    mockedGetApp.mockResolvedValueOnce({
      code: 'weldreach',
      requiresApproval: true,
      accessStatus: 'requested',
      installation: null,
    } as unknown as Awaited<ReturnType<typeof catalogService.getCatalogApp>>);
    const { request } = createTestApp('/api/app-catalog', appCatalogRoutes, { env });

    const res = await request('/api/app-catalog/weldreach?codes=canonical');

    expect(res.status).toBe(200);
    expect(mockedGetApp).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'weldreach', statuses);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      accessStatus: 'requested',
    });
  });

  it('skips the lookup when the request has no org', async () => {
    mockedList.mockResolvedValueOnce([]);
    const { request } = createTestApp('/api/app-catalog', appCatalogRoutes, { env, context: { orgId: null } });

    const res = await request('/api/app-catalog');

    expect(res.status).toBe(200);
    expect(mockedStatuses).not.toHaveBeenCalled();
    expect(mockedList).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
  });
});
