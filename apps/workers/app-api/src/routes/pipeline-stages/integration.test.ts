/**
 * DB-backed integration tests for /api/pipeline-stages.
 *
 * Pipeline stages use the `pipelines:*` permission set (same gate as
 * the parent pipeline) so the harness needs `pipelines:create` /
 * `pipelines:read` etc., not `pipeline-stages:*`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { pipelineStagesRoutes } from './index';
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

describe('/api/pipeline-stages · pglite integration', () => {
  it('POST / writes a stage and publishes pipeline_stage.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });

    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Prospect', position: 0, color: '#abc' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^pls_/);

    const [row] = await db
      .select()
      .from(schema.crmPipelineStages)
      .where(eq(schema.crmPipelineStages.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Prospect');
    expect(row?.position).toBe(0);

    expect(mockedPublish).toHaveBeenCalled();
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
    };
    expect(call.action).toBe('created');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });
    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', position: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
