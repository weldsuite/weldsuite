/**
 * DB-backed integration tests for /api/pipelines.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { pipelinesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/pipelines · pglite integration', () => {
  it('POST / writes a pipeline and publishes pipeline.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/pipelines', pipelinesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });

    const res = await request('/api/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Pipeline', color: '#abcdef' }),
    });

    expect(res.status).toBe(201);
    // The route returns the full created row so callers can render it
    // immediately without a follow-up fetch.
    const body = (await res.json()) as { data: { id: string; name: string; color: string } };
    expect(body.data.id).toMatch(/^pl_/);
    expect(body.data.name).toBe('E2E Pipeline');
    expect(body.data.color).toBe('#abcdef');

    const [row] = await db
      .select()
      .from(schema.crmPipelines)
      .where(eq(schema.crmPipelines.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('E2E Pipeline');
    expect(row?.color).toBe('#abcdef');

    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'pipeline',
        action: 'created',
      }),
    );
  });

  it('POST / requires a non-empty name', async () => {
    const { request } = createTestApp('/api/pipelines', pipelinesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });
    const res = await request('/api/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});
