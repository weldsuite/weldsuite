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
  return { ...actual, listBetaAppCodes: vi.fn(), getCatalogApp: vi.fn() };
});

import { appCatalogRoutes } from './index';
import * as catalogService from '../../services/app-catalog';

const mockedBeta = catalogService.listBetaAppCodes as ReturnType<typeof vi.fn>;
const mockedGetApp = catalogService.getCatalogApp as ReturnType<typeof vi.fn>;

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
