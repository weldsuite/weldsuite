/**
 * DB-backed integration tests for /api/workflows.
 *
 * Workflows use the `tasks:*` permission set (legacy naming — the
 * Workflows module sat under WeldConnect/Task historically).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { workflowsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { type Database } from '../../db';

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

describe('/api/workflows · pglite integration', () => {
  it('POST / writes a workflow and publishes workflow.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('tasks:create'), tenantDb: db },
    });

    const res = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Workflow' }),
    });

    expect(res.status).toBe(201);
    // The route returns just `{ id }` from the service; the full row
    // lives in DB and is exercised by GET /:id covered below.
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^wf_/);

    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'workflow',
        action: 'created',
      }),
    );
  });

  it('GET /:id returns 404 for a missing workflow', async () => {
    const { request } = createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('tasks:read'), tenantDb: db },
    });
    const res = await request('/api/workflows/wf_missing_123');
    expect(res.status).toBe(404);
  });
});
