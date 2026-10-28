/**
 * `drainOutbox` (design §3.6 step 3, task C1): batched `ledger.mail` delivery
 * to `MailIndex`, per-row `entity_event` delivery to the hub queue, retry
 * with backoff on a `MailIndex` failure, the "row stays after max attempts"
 * behaviour, and dropping a row of an unrecognised kind.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { migrateMailbox } from './migrate';
import { drainOutbox, type OutboxEnv } from './outbox';
import type { MailIndex } from '../mail-index/mail-index';
import type { MailboxRef } from '../store/types';

function fakeMailIndexNamespace(recordMailAddresses: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => ({ applied: 0, skipped: 0 }))) {
  const stub = { recordMailAddresses };
  const ns = {
    idFromName: (name: string) => ({ toString: () => name, equals: (other: unknown) => String(other) === name }),
    get: () => stub,
    jurisdiction() {
      return this;
    },
  };
  return { ns: ns as unknown as DurableObjectNamespace<MailIndex>, stub };
}

function makeEntityEventsQueue(send: (message: unknown) => Promise<unknown> = vi.fn(async () => undefined)) {
  return { send } as unknown as Queue<unknown>;
}

const REF: Pick<MailboxRef, 'workspaceId' | 'clerkOrgId'> = { workspaceId: 'ws_1', clerkOrgId: 'org_1' };

function insertOutboxRow(
  sql: SqlStorage,
  kind: string,
  payload: unknown,
  opts: { attempts?: number; nextAttemptAt?: number; createdAt?: number } = {},
): void {
  sql.exec(
    'INSERT INTO outbox (kind, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)',
    kind,
    JSON.stringify(payload),
    opts.attempts ?? 0,
    opts.nextAttemptAt ?? 0,
    opts.createdAt ?? 0,
  );
}

function makeMailbox() {
  const { storage } = createSqliteDurableObjectState();
  migrateMailbox(storage);
  return storage;
}

describe('drainOutbox: ledger.mail', () => {
  it('delivers every due row as one batched recordMailAddresses call and removes them', async () => {
    const storage = makeMailbox();
    const { ns, stub } = fakeMailIndexNamespace();
    insertOutboxRow(storage.sql, 'ledger.mail', { messageId: 'm1', accountId: 'acc_1', at: 1000, addresses: ['a@x.com'] });
    insertOutboxRow(storage.sql, 'ledger.mail', { messageId: 'm2', accountId: 'acc_1', at: 1000, addresses: ['b@x.com'] });

    const env: OutboxEnv = { MAIL_INDEX: ns };
    const result = await drainOutbox(storage.sql, env, REF, 5000);

    expect(result).toEqual({ delivered: 2, failed: 0, remaining: 0 });
    expect(stub.recordMailAddresses).toHaveBeenCalledTimes(1);
    expect(stub.recordMailAddresses).toHaveBeenCalledWith('ws_1', [
      { messageId: 'm1', accountId: 'acc_1', at: 1000, addresses: ['a@x.com'] },
      { messageId: 'm2', accountId: 'acc_1', at: 1000, addresses: ['b@x.com'] },
    ]);
    expect(storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').toArray()[0]).toEqual({ n: 0 });
  });

  it('backs off every row in the batch on a MailIndex failure, keeping them for the next drain', async () => {
    const storage = makeMailbox();
    const { ns } = fakeMailIndexNamespace(vi.fn(async () => {
      throw new Error('ledger down');
    }));
    insertOutboxRow(storage.sql, 'ledger.mail', { messageId: 'm1', accountId: 'acc_1', at: 1000, addresses: [] });

    const env: OutboxEnv = { MAIL_INDEX: ns };
    const result = await drainOutbox(storage.sql, env, REF, 5000);

    expect(result).toEqual({ delivered: 0, failed: 1, remaining: 1 });
    const row = storage.sql.exec<{ attempts: number; next_attempt_at: number; last_error: string | null }>('SELECT attempts, next_attempt_at, last_error FROM outbox').toArray()[0]!;
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBe(5000 + 10_000); // backoffMs(1) = 5s * 2^1
    expect(row.last_error).toContain('ledger down');
  });

  it('defers rows (does not drop them) when no MAIL_INDEX binding is configured', async () => {
    const storage = makeMailbox();
    insertOutboxRow(storage.sql, 'ledger.mail', { messageId: 'm1', accountId: 'acc_1', at: 1000, addresses: [] });

    const result = await drainOutbox(storage.sql, {}, REF, 5000);

    expect(result).toEqual({ delivered: 0, failed: 1, remaining: 1 });
  });

  it('a row that keeps failing stays in the table (never dropped) once it passes the max-attempts ceiling', async () => {
    const storage = makeMailbox();
    const { ns } = fakeMailIndexNamespace(vi.fn(async () => {
      throw new Error('still down');
    }));
    insertOutboxRow(storage.sql, 'ledger.mail', { messageId: 'm1', accountId: 'acc_1', at: 1000, addresses: [] }, { attempts: 19 });

    const env: OutboxEnv = { MAIL_INDEX: ns };
    const result = await drainOutbox(storage.sql, env, REF, 5000);

    expect(result).toEqual({ delivered: 0, failed: 1, remaining: 1 });
    const row = storage.sql.exec<{ attempts: number }>('SELECT attempts FROM outbox').toArray()[0]!;
    expect(row.attempts).toBe(20);
  });
});

describe('drainOutbox: entity_event', () => {
  it('publishes one hub event per row and removes delivered rows', async () => {
    const storage = makeMailbox();
    const send = vi.fn(async (_message: unknown) => undefined);
    insertOutboxRow(storage.sql, 'entity_event', {
      entityType: 'email',
      action: 'created',
      entityId: 'm1',
      data: { id: 'm1', subject: 'Hi' },
    });

    const env: OutboxEnv = { ENTITY_EVENTS: makeEntityEventsQueue(send) };
    const result = await drainOutbox(storage.sql, env, REF, 5000);

    expect(result).toEqual({ delivered: 1, failed: 0, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { eventType: string; entityId: string; data: unknown; metadata: { workspaceId: string; userId: string } };
    expect(sent.eventType).toBe('email:created');
    expect(sent.entityId).toBe('m1');
    expect(sent.data).toEqual({ id: 'm1', subject: 'Hi' });
    // `clerkOrgId` is preferred over `workspaceId` for the wire `workspaceId` field (see outbox.ts's comment).
    expect(sent.metadata.workspaceId).toBe('org_1');
    expect(sent.metadata.userId).toBe('system');
  });

  it('retries a row whose stored payload is not valid JSON instead of losing it', async () => {
    const storage = makeMailbox();
    storage.sql.exec(
      'INSERT INTO outbox (kind, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, 0, 0, 0)',
      'entity_event',
      '{not json',
    );

    const result = await drainOutbox(storage.sql, {}, REF, 5000);

    expect(result).toEqual({ delivered: 0, failed: 1, remaining: 1 });
    const row = storage.sql.exec<{ attempts: number }>('SELECT attempts FROM outbox').toArray()[0]!;
    expect(row.attempts).toBe(1);
  });

  it('a send failure does not retry the row: publishEntityEventRaw swallows ENTITY_EVENTS errors itself', async () => {
    const storage = makeMailbox();
    const send = vi.fn(async () => {
      throw new Error('queue unavailable');
    });
    insertOutboxRow(storage.sql, 'entity_event', { entityType: 'email', action: 'created', entityId: 'm1', data: {} });

    const env: OutboxEnv = { ENTITY_EVENTS: makeEntityEventsQueue(send) };
    const result = await drainOutbox(storage.sql, env, REF, 5000);

    // Delivery "succeeds" from this object's point of view: Cloudflare Queues'
    // own retry/DLQ on the hub queue is what actually handles a failed send.
    expect(result).toEqual({ delivered: 1, failed: 0, remaining: 0 });
  });
});

describe('drainOutbox: unrecognised kinds', () => {
  it('drops a row of a kind no handler recognises, rather than retrying it forever', async () => {
    const storage = makeMailbox();
    insertOutboxRow(storage.sql, 'mystery', { whatever: true });

    const result = await drainOutbox(storage.sql, {}, REF, 5000);

    expect(result).toEqual({ delivered: 0, failed: 0, remaining: 0 });
  });
});

describe('drainOutbox: batching', () => {
  it('only drains rows due at or before `now`, leaving backed-off rows alone', async () => {
    const storage = makeMailbox();
    insertOutboxRow(storage.sql, 'mystery', {}, { nextAttemptAt: 10_000 });

    const result = await drainOutbox(storage.sql, {}, REF, 5000);

    expect(result).toEqual({ delivered: 0, failed: 0, remaining: 1 });
  });
});
