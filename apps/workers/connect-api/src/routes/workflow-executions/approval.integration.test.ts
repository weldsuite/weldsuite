/**
 * Approval steps (`manual_step`): GET /:id/approval and POST /:id/decision.
 * Who may decide, the resume event the run's Cloudflare Workflow instance gets,
 * one decision per waiting step, and the entity event for the decision.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { workflowExecutionsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;
beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({ id: 'wm_approver_a', userId: 'approver_a', name: 'Ada Approver' });
}, 60_000);

let n = 0;
let executionId: string;

/** A run parked on an approval step listing `approverIds`. */
async function seedWaitingRun(approverIds: string[], status = 'waiting_for_input') {
  executionId = `wex_appr_${++n}`;
  await db.insert(schema.workflowExecutions).values({
    id: executionId,
    workflowId: 'wf_appr',
    status,
    cfWorkflowInstanceId: `cf_${executionId}`,
    startedAt: new Date(),
  });
  await db.insert(schema.workflowExecutionSteps).values({
    id: `wes_${executionId}`,
    executionId,
    stepId: 'approve',
    stepName: 'Approve refund',
    stepType: 'manual_step',
    stepIndex: 2,
    status: 'waiting_for_input',
    output: { __waitingForInput: true, stepType: 'manual_step', title: 'Approve refund', description: 'Over 500 EUR', approverIds },
  });
}

function runtime() {
  const sendEvent = vi.fn(async (_event: { type: string; payload: unknown }) => {});
  const get = vi.fn(async (_id: string) => ({ sendEvent }));
  return { binding: { get } as unknown as Workflow, get, sendEvent };
}

function appFor(userId: string, keys: string[], binding?: Workflow) {
  return createTestApp('/api/workflow-executions', workflowExecutionsRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
    env: { EXECUTE_WORKFLOW: binding } as never,
  }).request;
}

const decide = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const stepRow = async () =>
  (await db.select().from(schema.workflowExecutionSteps).where(eq(schema.workflowExecutionSteps.executionId, executionId)))[0];

beforeEach(() => mockedPublish.mockClear());

describe('GET /api/workflow-executions/:id/approval', () => {
  it('describes the pending approval and tells a listed approver they may decide', async () => {
    await seedWaitingRun(['approver_a']);
    const res = await appFor('approver_a', ['workflow-executions:read'])(`/api/workflow-executions/${executionId}/approval`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      approval: { stepId: 'approve', title: 'Approve refund', description: 'Over 500 EUR', approverIds: ['approver_a'] },
      canDecide: true,
    });
  });

  it('does not let someone who is not listed decide, even with workflow-executions:update', async () => {
    await seedWaitingRun(['approver_a']);
    const res = await appFor('admin_1', ['workflow-executions:read', 'workflow-executions:update'])(
      `/api/workflow-executions/${executionId}/approval`,
    );
    expect(((await res.json()) as { data: { canDecide: boolean } }).data.canDecide).toBe(false);
  });

  it('opens the decision to workflow-executions:update when no approver is listed', async () => {
    await seedWaitingRun([]);
    const withUpdate = await appFor('admin_1', ['workflow-executions:read', 'workflow-executions:update'])(
      `/api/workflow-executions/${executionId}/approval`,
    );
    expect(((await withUpdate.json()) as { data: { canDecide: boolean } }).data.canDecide).toBe(true);
    const readOnly = await appFor('member_1', ['workflow-executions:read'])(`/api/workflow-executions/${executionId}/approval`);
    expect(((await readOnly.json()) as { data: { canDecide: boolean } }).data.canDecide).toBe(false);
  });

  it('answers null for a run that is not waiting', async () => {
    await seedWaitingRun(['approver_a'], 'running');
    const res = await appFor('approver_a', ['workflow-executions:read'])(`/api/workflow-executions/${executionId}/approval`);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ approval: null, canDecide: false });
  });
});

describe('POST /api/workflow-executions/:id/decision', () => {
  it('records the decision, resumes the run and publishes workflow_execution.updated', async () => {
    await seedWaitingRun(['approver_a']);
    const rt = runtime();
    const res = await appFor('approver_a', ['workflow-executions:read'], rt.binding)(
      `/api/workflow-executions/${executionId}/decision`,
      decide({ decision: 'approved', comment: '  Go ahead ' }),
    );

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      stepId: 'approve',
      approved: true,
      decision: 'approved',
      comment: 'Go ahead',
      decidedBy: 'approver_a',
      decidedByName: 'Ada Approver',
    });
    expect(rt.get).toHaveBeenCalledWith(`cf_${executionId}`);
    expect(rt.sendEvent).toHaveBeenCalledWith({ type: 'resume-step', payload: data });
    expect((await stepRow()).output).toMatchObject({ decision: { decision: 'approved' } });
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'workflow_execution', action: 'updated', entityId: executionId }),
    );
  });

  it('accepts one decision per approval', async () => {
    await seedWaitingRun(['approver_a']);
    const rt = runtime();
    const request = appFor('approver_a', ['workflow-executions:read'], rt.binding);
    expect((await request(`/api/workflow-executions/${executionId}/decision`, decide({ decision: 'rejected' }))).status).toBe(200);
    const second = await request(`/api/workflow-executions/${executionId}/decision`, decide({ decision: 'approved' }));
    expect(second.status).toBe(409);
    expect(rt.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses someone who is not an approver', async () => {
    await seedWaitingRun(['approver_a']);
    const rt = runtime();
    const res = await appFor('someone_else', ['workflow-executions:read', 'workflow-executions:update'], rt.binding)(
      `/api/workflow-executions/${executionId}/decision`,
      decide({ decision: 'approved' }),
    );
    expect(res.status).toBe(403);
    expect(rt.sendEvent).not.toHaveBeenCalled();
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it('refuses a run that is not waiting, and validates the body', async () => {
    await seedWaitingRun(['approver_a'], 'cancelled');
    const request = appFor('approver_a', ['workflow-executions:read'], runtime().binding);
    const notWaiting = await request(`/api/workflow-executions/${executionId}/decision`, decide({ decision: 'approved' }));
    expect(notWaiting.status).toBe(400);
    const invalid = await request(`/api/workflow-executions/${executionId}/decision`, decide({ decision: 'maybe' }));
    expect(invalid.status).toBe(400);
  });

  it('releases the claim when the run cannot be resumed, so the decision can be made again', async () => {
    await seedWaitingRun(['approver_a']);
    const sendEvent = vi.fn().mockRejectedValueOnce(new Error('instance gone')).mockResolvedValue(undefined);
    const binding = { get: vi.fn(async () => ({ sendEvent })) } as unknown as Workflow;
    const request = appFor('approver_a', ['workflow-executions:read'], binding);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await request(`/api/workflow-executions/${executionId}/decision`, decide({ decision: 'approved' }))).status).toBe(500);
    expect((await stepRow()).output).not.toHaveProperty('decision');
    expect((await request(`/api/workflow-executions/${executionId}/decision`, decide({ decision: 'approved' }))).status).toBe(200);
    error.mockRestore();
  });
});
