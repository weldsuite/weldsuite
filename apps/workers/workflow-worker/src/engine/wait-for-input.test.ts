import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runWithInputWaits, RESUME_EVENT_TYPE } from './wait-for-input';
import { buildExecutionHooks } from './persistence';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import type { ActionContext, ExecuteStepsDeps, StepRuntime, WorkflowDefinition, WorkflowRunContext, WorkflowStep } from './types';

/**
 * A fake durable runtime: `do` runs the work, `waitForEvent` hands out the
 * queued events in order, or throws (as Cloudflare does on timeout) when none is left.
 */
function fakeRuntime(events: Array<{ payload: Record<string, unknown> }>, onWait?: () => Promise<void>) {
  const doCalls: string[] = [];
  const waits: Array<{ name: string; type: string; timeout?: string | number }> = [];
  const runtime: StepRuntime = {
    do: async (name, fn) => {
      doCalls.push(name);
      return fn();
    },
    sleep: async () => {},
    waitForEvent: async <T,>(name: string, opts: { type: string; timeout?: string | number }) => {
      waits.push({ name, ...opts });
      await onWait?.();
      const next = events.shift();
      if (!next) throw new Error('Wait timed out');
      return next as T;
    },
  };
  return { runtime, doCalls, waits };
}

const step = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowStep => ({ id, type, name: id, config });

describe('runWithInputWaits (pglite)', () => {
  let db: Database;
  let n = 0;
  let executionId: string;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  });

  beforeEach(async () => {
    executionId = `wex_wait_${++n}`;
    await db.insert(schema.workflowExecutions).values({
      id: executionId,
      workflowId: 'wf_wait',
      status: 'running',
      startedAt: new Date(),
      totalSteps: 3,
    });
  });

  const execRow = async () =>
    (await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, executionId)))[0];
  const stepRows = () =>
    db.select().from(schema.workflowExecutionSteps).where(eq(schema.workflowExecutionSteps.executionId, executionId));

  const workflow: WorkflowDefinition = {
    id: 'wf_wait',
    name: 'Refund approval',
    steps: [step('s1', 'log'), step('approve', 'manual_step', { title: 'Approve refund' }), step('s3', 'log')],
  };

  function deps(runtime: StepRuntime, seen: Array<{ type: string; previous: Record<string, unknown> }>) {
    const executeAction: ExecuteStepsDeps['executeAction'] = async (type, _inputs, ctx: ActionContext) => {
      seen.push({ type, previous: { ...ctx.previousResults } });
      if (type === 'manual_step') {
        return { __waitingForInput: true, stepType: 'manual_step', title: 'Approve refund', approverIds: ['user_a'] };
      }
      return { ok: true };
    };
    const hooks = buildExecutionHooks({ db, rt: null, workspaceId: 'ws_1', executionId, totalSteps: 3, workflowId: 'wf_wait' });
    return { runtime, executeAction, hooks, db, executionId };
  }

  const context = (): WorkflowRunContext => ({
    tenant: { workspaceId: 'ws_1', userId: 'user_a' },
    executionId,
    db,
    env: {},
    triggerData: {},
    variables: {},
  });

  it('marks the run waiting, resumes it on the decision and hands the decision to later steps', async () => {
    let statusWhileWaiting: string | undefined;
    const { runtime, waits, doCalls } = fakeRuntime(
      [{ payload: { approved: true, decision: 'approved', comment: 'Fine', decidedBy: 'user_a', decidedAt: '2026-10-06T10:00:00.000Z' } }],
      async () => {
        statusWhileWaiting = (await execRow()).status;
      },
    );
    const seen: Array<{ type: string; previous: Record<string, unknown> }> = [];

    const result = await runWithInputWaits(workflow, context(), deps(runtime, seen));

    expect(statusWhileWaiting).toBe('waiting_for_input');
    expect(waits).toEqual([{ name: 'wait-input-1', type: RESUME_EVENT_TYPE, timeout: '7 days' }]);
    expect(doCalls).toContain('await-input-1');
    expect(doCalls).toContain('resume-1');
    expect(result.status).toBe('completed');
    expect((await execRow()).status).toBe('running'); // finalize (src/index.ts) closes it

    const decision = {
      approved: true,
      decision: 'approved',
      comment: 'Fine',
      decidedBy: 'user_a',
      decidedByName: null,
      decidedAt: '2026-10-06T10:00:00.000Z',
    };
    expect(result.output.approve).toEqual(decision);
    // The step after the approval sees the decision under steps.<id>.
    expect(seen.at(-1)).toMatchObject({ type: 'log', previous: { approve: decision } });

    const approvalRow = (await stepRows()).find((r) => r.stepId === 'approve');
    expect(approvalRow?.status).toBe('completed');
    expect(approvalRow?.output).toEqual(decision);
    expect((await execRow()).currentStepIndex).toBe(3);
  });

  it('reads a rejection as approved: false', async () => {
    const { runtime } = fakeRuntime([{ payload: { decision: 'rejected', decidedBy: 'user_b' } }]);
    const result = await runWithInputWaits(workflow, context(), deps(runtime, []));
    expect(result.output.approve).toMatchObject({ approved: false, decision: 'rejected', comment: null, decidedBy: 'user_b' });
  });

  it('fails the step with a readable message when nobody decides in time', async () => {
    const { runtime } = fakeRuntime([]);
    const seen: Array<{ type: string; previous: Record<string, unknown> }> = [];

    const result = await runWithInputWaits(workflow, context(), deps(runtime, seen));

    const message = 'Approval expired: nobody approved or rejected this step within 7 days';
    expect(result).toMatchObject({ status: 'failed', error: { stepId: 'approve', message } });
    expect(seen.map((s) => s.type)).toEqual(['log', 'manual_step']); // the last step never ran
    const approvalRow = (await stepRows()).find((r) => r.stepId === 'approve');
    expect(approvalRow?.status).toBe('failed');
    expect(approvalRow?.error).toEqual({ message });
    const errors = await db
      .select()
      .from(schema.workflowErrorLogs)
      .where(eq(schema.workflowErrorLogs.executionId, executionId));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ errorMessage: message, stepId: 'approve', stepType: 'manual_step' });
  });

  it('never overwrites a run cancelled while it waited', async () => {
    const { runtime } = fakeRuntime([{ payload: { approved: true } }], async () => {
      await db
        .update(schema.workflowExecutions)
        .set({ status: 'cancelled' })
        .where(eq(schema.workflowExecutions.id, executionId));
    });
    await runWithInputWaits(workflow, context(), deps(runtime, []));
    expect((await execRow()).status).toBe('cancelled');
  });
});
