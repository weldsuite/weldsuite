/**
 * /api/workflow-schedules against a real (pglite) tenant DB and a recording
 * fake of the D1 schedule index.
 *
 * The schedule index is keyed by the Clerk org id until phase 3 of the
 * workspace-id plan (docs/plans/workspace-id-standardization.md), so a request
 * whose `workspaces.id` differs from its org id must still index the org id.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { createWorkflow } from '../../services/workflows';
import { workflowSchedulesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

/** Records every statement sent to the D1 index. */
function fakeIndex() {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          statements.push({ sql, args });
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
  return { d1, upserts: () => statements.filter((s) => s.sql.includes('INSERT INTO schedule_index')) };
}

describe('/api/workflow-schedules · schedule index ids', () => {
  it('POST / indexes the schedule under the Clerk org id, not workspaces.id', async () => {
    const index = fakeIndex();
    const { request } = createTestApp('/api/workflow-schedules', workflowSchedulesRoutes, {
      context: {
        permissions: permissions('workflows:create'),
        tenantDb: db,
        workspaceId: 'ws_sched_route',
        orgId: 'org_sched_route',
      },
      env: { SCHEDULE_INDEX: index.d1 } as never,
    });
    const { id: workflowId } = await createWorkflow(db, { name: 'scheduled' }, 'user_1');

    const res = await request('/api/workflow-schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, name: 'Daily', cronExpression: '0 9 * * *' }),
    });
    expect(res.status).toBe(201);

    const [upsert] = index.upserts();
    expect(upsert.args[1]).toBe('org_sched_route'); // schedule_index.workspace_id
  });
});
