/**
 * Route-level tests for /api/people/*. Mirrors the companies route test
 * — see `routes/companies/index.test.ts` for the rationale.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { peopleRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

vi.mock('../../services/people', async () => {
  const actual = await vi.importActual<typeof import('../../services/people')>(
    '../../services/people',
  );
  return {
    ...actual,
    listPeople: vi.fn(),
    getPerson: vi.fn(),
    createPerson: vi.fn(),
  };
});

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import * as peopleService from '../../services/people';
import { publishEntityEvent } from '@weldsuite/entity-events';

const mockedList = peopleService.listPeople as ReturnType<typeof vi.fn>;
const mockedGet = peopleService.getPerson as ReturnType<typeof vi.fn>;
const mockedCreate = peopleService.createPerson as ReturnType<typeof vi.fn>;
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/people (list)', () => {
  it('403 without people:read', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request('/api/people');
    expect(res.status).toBe(403);
  });

  it('200 with the list envelope when permitted', async () => {
    mockedList.mockResolvedValueOnce({
      data: [{ id: 'person_1', displayName: 'Jane' }],
      totalCount: 1,
      hasMore: false,
      cursor: null,
    });
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:read') },
    });
    const res = await request('/api/people');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: unknown };
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });
  });
});

describe('GET /api/people/:id', () => {
  it('404 when missing', async () => {
    mockedGet.mockResolvedValueOnce(null);
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:read') },
    });
    const res = await request('/api/people/person_x');
    expect(res.status).toBe(404);
  });

  it('200 with the single-data envelope', async () => {
    mockedGet.mockResolvedValueOnce({ id: 'person_1', displayName: 'Jane' });
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:read') },
    });
    const res = await request('/api/people/person_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('person_1');
  });
});

describe('POST /api/people (create)', () => {
  it('403 without people:create', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:read') },
    });
    const res = await request('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Jane' }),
    });
    expect(res.status).toBe(403);
  });

  it('201 + publishes a person.created entity event', async () => {
    mockedCreate.mockResolvedValueOnce({
      id: 'person_new',
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      displayName: 'Jane Doe',
      email: null,
      title: null,
    });
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:create') },
    });
    const res = await request('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Jane', lastName: 'Doe' }),
    });
    expect(res.status).toBe(201);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
    };
    expect(call.entityType).toBe('person');
    expect(call.action).toBe('created');
  });
});
