/**
 * The outbound mail guard in the EXECUTE_SEQUENCE workflow
 * (@weldsuite/crm-domain/workflows/execute-sequence): a sequence's send_email
 * step runs behind `guardedSend`. A limit that clears by itself paces the run
 * (it sleeps until `retryAfter` and sends again), anything else stops the
 * enrollment with the reason `sending_limited`.
 *
 * The guard itself (Durable Object ledger, KV, master DB) is stubbed at the
 * module boundary; these tests are about what the workflow does with its
 * answer. The workflow runs for real against a pglite tenant database with a
 * fake durable `step`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { OutboundDeniedError, guardedSend } from '@weldsuite/mail-domain/outbound';
import {
  ExecuteSequenceWorkflow,
  SEND_DEFER_BUDGET_MS,
  planSendDeferral,
  type ExecuteSequenceEnv,
  type ExecuteSequenceParams,
} from '@weldsuite/crm-domain/workflows/execute-sequence';

const held = vi.hoisted(() => ({ db: null as unknown }));

// The workflow resolves its tenant DB through the kit; hand it the pglite one.
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: vi.fn(async () => held.db),
}));

// Keep the real `OutboundDeniedError` (the workflow tests for it), stub the send.
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>()),
  guardedSend: vi.fn(),
}));

// The Cloudflare `[[send_email]]` binding: one `send` per envelope recipient.
const sendBinding = vi.hoisted(() => ({ send: vi.fn(async () => undefined) }));

const guard = vi.mocked(guardedSend);
const ORG = 'org_send_guard';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  held.db = db;
  await db.insert(schema.mailAccounts).values({
    id: generateId('mac'),
    name: 'Sales',
    email: 'sales@acme.test',
    isDefault: true,
    status: 'active',
  });
}, 60_000);

beforeEach(() => {
  guard.mockReset();
  sendBinding.send.mockClear();
  // Allowed by default: run the send, like the real guard does.
  guard.mockImplementation(async (_env, _db, _input, send) => send());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A sequence with one send_email step, and an active enrollment in it. */
async function seed(): Promise<ExecuteSequenceParams> {
  const now = new Date();
  const sequenceId = generateId('wf');
  await db.insert(schema.workflows).values({
    id: sequenceId,
    name: 'Send guard sequence',
    status: 'active',
    tags: ['__type:sequence'],
    steps: [
      {
        id: 'send1',
        name: 'Intro email',
        type: 'send_email',
        config: { to: 'prospect@example.org', subject: 'Hello', body: '<p>Hi there</p>' },
        inputs: {},
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
  const personId = generateId('person');
  await db.insert(schema.people).values({
    id: personId,
    displayName: 'Prospect',
    fullName: 'Prospect',
    email: 'prospect@example.org',
    createdAt: now,
    updatedAt: now,
  });
  const enrollmentId = generateId('senr');
  await db.insert(schema.sequenceEnrollments).values({
    id: enrollmentId,
    sequenceId,
    customerId: personId,
    counterpartyId: personId,
    status: 'active',
    executionId: enrollmentId,
    enrolledAt: now,
  });
  return { workspaceId: ORG, userId: 'user_1', sequenceId, enrollmentId, customerId: personId };
}

/** A durable-step stand-in: `do` runs the callback once, `sleep` is recorded (and may act). */
function fakeStep(onSleep?: (name: string, ms: number) => Promise<void>) {
  const names: string[] = [];
  const sleeps: Array<{ name: string; ms: number }> = [];
  const step = {
    do: async (name: string, ...rest: unknown[]) => {
      names.push(name);
      const callback = rest.find((arg) => typeof arg === 'function') as () => Promise<unknown>;
      return callback();
    },
    sleep: async (name: string, ms: number) => {
      sleeps.push({ name, ms });
      await onSleep?.(name, ms);
    },
    waitForEvent: async () => {
      throw new Error('timeout');
    },
  };
  return { step, names, sleeps };
}

async function runSequence(params: ExecuteSequenceParams, step: ReturnType<typeof fakeStep>['step']) {
  const env = { SEND_EMAIL: sendBinding, DATABASE_URL_MASTER: '' } as unknown as ExecuteSequenceEnv;
  const workflow = new ExecuteSequenceWorkflow({} as never, env as never);
  return workflow.run({ payload: params, timestamp: new Date(), instanceId: params.enrollmentId } as never, step as never);
}

const enrollmentOf = async (id: string) =>
  (await db.select().from(schema.sequenceEnrollments).where(eq(schema.sequenceEnrollments.id, id)))[0]!;
const stepRowsOf = async (enrollmentId: string) => {
  const [execution] = await db
    .select()
    .from(schema.workflowExecutions)
    .where(eq(schema.workflowExecutions.cfWorkflowInstanceId, enrollmentId));
  const steps = execution
    ? await db.select().from(schema.workflowExecutionSteps).where(eq(schema.workflowExecutionSteps.executionId, execution.id))
    : [];
  return { execution, steps };
};

const retryIn = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('send_email behind the outbound guard', () => {
  it('asks the guard as a crm_sequence new thread, then sends and completes', async () => {
    const params = await seed();
    const { step, sleeps } = fakeStep();

    const result = await runSequence(params, step);

    expect(result).toMatchObject({ success: true });
    expect(guard).toHaveBeenCalledTimes(1);
    const [, guardDb, input] = guard.mock.calls[0]!;
    expect(guardDb).toBe(db);
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: ORG },
      source: 'crm_sequence',
      kind: 'new_thread',
      from: 'sales@acme.test',
      to: ['prospect@example.org'],
      subjectLine: 'Hello',
    });
    expect(sendBinding.send).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect((await enrollmentOf(params.enrollmentId)).status).toBe('completed');
  });

  it('sleeps until retryAfter when a limit is full, then sends and completes', async () => {
    const params = await seed();
    guard.mockRejectedValueOnce(
      new OutboundDeniedError({ code: 'SENDING_LIMITED', window: 'hour', limit: 30, used: 30, retryAfter: retryIn(3_600_000) }),
    );
    const { step, sleeps } = fakeStep();

    const result = await runSequence(params, step);

    expect(result).toMatchObject({ success: true });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(sendBinding.send).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!.name).toBe('send-wait-0-1');
    expect(sleeps[0]!.ms).toBeGreaterThan(3_500_000);
    expect(sleeps[0]!.ms).toBeLessThanOrEqual(3_600_000);

    // One step row for the whole wait, finished once the send went out.
    const { steps } = await stepRowsOf(params.enrollmentId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'completed', retryCount: 1 });
    expect((await enrollmentOf(params.enrollmentId)).status).toBe('completed');
  });

  it('keeps waiting while the limit stays full, and every wait and retry has its own durable step name', async () => {
    const params = await seed();
    const full = () =>
      new OutboundDeniedError({ code: 'SENDING_LIMITED', window: 'hour', retryAfter: retryIn(3_600_000) });
    guard.mockRejectedValueOnce(full()).mockRejectedValueOnce(full());
    const { step, names, sleeps } = fakeStep();

    await runSequence(params, step);

    expect(sleeps.map((s) => s.name)).toEqual(['send-wait-0-1', 'send-wait-0-2']);
    expect(sendBinding.send).toHaveBeenCalledTimes(1);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('step-0-send1-send-2');
  });

  it.each([
    ['SENDING_ON_HOLD', { code: 'SENDING_ON_HOLD' as const }],
    ['SENDING_SUSPENDED', { code: 'SENDING_SUSPENDED' as const }],
    ['SENDER_NOT_OWNED', { code: 'SENDER_NOT_OWNED' as const, reason: 'address_registered_elsewhere' }],
    ['RECIPIENT_SUPPRESSED', { code: 'RECIPIENT_SUPPRESSED' as const, recipients: ['prospect@example.org'] }],
  ])('stops the enrollment with sending_limited on %s (no retryAfter), without sleeping or sending', async (code, details) => {
    const params = await seed();
    guard.mockRejectedValueOnce(new OutboundDeniedError(details));
    const { step, sleeps } = fakeStep();

    const result = await runSequence(params, step);

    expect(result).toMatchObject({ status: 'failed' });
    expect(sleeps).toEqual([]);
    expect(sendBinding.send).not.toHaveBeenCalled();

    const enrollment = await enrollmentOf(params.enrollmentId);
    expect(enrollment.status).toBe('failed');
    expect(enrollment.errorMessage).toContain('sending_limited:');
    expect(enrollment.errorMessage).toContain(`(${code})`);

    const { execution, steps } = await stepRowsOf(params.enrollmentId);
    expect(execution?.status).toBe('failed');
    expect(steps[0]).toMatchObject({ status: 'failed' });
    expect(steps[0]!.error).toMatchObject({ code });
  });

  it('stops instead of sleeping when the limit clears after the wait budget (a monthly cap)', async () => {
    const params = await seed();
    guard.mockRejectedValueOnce(
      new OutboundDeniedError({ code: 'SENDING_LIMITED', window: 'month', retryAfter: retryIn(SEND_DEFER_BUDGET_MS + 3_600_000) }),
    );
    const { step, sleeps } = fakeStep();

    const result = await runSequence(params, step);

    expect(result).toMatchObject({ status: 'failed' });
    expect(sleeps).toEqual([]);
    expect(guard).toHaveBeenCalledTimes(1);
    const enrollment = await enrollmentOf(params.enrollmentId);
    expect(enrollment.status).toBe('failed');
    expect(enrollment.errorMessage).toContain('sending_limited:');
  });

  it('does not send after the wait when the enrollment was unenrolled while it slept', async () => {
    const params = await seed();
    guard.mockRejectedValueOnce(
      new OutboundDeniedError({ code: 'SENDING_LIMITED', window: 'day', retryAfter: retryIn(7_200_000) }),
    );
    const { step, sleeps } = fakeStep(async () => {
      await db
        .update(schema.sequenceEnrollments)
        .set({ status: 'unenrolled' })
        .where(eq(schema.sequenceEnrollments.id, params.enrollmentId));
    });

    const result = await runSequence(params, step);

    expect(result).toMatchObject({ status: 'stopped' });
    expect(sleeps).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(sendBinding.send).not.toHaveBeenCalled();

    // The enrollment is left to whoever unenrolled it; the waiting step row is closed.
    expect((await enrollmentOf(params.enrollmentId)).status).toBe('unenrolled');
    const { execution, steps } = await stepRowsOf(params.enrollmentId);
    expect(execution?.status).toBe('cancelled');
    expect(steps[0]).toMatchObject({ status: 'cancelled' });
  });
});

describe('planSendDeferral', () => {
  const now = Date.parse('2026-10-13T10:00:00.000Z');
  const none = { attempts: 0, waitedMs: 0 };

  it('waits until retryAfter', () => {
    expect(planSendDeferral({ code: 'SENDING_LIMITED', retryAfter: '2026-10-13T11:00:00.000Z' }, now, none)).toBe(3_600_000);
  });

  it('never sleeps less than a few seconds (a retryAfter that is already past)', () => {
    const ms = planSendDeferral({ code: 'SENDING_LIMITED', retryAfter: '2026-10-13T09:59:59.000Z' }, now, none);
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('does not wait for denials only staff can lift, or an unreadable retryAfter', () => {
    expect(planSendDeferral({ code: 'SENDING_ON_HOLD' }, now, none)).toBeNull();
    expect(planSendDeferral({ code: 'SENDING_LIMITED', retryAfter: 'soon' }, now, none)).toBeNull();
  });

  it('keeps the total wait of a step inside the budget', () => {
    const details = { code: 'PLATFORM_LIMITED' as const, retryAfter: '2026-10-13T20:00:00.000Z' }; // +10h
    expect(planSendDeferral(details, now, { attempts: 1, waitedMs: 10 * 3_600_000 })).toBe(10 * 3_600_000);
    expect(planSendDeferral(details, now, { attempts: 2, waitedMs: 15 * 3_600_000 })).toBeNull();
  });

  it('stops after too many waits, however short', () => {
    const details = { code: 'SENDING_LIMITED' as const, retryAfter: '2026-10-13T10:01:00.000Z' };
    expect(planSendDeferral(details, now, { attempts: 29, waitedMs: 0 })).toBe(60_000);
    expect(planSendDeferral(details, now, { attempts: 30, waitedMs: 0 })).toBeNull();
  });
});
