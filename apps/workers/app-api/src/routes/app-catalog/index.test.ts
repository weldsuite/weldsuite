/**
 * Route-level tests for GET /api/app-catalog/beta. The service layer is
 * mocked — these assert the route wiring (the literal segment wins over
 * /:code) and that codes are returned canonical, never legacy-translated.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';

vi.mock('../../services/app-catalog', async () => {
  const actual = await vi.importActual<typeof import('../../services/app-catalog')>(
    '../../services/app-catalog',
  );
  return { ...actual, listBetaAppCodes: vi.fn(), getCatalogApp: vi.fn(), installCatalogApp: vi.fn() };
});
vi.mock('@weldsuite/mail-domain/access', () => ({ isAdminOrOwner: vi.fn(async () => true) }));
vi.mock('../../services/partner/managed', async (orig) => {
  const actual = await orig<typeof import('../../services/partner/managed')>();
  return { ...actual, getManagedContext: vi.fn() };
});

import { appCatalogRoutes } from './index';
import * as catalogService from '../../services/app-catalog';
import * as managedService from '../../services/partner/managed';

const mockedBeta = catalogService.listBetaAppCodes as ReturnType<typeof vi.fn>;
const mockedGetApp = catalogService.getCatalogApp as ReturnType<typeof vi.fn>;
const mockedInstall = catalogService.installCatalogApp as ReturnType<typeof vi.fn>;
const mockedManaged = managedService.getManagedContext as ReturnType<typeof vi.fn>;

// Well-formed URL so `getMasterDb` can construct the (unused, mocked) client.
const env = { DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/app-catalog/beta', () => {
  it('returns the beta app codes as canonical codes', async () => {
    mockedBeta.mockResolvedValueOnce(['welddesk', 'weldmail', 'weldagent']);
    const { request } = createTestApp('/api/app-catalog', appCatalogRoutes, { env });

    const res = await request('/api/app-catalog/beta');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: string[] };
    expect(body.data).toEqual(['welddesk', 'weldmail', 'weldagent']);
    expect(mockedGetApp).not.toHaveBeenCalled();
  });

  it('returns an empty list when no app is flagged', async () => {
    mockedBeta.mockResolvedValueOnce([]);
    const { request } = createTestApp('/api/app-catalog', appCatalogRoutes, { env });

    const res = await request('/api/app-catalog/beta');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: string[] };
    expect(body.data).toEqual([]);
  });
});

describe('POST /api/app-catalog/:code/install on a partner-managed workspace', () => {
  const managed = {
    workspaceId: 'ws_1',
    partner: { id: 'ptr_1', name: 'Acme Reseller' },
    partnerStatus: 'active',
    licence: { status: 'active', allowedApps: ['welddesk'], monthlyCredits: 1000, maxSeats: null },
  };
  const install = (code: string) =>
    createTestApp('/api/app-catalog', appCatalogRoutes, { env }).request(`/api/app-catalog/${code}/install`, {
      method: 'POST',
    });

  it('refuses an app the licence does not list with APP_NOT_LICENSED', async () => {
    mockedManaged.mockResolvedValueOnce(managed);
    const res = await install('weldcrm');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'APP_NOT_LICENSED',
        message: 'This workspace is not licensed for weldcrm.',
        details: { app: 'weldcrm' },
      },
    });
    expect(mockedInstall).not.toHaveBeenCalled();
  });

  it('installs a licensed app', async () => {
    mockedManaged.mockResolvedValueOnce(managed);
    mockedInstall.mockResolvedValueOnce({ ok: true, app: { appCode: 'welddesk' } });
    const res = await install('welddesk');
    expect(res.status).toBe(201);
    expect(mockedInstall).toHaveBeenCalledWith(expect.objectContaining({ appCode: 'welddesk' }));
  });

  it('refuses everything when a partner workspace has no licence row', async () => {
    mockedManaged.mockResolvedValueOnce({ ...managed, licence: null });
    const res = await install('welddesk');
    expect(res.status).toBe(403);
  });

  it('installs freely on a direct workspace', async () => {
    mockedManaged.mockResolvedValueOnce(null);
    mockedInstall.mockResolvedValueOnce({ ok: true, app: { appCode: 'weldcrm' } });
    const res = await install('weldcrm');
    expect(res.status).toBe(201);
  });
});
