import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildExecutionHooks } from './persistence';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import type { WorkflowStep } from './types';

const step = (id: string, type = 'send_email'): WorkflowStep => ({ id, type, name: `Step ${id}` });

describe('buildExecutionHooks (pglite)', () => {
  let db: Database;
  let n = 0;
  let executionId: string;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  });

  beforeEach(async () => {
    executionId = `wex_persist_${++n}`;
    await db.insert(schema.workflowExecutions).values({
      id: executionId,
      workflowId: 'wf_persist',
      status: 'running',
      startedAt: new Date(),
      totalSteps: 3,
    });
  });

  const hooksFor = () =>
    buildExecutionHooks({ db, rt: null, workspaceId: 'ws_1', executionId, totalSteps: 3, workflowId: 'wf_persist' });
  const errorRows = () =>
    db.select().from(schema.workflowErrorLogs).where(eq(schema.workflowErrorLogs.executionId, executionId));
  const execRow = async () =>
    (await db.select().from(schema.workflowExecutions).where(eq(schema.workflowExecutions.id, executionId)))[0];
  const stepRows = () =>
    db.select().from(schema.workflowExecutionSteps).where(eq(schema.workflowExecutionSteps.executionId, executionId));

  it('writes a start line and a completion line, and counts the finished step', async () => {
    const h = hooksFor();
    await h.onStepStart?.(step('s1'), 0);
    expect((await stepRows())[0].logs).toHaveLength(1);

    await h.onStepResult?.(step('s1'), 0, { status: 'completed', result: { ok: true }, attempts: 1 });

    const [row] = await stepRows();
    expect(row.status).toBe('completed');
    const logs = row.logs ?? [];
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ level: 'info', message: 'Started Step s1 (send_email)' });
    expect(logs[1].level).toBe('info');
    expect(logs[1].message).toMatch(/^Completed in \d+ms$/);
    expect(Number.isNaN(Date.parse(logs[1].timestamp))).toBe(false);
    expect((await execRow()).currentStepIndex).toBe(1);
  });

  it('records attempts, skipped steps and failures, and keeps N-1 when step N fails', async () => {
    const h = hooksFor();
    await h.onStepStart?.(step('s1'), 0);
    await h.onStepResult?.(step('s1'), 0, { status: 'completed', attempts: 3 });
    await h.onStepStart?.(step('s2'), 1);
    await h.onStepResult?.(step('s2'), 1, { status: 'skipped' });
    await h.onStepStart?.(step('s3'), 2);
    await h.onStepResult?.(step('s3'), 2, {
      status: 'failed',
      error: 'Recipient address "x" is not valid',
      errorDetails: { status: 400 },
      attempts: 1,
    });

    const rows = (await stepRows()).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(rows[0].logs?.[1].message).toMatch(/\(attempt 3\)$/);
    expect(rows[1].logs?.[1].message).toBe('Skipped: condition not met');
    expect(rows[2].logs?.[1]).toMatchObject({
      level: 'error',
      message: 'Failed: Recipient address "x" is not valid',
    });
    expect(rows[2].error).toEqual({ message: 'Recipient address "x" is not valid', details: { status: 400 } });
    // s1 and s2 finished, s3 failed and halted the run.
    expect((await execRow()).currentStepIndex).toBe(2);
  });

  it('counts a failed step the run continued past as finished', async () => {
    const h = hooksFor();
    await h.onStepStart?.(step('s1'), 0);
    await h.onStepResult?.(step('s1'), 0, { status: 'failed', error: 'meh', continued: true, attempts: 1 });
    const [row] = await stepRows();
    expect(row.logs?.[1].message).toBe('Failed: meh (workflow continued)');
    expect((await execRow()).currentStepIndex).toBe(1);
  });

  it('does not count a step that is waiting for input until it is marked finished', async () => {
    const h = hooksFor();
    await h.onStepStart?.(step('s1', 'collect_input'), 0);
    await h.onStepResult?.(step('s1', 'collect_input'), 0, { status: 'waiting_for_input', attempts: 1 });
    expect((await execRow()).currentStepIndex).toBe(0);
    await h.markFinished(0);
    expect((await execRow()).currentStepIndex).toBe(1);
  });

  it('writes one error log per failed step, a warning when the run continued', async () => {
    const h = hooksFor();
    await h.onStepStart?.(step('s1'), 0);
    await h.onStepResult?.(step('s1'), 0, {
      status: 'failed',
      error: 'mailbox full',
      errorType: 'NonRetryableStepError',
      errorDetails: { status: 552 },
      continued: true,
      attempts: 1,
    });
    await h.onStepStart?.(step('s2', 'http_request'), 1);
    await h.onStepResult?.(step('s2', 'http_request'), 1, { status: 'failed', error: 'timeout', attempts: 3 });

    const rows = (await errorRows()).sort((a, b) => (a.stepId ?? '').localeCompare(b.stepId ?? ''));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workflowId: 'wf_persist',
      stepId: 's1',
      stepType: 'send_email',
      errorMessage: 'mailbox full',
      errorType: 'NonRetryableStepError',
      severity: 'warning',
      input: { details: { status: 552 } },
    });
    expect(rows[1]).toMatchObject({ stepId: 's2', stepType: 'http_request', severity: 'error', errorMessage: 'timeout' });
  });

  it('is replay-safe: a second invocation reuses the step rows and writes nothing twice', async () => {
    const first = hooksFor();
    await first.onStepStart?.(step('s1'), 0);
    await first.onStepResult?.(step('s1'), 0, { status: 'completed', attempts: 1 });
    await first.onStepStart?.(step('s2'), 1);
    await first.onStepResult?.(step('s2'), 1, { status: 'failed', error: 'meh', continued: true, attempts: 1 });
    // s3 started, then the workflow slept (a delay or a retry backoff).
    await first.onStepStart?.(step('s3'), 2);

    // Cloudflare replays run(): fresh hooks, same steps again.
    const rtEvents: string[] = [];
    const replay = buildExecutionHooks({
      db,
      rt: { workflowExecutionEvent: (_w, _e, event) => void rtEvents.push(event) },
      workspaceId: 'ws_1',
      executionId,
      totalSteps: 3,
      workflowId: 'wf_persist',
    });
    await replay.onStepStart?.(step('s1'), 0);
    await replay.onStepResult?.(step('s1'), 0, { status: 'completed', attempts: 1 });
    await replay.onStepStart?.(step('s2'), 1);
    await replay.onStepResult?.(step('s2'), 1, { status: 'failed', error: 'meh', continued: true, attempts: 1 });
    await replay.onStepStart?.(step('s3'), 2);
    await replay.onStepResult?.(step('s3'), 2, { status: 'completed', attempts: 1 });

    const rows = (await stepRows()).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'failed', 'completed']);
    expect(await errorRows()).toHaveLength(1);
    // Only s3 (still running when the replay reached it) produced events.
    expect(rtEvents).toEqual(['step_completed']);
    expect((await execRow()).currentStepIndex).toBe(3);
  });

  it('completes the waiting step row when its input arrives', async () => {
    const h = hooksFor();
    await h.onStepStart?.(step('s1', 'collect_input'), 0);
    await h.onStepResult?.(step('s1', 'collect_input'), 0, { status: 'waiting_for_input', attempts: 1 });
    await h.markFinished(0);
    const [row] = await stepRows();
    expect(row.status).toBe('completed');
    expect(row.completedAt).toBeInstanceOf(Date);
  });
});
