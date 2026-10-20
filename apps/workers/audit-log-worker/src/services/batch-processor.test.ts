/**
 * What the audit consumer does with each failure: an event whose tenant
 * database is locked by a database move is sent back onto the queue with a
 * growing delay, without using up the consumer's max_retries; every other
 * failure is retried at once and ends in the dead-letter queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import type { Env } from '../env';
import type { EntityEventMessage } from '../lib/entity-events';

vi.mock('./event-processor', () => ({ processEntityEvent: vi.fn() }));

import {
  LOCKED_MAX_RETRIES,
  lockedRetryDelaySeconds,
  processAuditBatch,
  type AuditQueueMessage,
} from './batch-processor';

const send = vi.fn();
const env = { AUDIT_EVENTS: { send } } as unknown as Env;

interface FakeMessage {
  body: AuditQueueMessage;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function message(id: string, attempts = 1, auditLockRetries?: number): FakeMessage {
  return {
    body: {
      ...(auditLockRetries === undefined ? {} : { auditLockRetries }),
      id,
      eventType: 'customer:created',
      entityType: 'customer',
      entityId: 'cus_1',
      action: 'created',
      data: { id: 'cus_1', secretField: 'row-contents-must-not-be-logged' },
      metadata: { workspaceId: 'org_1', userId: 'usr_1', timestamp: '2026-10-19T12:00:00.000Z', source: 'system' },
    } as EntityEventMessage,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batchOf(...messages: FakeMessage[]): MessageBatch<AuditQueueMessage> {
  return { messages, queue: 'audit-events', ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<AuditQueueMessage>;
}

const locked = () => Object.assign(new Error('boom'), { code: '28P01' });

/** A Drizzle-style failure: the wrapper carries the SQL and its parameters, the cause is the driver error. */
function drizzleFailure(cause: unknown): Error {
  return Object.assign(new Error('Failed query: insert into "audit_logs" (...) values ($1) params: row-contents-must-not-be-logged'), {
    name: 'DrizzleQueryError',
    cause,
  });
}

let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  const output = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
  vi.restoreAllMocks();
  expect(output).not.toContain('row-contents-must-not-be-logged');
  expect(output).not.toContain('postgresql://');
});

describe('processAuditBatch', () => {
  it('acks an event that was written', async () => {
    const m = message('evt_ok');

    await processAuditBatch(batchOf(m), env, async () => {});

    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
  });

  it.each([
    ['a rotated password (28P01 code)', Object.assign(new Error('boom'), { code: '28P01' })],
    ['a rotated password (message only)', new Error('password authentication failed for user "tenant_x"')],
    ['a read-only database (25006 code)', Object.assign(new Error('boom'), { code: '25006' })],
    ['a read-only database (message only)', new Error('cannot execute INSERT in a read-only transaction')],
    ['a rotated password wrapped by Drizzle', drizzleFailure(Object.assign(new Error('boom'), { code: '28P01' }))],
    ['a read-only database wrapped by Drizzle', drizzleFailure(new Error('cannot execute INSERT in a read-only transaction'))],
  ])('re-queues %s with a delay instead of dropping the event', async (_name, failure) => {
    const m = message('evt_locked', 2);

    await processAuditBatch(batchOf(m), env, async () => {
      throw failure;
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt_locked', auditLockRetries: 1 }),
      { delaySeconds: lockedRetryDelaySeconds(1) },
    );
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('backs off: 1, 2, 4, 8 minutes, then 15 minutes, about four hours in all', () => {
    expect([1, 2, 3, 4, 5, 6].map(lockedRetryDelaySeconds)).toEqual([60, 120, 240, 480, 900, 900]);
    let total = 0;
    for (let retry = 1; retry <= LOCKED_MAX_RETRIES; retry++) total += lockedRetryDelaySeconds(retry);
    expect(total).toBeGreaterThan(3 * 60 * 60);
  });

  it('counts lock retries in the body, not in the consumer attempts', async () => {
    const m = message('evt_locked', 1, 4);

    await processAuditBatch(batchOf(m), env, async () => {
      throw locked();
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ auditLockRetries: 5 }), {
      delaySeconds: lockedRetryDelaySeconds(5),
    });
    expect(m.ack).toHaveBeenCalledTimes(1);
  });

  it('falls back to a normal retry once the lock budget is spent, so the event ends in the DLQ', async () => {
    const m = message('evt_locked', 1, LOCKED_MAX_RETRIES);

    await processAuditBatch(batchOf(m), env, async () => {
      throw locked();
    });

    expect(send).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledWith();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('retries the message itself when the re-queue fails', async () => {
    send.mockRejectedValueOnce(new Error('queue unavailable'));
    const m = message('evt_locked');

    await processAuditBatch(batchOf(m), env, async () => {
      throw locked();
    });

    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('retries any other failure at once, as before', async () => {
    const m = message('evt_other', 1);

    await processAuditBatch(batchOf(m), env, async () => {
      throw drizzleFailure(Object.assign(new Error('duplicate key'), { code: '23505' }));
    });

    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.retry).toHaveBeenCalledWith();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('never acks a failed event away: after max_retries the consumer moves it to the DLQ', async () => {
    const m = message('evt_late', 3, 4);

    await processAuditBatch(batchOf(m), env, async () => {
      throw new Error('Workspace not found for org: org_gone');
    });

    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('treats every message of a batch on its own', async () => {
    const written = message('evt_a');
    const lockedEvent = message('evt_b');
    const broken = message('evt_c');
    const outcome: Record<string, Error | null> = {
      evt_a: null,
      evt_b: Object.assign(new Error('x'), { code: '25006' }),
      evt_c: new Error('something else'),
    };

    await processAuditBatch(batchOf(written, lockedEvent, broken), env, async (event) => {
      const failure = outcome[event.id];
      if (failure) throw failure;
    });

    expect(written.ack).toHaveBeenCalledTimes(1);
    expect(lockedEvent.ack).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(broken.retry).toHaveBeenCalledWith();
  });

  it('logs the event id and the kind of failure, never the driver message', async () => {
    const m = message('evt_log');

    await processAuditBatch(batchOf(m), env, async () => {
      throw drizzleFailure(new Error('cannot execute INSERT in a read-only transaction'));
    });
    await processAuditBatch(batchOf(message('evt_log2')), env, async () => {
      throw drizzleFailure(Object.assign(new Error('duplicate key'), { code: '23505' }));
    });

    const logged = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
    expect(logged).toContain('evt_log');
    expect(logged).toContain('DrizzleQueryError');
  });
});
