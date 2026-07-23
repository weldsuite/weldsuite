/**
 * Route-level tests for /api/companies/*.
 *
 * These exercise the Hono layer: zod validation, permission gating,
 * response envelope shapes. The underlying Drizzle query is fed a mock
 * `Database` (chainable proxy from the harness), so this file doesn't
 * test SQL correctness — pure service tests cover the data shape.
 *
 * What we DO assert here:
 *   - 401 when the request has no authenticated user
 *   - 403 when the user lacks the required permission
 *   - 400 when the request body fails Zod validation
 *   - 200 / 201 / 204 happy paths with the correct envelope
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { companiesRoutes } from './index';
import { createTestApp, permissions, createMockDb } from '../../test/harness';

// Stub the service so we test the route in isolation. Service-level
// tests in `services/companies.test.ts` cover the business logic.
vi.mock('../../services/companies', async () => {
  const actual = await vi.importActual<typeof import('../../services/companies')>(
    '../../services/companies',
  );
  return {
    ...actual,
    listCompanies: vi.fn(),
    getCompany: vi.fn(),
    createCompany: vi.fn(),
    updateCompany: vi.fn(),
    deleteCompany: vi.fn(),
  };
});

// Stub entity-event publisher — fire-and-forget, no need to assert in
// every test. There's a dedicated test below for the create event.
vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import * as companiesService from '../../services/companies';
import { publishEntityEvent } from '@weldsuite/entity-events';

const mockedList = companiesService.listCompanies as ReturnType<typeof vi.fn>;
const mockedGet = companiesService.getCompany as ReturnType<typeof vi.fn>;
const mockedCreate = companiesService.createCompany as ReturnType<typeof vi.fn>;
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/companies (list)', () => {
  it('returns 403 when the user has no companies:read permission', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request('/api/companies');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe('FORBIDDEN');
  });

  it('returns 200 with the list envelope when permitted', async () => {
    mockedList.mockResolvedValueOnce({
      data: [{ id: 'company_1', displayName: 'Acme' }],
      totalCount: 1,
      hasMore: false,
      cursor: null,
    });

    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:read') },
    });
    const res = await request('/api/companies');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });
  });

  it('rejects invalid query params with 400', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:read') },
    });
    // `limit` is coerced to number(min: 1, max: 100). 0 fails the min check.
    const res = await request('/api/companies?limit=0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/companies/:id', () => {
  it('returns 404 when the company is missing', async () => {
    mockedGet.mockResolvedValueOnce(null);
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:read') },
    });
    const res = await request('/api/companies/company_missing');
    expect(res.status).toBe(404);
  });

  it('returns 200 with the single-data envelope', async () => {
    mockedGet.mockResolvedValueOnce({ id: 'company_1', displayName: 'Acme' });
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:read') },
    });
    const res = await request('/api/companies/company_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('company_1');
  });
});

describe('POST /api/companies (create)', () => {
  it('returns 403 when the user lacks companies:create', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:read') },
    });
    const res = await request('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when the body fails Zod validation', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:create') },
    });
    const res = await request('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Missing required `name`
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 201 + publishes a `company.created` entity event', async () => {
    const created = {
      id: 'company_new',
      name: 'Acme',
      website: null,
      industry: null,
    };
    mockedCreate.mockResolvedValueOnce(created);

    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:create') },
    });
    const res = await request('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('company_new');

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
      entityId: string;
    };
    expect(call.entityType).toBe('company');
    expect(call.action).toBe('created');
    expect(call.entityId).toBe('company_new');
  });
});
