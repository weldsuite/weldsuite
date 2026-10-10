/**
 * DB-backed integration tests for /api/pipelines.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { pipelinesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

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

  // ---------------------------------------------------------------------------
  // TASK-922: Duplicate/Import round-trip a pipeline's own nullable columns
  // (e.g. an unset description) straight back into this schema. `null` must
  // be accepted like a missing field, not rejected as a type error.
  // ---------------------------------------------------------------------------

  it('POST / accepts an explicit null description (Duplicate/Import round-trip)', async () => {
    const { request } = createTestApp('/api/pipelines', pipelinesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });
    const res = await request('/api/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Imported pipeline',
        description: null,
        icon: null,
        color: null,
        template: null,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^pl_/);
  });

  // ---------------------------------------------------------------------------
  // TASK-1087: the CRM sidebar lists pipelines in the order the API returns
  // them, and appends a just-created one at the end. Newest-first from the API
  // made the order flip on every reload.
  // ---------------------------------------------------------------------------

  it('GET / lists pipelines oldest first, with a stable order across cursor pages', async () => {
    const base = Date.now() - 60_000;
    const rows = ['Order test C', 'Order test A', 'Order test B'].map((name, i) => ({
      id: `pl_order_${i}`,
      name,
      // Inserted out of creation order on purpose: C is the oldest.
      createdAt: new Date(base + [0, 2000, 1000][i]!),
      updatedAt: new Date(base),
    }));
    await db.insert(schema.crmPipelines).values(rows);

    const { request } = createTestApp('/api/pipelines', pipelinesRoutes, {
      context: { permissions: permissions('pipelines:read'), tenantDb: db },
    });
    const names = (body: { data: { name: string }[] }) => body.data.map((p) => p.name);

    const all = await request('/api/pipelines?search=Order%20test');
    expect(all.status).toBe(200);
    expect(names((await all.json()) as { data: { name: string }[] })).toEqual([
      'Order test C',
      'Order test B',
      'Order test A',
    ]);

    // Paging walks the same order: no repeats, none skipped.
    const first = await request('/api/pipelines?search=Order%20test&limit=2');
    const firstBody = (await first.json()) as {
      data: { name: string }[];
      pagination: { hasMore: boolean; cursor: string | null };
    };
    expect(names(firstBody)).toEqual(['Order test C', 'Order test B']);
    expect(firstBody.pagination.hasMore).toBe(true);

    const second = await request(
      `/api/pipelines?search=Order%20test&limit=2&cursor=${firstBody.pagination.cursor}`,
    );
    expect(names((await second.json()) as { data: { name: string }[] })).toEqual(['Order test A']);
  });
});
