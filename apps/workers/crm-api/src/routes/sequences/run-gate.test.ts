/**
 * The pause/unenroll gate of the EXECUTE_SEQUENCE workflow
 * (@weldsuite/crm-domain/workflows/execute-sequence): what a run does at a
 * step boundary when its sequence or enrollment was paused, unenrolled or
 * deleted while it slept in a delay.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  readRunGate,
  waitUntilRunnable,
  SEQUENCE_RESUME_EVENT,
  type GateStep,
  type RunGate,
} from '@weldsuite/crm-domain/workflows/execute-sequence';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seed(
  sequenceStatus: string,
  enrollmentStatus: string,
): Promise<{ sequenceId: string; enrollmentId: string }> {
  const now = new Date();
  const sequenceId = generateId('wf');
  await db.insert(schema.workflows).values({
    id: sequenceId,
    name: 'Gate test sequence',
    status: sequenceStatus,
    tags: ['__type:sequence'],
    steps: [],
    createdAt: now,
    updatedAt: now,
  });
  const personId = generateId('person');
  await db.insert(schema.people).values({
    id: personId,
    displayName: 'Gate Person',
    fullName: 'Gate Person',
    email: `${personId}@e2e.test`,
    createdAt: now,
    updatedAt: now,
  });
  const enrollmentId = generateId('senr');
  await db.insert(schema.sequenceEnrollments).values({
    id: enrollmentId,
    sequenceId,
    customerId: personId,
    counterpartyId: personId,
    status: enrollmentStatus,
    executionId: enrollmentId,
    enrolledAt: now,
  });
  return { sequenceId, enrollmentId };
}

describe('readRunGate', () => {
  it('lets a run continue while the sequence and the enrollment are both active', async () => {
    const ids = await seed('active', 'active');
    expect(await readRunGate(db, ids)).toEqual({ state: 'run' });
  });

  it('parks the run when the enrollment is paused', async () => {
    const ids = await seed('active', 'paused');
    expect(await readRunGate(db, ids)).toEqual({ state: 'paused' });
  });

  it('parks the run when the sequence is paused (the QA case: Pause during a delay)', async () => {
    const ids = await seed('paused', 'active');
    expect(await readRunGate(db, ids)).toEqual({ state: 'paused' });
  });

  it.each(['unenrolled', 'completed', 'failed', 'pending'])('stops the run when the enrollment is %s', async (status) => {
    const ids = await seed('active', status);
    expect(await readRunGate(db, ids)).toEqual({ state: 'stop', reason: `Enrollment status is ${status}` });
  });

  it('an unenroll wins over a paused sequence', async () => {
    const ids = await seed('paused', 'unenrolled');
    expect((await readRunGate(db, ids)).state).toBe('stop');
  });

  it.each(['draft', 'archived'])('stops the run when the sequence is %s', async (status) => {
    const ids = await seed(status, 'active');
    expect(await readRunGate(db, ids)).toEqual({ state: 'stop', reason: `Sequence status is ${status}` });
  });

  it('stops the run when the sequence was deleted or never existed', async () => {
    const ids = await seed('active', 'active');
    await db.update(schema.workflows).set({ deletedAt: new Date() }).where(eq(schema.workflows.id, ids.sequenceId));
    expect(await readRunGate(db, ids)).toEqual({ state: 'stop', reason: 'Sequence not found' });
    expect(await readRunGate(db, { sequenceId: 'wf_missing', enrollmentId: ids.enrollmentId })).toEqual({
      state: 'stop',
      reason: 'Sequence not found',
    });
  });

  it('stops the run when the enrollment row is gone', async () => {
    const ids = await seed('active', 'active');
    expect(await readRunGate(db, { sequenceId: ids.sequenceId, enrollmentId: 'senr_missing' })).toEqual({
      state: 'stop',
      reason: 'Enrollment not found',
    });
  });
});

describe('waitUntilRunnable', () => {
  /** A durable-step stand-in: do() runs the callback, waitForEvent() is scripted. */
  function fakeStep(waits: Array<'event' | 'timeout'> = []) {
    const names: string[] = [];
    const waitCalls: Array<{ name: string; options: { type: string; timeout: string } }> = [];
    const step: GateStep = {
      do: vi.fn(async (name: string, callback: () => Promise<RunGate>) => {
        names.push(name);
        return callback();
      }),
      waitForEvent: vi.fn(async (name: string, options: { type: string; timeout: string }) => {
        waitCalls.push({ name, options });
        const next = waits.shift() ?? 'timeout';
        if (next === 'timeout') throw new Error('timeout');
        return {};
      }),
    };
    return { step, names, waitCalls };
  }

  function scriptedGate(...states: RunGate[]) {
    const queue = [...states];
    return vi.fn(async () => queue.shift() ?? states.at(-1)!);
  }

  it('does not wait at all when the run may continue', async () => {
    const { step, waitCalls } = fakeStep();
    const gate = await waitUntilRunnable(step, scriptedGate({ state: 'run' }), 'step-1');
    expect(gate).toEqual({ state: 'run' });
    expect(waitCalls).toHaveLength(0);
  });

  it('parks on the resume event while paused and continues once it is resumed', async () => {
    const { step, names, waitCalls } = fakeStep(['event']);
    const read = scriptedGate({ state: 'paused' }, { state: 'run' });

    const gate = await waitUntilRunnable(step, read, 'step-1');

    expect(gate).toEqual({ state: 'run' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(waitCalls).toEqual([
      { name: 'paused-step-1-0', options: { type: SEQUENCE_RESUME_EVENT, timeout: '1 day' } },
    ]);
    // every durable step has its own name (a repeated name would replay the cached result)
    expect(new Set(names).size).toBe(names.length);
  });

  it('re-reads the database when the wait times out, and stays parked while still paused', async () => {
    const { step, waitCalls } = fakeStep(['timeout', 'timeout', 'event']);
    const read = scriptedGate({ state: 'paused' }, { state: 'paused' }, { state: 'paused' }, { state: 'run' });

    const gate = await waitUntilRunnable(step, read, 'finalize');

    expect(gate).toEqual({ state: 'run' });
    expect(waitCalls.map((call) => call.name)).toEqual([
      'paused-finalize-0',
      'paused-finalize-1',
      'paused-finalize-2',
    ]);
  });

  it('ends the run when the enrollment is unenrolled while it is parked', async () => {
    const { step } = fakeStep(['event']);
    const read = scriptedGate({ state: 'paused' }, { state: 'stop', reason: 'Enrollment status is unenrolled' });

    expect(await waitUntilRunnable(step, read, 'step-2')).toEqual({
      state: 'stop',
      reason: 'Enrollment status is unenrolled',
    });
  });

  it('gives up on a pause that never ends instead of re-checking forever', async () => {
    const { step, waitCalls } = fakeStep();
    const gate = await waitUntilRunnable(step, scriptedGate({ state: 'paused' }), 'step-1');
    expect(gate).toEqual({ state: 'stop', reason: 'Paused for too long' });
    expect(waitCalls.length).toBeGreaterThan(1);
    expect(waitCalls.length).toBeLessThan(1000);
  });
});
