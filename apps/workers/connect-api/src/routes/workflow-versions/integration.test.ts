/**
 * Route-level tests for workflow version history: a save that activates (or
 * meaningfully changes an already-active) workflow snapshots a version, the
 * history lists newest-first, and restoring an old version re-applies it
 * through the normal update path — re-running the activation gate and
 * resyncing schedule triggers exactly like a save would.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import { workflowVersionsRoutes } from './index';
import { workflowsRoutes } from '../workflows/index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;
beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function env() {
  return { SCHEDULE_INDEX: undefined, EXECUTE_WORKFLOW: undefined } as never;
}

function workflowsApp() {
  return createTestApp('/api/workflows', workflowsRoutes, {
    context: { permissions: permissions('workflows:read', 'workflows:create', 'workflows:update'), tenantDb: db },
    env: env(),
  });
}

function versionsApp() {
  return createTestApp('/api/workflow-versions', workflowVersionsRoutes, {
    context: { permissions: permissions('workflows:read', 'workflows:update'), tenantDb: db },
    env: env(),
  });
}

const entityTrigger = { id: 't1', type: 'entity_event', entityType: 'lead', eventType: 'created', isEnabled: true };
const emailStep = { id: 's1', type: 'send_email', config: { to: 'a@b.co', subject: 'Hi', body: 'Hello' } };

describe('workflow version snapshots', () => {
  it('snapshots version 1 when a workflow is created already active', async () => {
    const { request } = workflowsApp();
    const res = await request(
      '/api/workflows',
      json({ name: 'Welcome', status: 'active', triggers: [entityTrigger], steps: [emailStep] }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const { request: vreq } = versionsApp();
    const listRes = await vreq(`/api/workflow-versions?workflowId=${data.id}`);
    const listBody = (await listRes.json()) as { data: Array<{ version: number; reason: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).toMatchObject({ version: 1, reason: 'activated' });
  });

  it('does not snapshot a draft workflow, but does on its first activation', async () => {
    const { request } = workflowsApp();
    const createRes = await request('/api/workflows', json({ name: 'Draft wf', status: 'draft', triggers: [], steps: [] }));
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const { request: vreq } = versionsApp();
    expect(((await (await vreq(`/api/workflow-versions?workflowId=${created.id}`)).json()) as { data: unknown[] }).data).toHaveLength(0);

    const activateRes = await request(
      `/api/workflows/${created.id}`,
      json({ status: 'active', triggers: [entityTrigger], steps: [emailStep] }, 'PATCH'),
    );
    expect(activateRes.status).toBe(200);

    const afterActivate = (await (await vreq(`/api/workflow-versions?workflowId=${created.id}`)).json()) as {
      data: Array<{ version: number; reason: string }>;
    };
    expect(afterActivate.data).toHaveLength(1);
    expect(afterActivate.data[0]).toMatchObject({ version: 1, reason: 'activated' });
  });

  it('snapshots again when an active workflow is saved with a real change, not for a tag-only touch', async () => {
    const { request } = workflowsApp();
    const createRes = await request(
      '/api/workflows',
      json({ name: 'Active wf', status: 'active', triggers: [entityTrigger], steps: [emailStep] }),
    );
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    // Tag-only touch: no new version.
    await request(`/api/workflows/${created.id}`, json({ tags: ['vip'] }, 'PATCH'));
    const { request: vreq } = versionsApp();
    let listBody = (await (await vreq(`/api/workflow-versions?workflowId=${created.id}`)).json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(1);

    // Real change while active: a new version.
    await request(`/api/workflows/${created.id}`, json({ steps: [emailStep, { ...emailStep, id: 's2' }] }, 'PATCH'));
    listBody = (await (await vreq(`/api/workflow-versions?workflowId=${created.id}`)).json()) as {
      data: Array<{ version: number; reason: string }>;
    };
    expect(listBody.data).toHaveLength(2);
    expect(listBody.data[0]).toMatchObject({ version: 2, reason: 'saved' }); // newest first
  });
});

describe('POST /api/workflow-versions/:id/restore', () => {
  it('restores an old version, runs the gate, resyncs the schedule, and writes a new version', async () => {
    const { request } = workflowsApp();
    const scheduleTrigger = {
      id: 'sched-1',
      type: 'schedule',
      scheduleType: 'recurring',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      isEnabled: true,
    };
    const createRes = await request(
      '/api/workflows',
      json({ name: 'Scheduled wf', status: 'active', triggers: [scheduleTrigger], steps: [emailStep] }),
    );
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    // v2: swap in an entity-event trigger instead (drops the schedule).
    await request(`/api/workflows/${created.id}`, json({ triggers: [entityTrigger] }, 'PATCH'));

    const { request: vreq } = versionsApp();
    const listBody = (await (await vreq(`/api/workflow-versions?workflowId=${created.id}`)).json()) as {
      data: Array<{ id: string; version: number }>;
    };
    expect(listBody.data).toHaveLength(2);
    const v1 = listBody.data.find((v) => v.version === 1)!;

    const restoreRes = await vreq(`/api/workflow-versions/${v1.id}/restore`, json({}));
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as { data: { version: number; restoredFromVersion: number } };
    expect(restoreBody.data).toMatchObject({ version: 3, restoredFromVersion: 1 });

    const workflowRow = (await db.select().from(schema.workflows).where(eq(schema.workflows.id, created.id)))[0];
    expect(workflowRow.triggers).toEqual([scheduleTrigger]);

    // The restore re-ran the schedule sync exactly like a save would: the
    // recurring trigger materializes a workflow_schedules row again.
    const scheduleRows = await db
      .select()
      .from(schema.workflowSchedules)
      .where(and(eq(schema.workflowSchedules.workflowId, created.id), isNull(schema.workflowSchedules.deletedAt)));
    expect(scheduleRows).toHaveLength(1);
    expect(scheduleRows[0]).toMatchObject({ isEnabled: true, cronExpression: '0 9 * * *' });

    const versionsAfter = (await (await vreq(`/api/workflow-versions?workflowId=${created.id}`)).json()) as {
      data: Array<{ version: number; reason: string; restoredFromVersion: number | null }>;
    };
    expect(versionsAfter.data[0]).toMatchObject({ version: 3, reason: 'restored', restoredFromVersion: 1 });
  });

  it('refuses to restore a version that would fail the activation gate on an active workflow', async () => {
    const { request } = workflowsApp();
    const createRes = await request(
      '/api/workflows',
      json({ name: 'Gate wf', status: 'draft', triggers: [], steps: [] }),
    );
    const { data: created } = (await createRes.json()) as { data: { id: string } };
    // No version yet (draft creation doesn't snapshot) — manufacture an
    // unsupported-content "old version" directly to exercise the gate.
    await db.insert(schema.workflowVersions).values({
      id: 'wfv_bad',
      workflowId: created.id,
      version: 1,
      name: 'Gate wf',
      status: 'draft',
      triggers: [{ id: 't-bad', type: 'manual' }] as never,
      steps: [] as never,
      settings: {} as never,
      reason: 'saved',
      createdAt: new Date(),
    });

    // Activate the workflow with valid content first.
    await request(`/api/workflows/${created.id}`, json({ status: 'active', triggers: [entityTrigger], steps: [emailStep] }, 'PATCH'));

    const { request: vreq } = versionsApp();
    const restoreRes = await vreq('/api/workflow-versions/wfv_bad/restore', json({}));
    expect(restoreRes.status).toBe(400);
    const body = (await restoreRes.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe('weldconnect_unsupported');
  });
});
