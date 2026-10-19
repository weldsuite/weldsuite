/**
 * What the audit consumer does with each failure: an event whose tenant
 * database is locked by a database move is retried later instead of being
 * dropped; every other failure keeps its old behaviour (retry, drop after 3
 * retries).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import type { Env } from '../env';
import type { EntityEventMessage } from '../lib/entity-events';

vi.mock('./event-processor', () => ({ processEntityEvent: vi.fn() }));

import {
  LOCKED_RETRY_DELAY_SECONDS,
  OTHER_MAX_RETRIES,
  processAuditBatch,
} from './batch-processor';

const env = {} as Env;

interface FakeMessage {
  body: EntityEventMessage;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function message(id: string, attempts = 1): FakeMessage {
  return {
    body: {
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

function batchOf(...messages: FakeMessage[]): MessageBatch<EntityEventMessage> {
  return { messages, queue: 'audit-events', ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<EntityEventMessage>;
}

/** A Drizzle-style failure: the wrapper carries the SQL and its parameters, the cause is the driver error. */
function drizzleFailure(cause: unknown): Error {
  return Object.assign(new Error('Failed query: insert into "audit_logs" (...) values ($1) params: row-contents-must-not-be-logged'), {
    name: 'DrizzleQueryError',
    cause,
  });
}

let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
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
  ])('retries %s after the delay instead of dropping the event', async (_name, failure) => {
    const m = message('evt_locked', 2);

    await processAuditBatch(batchOf(m), env, async () => {
      throw failure;
    });

    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: LOCKED_RETRY_DELAY_SECONDS });
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('keeps retrying a locked event however many attempts it has had (the consumer max_retries ends it)', async () => {
    const m = message('evt_locked', 9);

    await processAuditBatch(batchOf(m), env, async () => {
      throw Object.assign(new Error('boom'), { code: '28P01' });
    });

    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
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

  it(`drops any other failure after ${OTHER_MAX_RETRIES} retries, so a raised max_retries does not multiply them`, async () => {
    const lastRetry = message('evt_last', OTHER_MAX_RETRIES);
    const exhausted = message('evt_exhausted', OTHER_MAX_RETRIES + 1);

    await processAuditBatch(batchOf(lastRetry, exhausted), env, async () => {
      throw new Error('Workspace not found for org: org_gone');
    });

    expect(lastRetry.retry).toHaveBeenCalledTimes(1);
    expect(lastRetry.ack).not.toHaveBeenCalled();
    expect(exhausted.ack).toHaveBeenCalledTimes(1);
    expect(exhausted.retry).not.toHaveBeenCalled();
  });

  it('treats every message of a batch on its own', async () => {
    const written = message('evt_a');
    const locked = message('evt_b');
    const broken = message('evt_c');
    const outcome: Record<string, Error | null> = {
      evt_a: null,
      evt_b: Object.assign(new Error('x'), { code: '25006' }),
      evt_c: new Error('something else'),
    };

    await processAuditBatch(batchOf(written, locked, broken), env, async (event) => {
      const failure = outcome[event.id];
      if (failure) throw failure;
    });

    expect(written.ack).toHaveBeenCalledTimes(1);
    expect(locked.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
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
