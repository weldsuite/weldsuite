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

const tenantDbHandle = { handle: 'tenant-db' };
const openTenantDb = vi.fn(async (_workspaceId: string) => tenantDbHandle);

vi.mock('./event-processor', () => ({
  processEntityEvent: vi.fn(),
  createTenantDbResolver: () => openTenantDb,
}));
vi.mock('./stream-flusher', () => ({ flushStreamsForWorkspace: vi.fn() }));

import type { Database } from '../db';
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
  openTenantDb.mockClear();
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

  describe('audit log streams', () => {
    const inWorkspace = (id: string, workspaceId: string, attempts = 1): FakeMessage => {
      const m = message(id, attempts);
      m.body = { ...m.body, metadata: { ...m.body.metadata, workspaceId } };
      return m;
    };

    it('flushes once per workspace the batch wrote for, not once per event, on the handle the batch opened', async () => {
      const flush = vi.fn(async () => {});
      const batch = batchOf(inWorkspace('e1', 'org_a'), inWorkspace('e2', 'org_a'), inWorkspace('e3', 'org_b'), inWorkspace('e4', 'org_a'));

      await processAuditBatch(batch, env, async () => {}, flush);

      expect(flush).toHaveBeenCalledTimes(2);
      expect(flush.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(['org_a', 'org_b']);
      expect((flush.mock.calls[0] as unknown[])[0]).toBe(tenantDbHandle);
    });

    it('flushes after every message of the batch has been acked', async () => {
      const m1 = inWorkspace('e1', 'org_a');
      const m2 = inWorkspace('e2', 'org_a');
      const flush = vi.fn(async () => {
        expect(m1.ack).toHaveBeenCalledTimes(1);
        expect(m2.ack).toHaveBeenCalledTimes(1);
      });

      await processAuditBatch(batchOf(m1, m2), env, async () => {}, flush);

      expect(flush).toHaveBeenCalledTimes(1);
    });

    it('skips workspaces whose events all failed, and flushes the ones that were written', async () => {
      const flush = vi.fn(async () => {});
      const failing = inWorkspace('bad', 'org_bad');
      const fine = inWorkspace('good', 'org_good');

      await processAuditBatch(batchOf(failing, fine), env, async (event) => {
        if (event.id === 'bad') throw new Error('x');
      }, flush);

      expect(flush.mock.calls.map((c: unknown[]) => c[1])).toEqual(['org_good']);
    });

    it('does nothing for streams when no event carries a workspace', async () => {
      const flush = vi.fn(async () => {});
      const m = message('evt_x');
      m.body = { ...m.body, metadata: { ...m.body.metadata, workspaceId: '' } };

      await processAuditBatch(batchOf(m), env, async () => {}, flush);

      expect(flush).not.toHaveBeenCalled();
    });

    it('a throwing flush does not fail, retry or re-queue any message, and the other workspace still flushes', async () => {
      const m1 = inWorkspace('e1', 'org_a');
      const m2 = inWorkspace('e2', 'org_b');
      const flushed: string[] = [];
      const flush = vi.fn(async (_db: Database, workspaceId: string) => {
        if (workspaceId === 'org_a') throw Object.assign(new Error('connect to postgresql://user:pw@host failed'), { code: '28P01' });
        flushed.push(workspaceId);
      });

      await expect(processAuditBatch(batchOf(m1, m2), env, async () => {}, flush)).resolves.toBeUndefined();

      expect(m1.ack).toHaveBeenCalledTimes(1);
      expect(m2.ack).toHaveBeenCalledTimes(1);
      expect(m1.retry).not.toHaveBeenCalled();
      expect(m2.retry).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(flushed).toEqual(['org_b']);
    });

    it('hands the flushes to ctx.waitUntil and returns without waiting for them', async () => {
      const m = inWorkspace('e1', 'org_a');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let flushedAt = 0;
      const flush = vi.fn(async () => {
        // The settle wait of the real flusher.
        await gate;
        flushedAt = Date.now();
      });
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };

      await processAuditBatch(batchOf(m), env, async () => {}, flush, ctx);

      // Back already: the message is acked and the flush is still waiting.
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(waited).toHaveLength(1);
      expect(flushedAt).toBe(0);

      release();
      await waited[0];
      expect(flush).toHaveBeenCalledTimes(1);
      expect(flushedAt).toBeGreaterThan(0);
    });

    it('a flush that throws behind ctx.waitUntil does not reject the promise it was given', async () => {
      const m = inWorkspace('e1', 'org_a');
      const flush = vi.fn(async () => {
        throw new Error('connect to postgresql://user:pw@host failed');
      });
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };

      await processAuditBatch(batchOf(m), env, async () => {}, flush, ctx);

      await expect(waited[0]).resolves.toBeUndefined();
      expect(m.retry).not.toHaveBeenCalled();
    });

    it('without a ctx it waits for the flushes, after the acks', async () => {
      const m = inWorkspace('e1', 'org_a');
      let flushed = false;
      const flush = vi.fn(async () => {
        expect(m.ack).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        flushed = true;
      });

      await processAuditBatch(batchOf(m), env, async () => {}, flush);

      expect(flushed).toBe(true);
    });

    it('a tenant database that cannot be opened for the flush is only logged', async () => {
      const m = inWorkspace('e1', 'org_a');
      const flush = vi.fn(async () => {});
      openTenantDb.mockRejectedValueOnce(new Error('boom'));

      await processAuditBatch(batchOf(m), env, async () => {}, flush);

      expect(flush).not.toHaveBeenCalled();
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    });
  });
});
