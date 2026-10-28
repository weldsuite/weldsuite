/**
 * The alarm (design §3.6, task C1): `recomputeAlarm`'s "only ever move
 * earlier, clear when nothing is pending" rule, `afterWrite`'s outbox
 * batching and `folder.read` continuation registration, and `runAlarm`'s
 * full-tick multiplexing — destroy exclusivity, snooze wake gated by the
 * stored mode, the outbox drain, and a continuation step — against the
 * `createSqliteDurableObjectState`/`createMemoryR2` fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqliteDurableObjectState, fireAlarm } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { migrateMailbox } from './migrate';
import { applyMailboxOp, type WritableStorage } from './writes';
import {
  afterWrite,
  getStoredMode,
  OUTBOX_BATCH_DELAY_MS,
  recomputeAlarm,
  registerContinuation,
  runAlarm,
  setStoredMode,
} from './alarm';
import { beginDestroy, getDestroyState } from './destroy';
import type { IngestMessage, MailboxRef } from '../store/types';
import type { MailIndex } from '../mail-index/mail-index';
import type { AlarmEnv } from './alarm';

const REF: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1', clerkOrgId: 'org_1' };

function makeMailbox() {
  const state = createSqliteDurableObjectState();
  migrateMailbox(state.storage);
  return state;
}

function storageOf(state: ReturnType<typeof makeMailbox>): WritableStorage {
  return state.storage;
}

let seq = 0;
function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  seq += 1;
  return {
    id: `msg_${seq}`,
    source: 'inbound',
    rfcMessageId: `rfc-${seq}@example.com`,
    threadId: null,
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'bob@example.com', name: 'Bob' }],
    subject: 'Hello',
    preview: 'Hi there',
    sentAt: 1_000,
    receivedAt: 1_000,
    createdAt: 1_000,
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
    ...overrides,
  };
}

function fakeMailIndexNamespace(overrides: {
  recordMailAddresses?: (...args: unknown[]) => Promise<unknown>;
  dropMailbox?: (...args: unknown[]) => Promise<unknown>;
} = {}) {
  const stub = {
    recordMailAddresses: overrides.recordMailAddresses ?? vi.fn(async () => ({ applied: 0, skipped: 0 })),
    dropMailbox: overrides.dropMailbox ?? vi.fn(async () => undefined),
  };
  const ns = {
    idFromName: (name: string) => ({ toString: () => name, equals: (other: unknown) => String(other) === name }),
    get: () => stub,
    jurisdiction() {
      return this;
    },
  };
  return { ns: ns as unknown as DurableObjectNamespace<MailIndex>, stub };
}

function makeEnv(overrides: Partial<AlarmEnv> = {}): AlarmEnv {
  // DbEnv fields (task C4's `BackfillEnv`) are required on the real env type
  // but unused by any test in this file (none of them exercise backfill) —
  // dummy values, same convention as `mail-index/mail-index.test.ts`'s own
  // `testEnv`.
  return {
    DATABASE_URL_MASTER: 'postgres://unused',
    WORKSPACE_CACHE: {} as KVNamespace,
    NEON_API_KEY: 'unused',
    ...overrides,
  };
}

describe('recomputeAlarm', () => {
  it('sets the alarm to the earliest candidate when none is scheduled yet', async () => {
    const state = makeMailbox();
    const storage = storageOf(state);
    applyMailboxOp(storage, REF, { kind: 'ingest', message: makeIngest() }, 1_000);

    await recomputeAlarm(state, 1_000);

    expect(await state.storage.getAlarm()).toBe(1_000 + OUTBOX_BATCH_DELAY_MS);
  });

  it('never moves an existing alarm later, only earlier', async () => {
    const state = makeMailbox();
    await state.storage.setAlarm(500);

    // A fresh outbox row alone would compute 2_000 + delay (> 500): must not override the sooner existing alarm.
    const storage = storageOf(state);
    applyMailboxOp(storage, REF, { kind: 'ingest', message: makeIngest() }, 2_000);
    await recomputeAlarm(state, 2_000);
    expect(await state.storage.getAlarm()).toBe(500);

    // A continuation makes "now" (100) an earlier candidate: must win.
    registerContinuation(state.storage.sql, { kind: 'folder.read', scope: { labelSlug: 'inbox' } });
    await recomputeAlarm(state, 100);
    expect(await state.storage.getAlarm()).toBe(100);
  });

  it('clears the alarm when nothing is pending', async () => {
    const state = makeMailbox();
    await state.storage.setAlarm(1_000);
    await recomputeAlarm(state, 500);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

describe('afterWrite', () => {
  it('batches a fresh outbox row by OUTBOX_BATCH_DELAY_MS from its own creation time', async () => {
    const state = makeMailbox();
    const storage = storageOf(state);
    const result = applyMailboxOp(storage, REF, { kind: 'ingest', message: makeIngest() }, 10_000);

    await afterWrite(state, { kind: 'ingest', message: makeIngest() }, result);

    expect(await state.storage.getAlarm()).toBe(10_000 + OUTBOX_BATCH_DELAY_MS);
  });

  it('registers a folder.read continuation and schedules the alarm immediately when `more` comes back true', async () => {
    const state = makeMailbox();
    const op = { kind: 'folder.read' as const, scope: { labelSlug: 'inbox' } };

    await afterWrite(state, op, { more: true });

    const stored = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'continuation'").toArray()[0];
    expect(stored && JSON.parse(stored.value)).toMatchObject({ kind: 'folder.read', op, attempts: 0 });
    expect(await state.storage.getAlarm()).not.toBeNull();
  });

  it('does not register a continuation when `more` is false or absent', async () => {
    const state = makeMailbox();
    await afterWrite(state, { kind: 'folder.read', scope: { labelSlug: 'inbox' } }, { more: false });
    expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'continuation'").toArray()).toEqual([]);
  });
});

describe('runAlarm: outbox drain', () => {
  it('drains ledger.mail and entity_event rows produced by an earlier ingest', async () => {
    const state = makeMailbox();
    const storage = storageOf(state);
    applyMailboxOp(storage, REF, { kind: 'ingest', message: makeIngest() }, 1_000);
    expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').toArray()[0]).toEqual({ n: 2 });

    const { ns } = fakeMailIndexNamespace();
    const send = vi.fn(async () => undefined);
    await runAlarm(state, makeEnv({ MAIL_INDEX: ns, ENTITY_EVENTS: { send } as unknown as Queue<unknown> }), REF);

    expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').toArray()[0]).toEqual({ n: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('runAlarm: snooze wake', () => {
  function snoozeOneMessage(state: ReturnType<typeof makeMailbox>, until: number): string {
    const storage = storageOf(state);
    const message = makeIngest();
    applyMailboxOp(storage, REF, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, REF, { kind: 'snooze', id: message.id, until }, 1_000);
    return message.id;
  }

  it('does nothing while the stored mode is not object-only', async () => {
    const state = makeMailbox();
    const id = snoozeOneMessage(state, 5_000);
    expect(getStoredMode(state.storage.sql)).toBe('postgres'); // default

    await runAlarm(state, makeEnv(), REF);

    const row = state.storage.sql.exec<{ snoozed_until: number | null }>('SELECT snoozed_until FROM messages WHERE id = ?', id).toArray()[0]!;
    expect(row.snoozed_until).toBe(5_000); // untouched
  });

  it('wakes a due snoozed message once the mode is object-only', async () => {
    const state = makeMailbox();
    const id = snoozeOneMessage(state, 5_000);
    setStoredMode(state.storage.sql, 'object-only');

    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      await runAlarm(state, makeEnv(), REF);
    } finally {
      vi.useRealTimers();
    }

    const row = state.storage.sql.exec<{ snoozed_until: number | null }>('SELECT snoozed_until FROM messages WHERE id = ?', id).toArray()[0]!;
    expect(row.snoozed_until).toBeNull();
  });
});

describe('runAlarm: continuation', () => {
  it('re-applies a pending folder.read continuation and clears it once no `more` work remains', async () => {
    const state = makeMailbox();
    const storage = storageOf(state);
    const a = makeIngest({ isRead: false });
    const b = makeIngest({ isRead: false });
    applyMailboxOp(storage, REF, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, REF, { kind: 'ingest', message: b }, 1_000);
    registerContinuation(state.storage.sql, { kind: 'folder.read', scope: { labelSlug: 'inbox' } });

    await runAlarm(state, makeEnv(), REF);

    expect(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'continuation'").toArray()).toEqual([]);
    const rows = state.storage.sql.exec<{ is_read: number }>('SELECT is_read FROM messages ORDER BY id').toArray();
    expect(rows.every((r) => r.is_read === 1)).toBe(true);
  });
});

describe('runAlarm: destroy is exclusive', () => {
  it('skips the outbox drain and any continuation while a destroy is in progress', async () => {
    const state = makeMailbox();
    const storage = storageOf(state);
    applyMailboxOp(storage, REF, { kind: 'ingest', message: makeIngest() }, 1_000);
    registerContinuation(state.storage.sql, { kind: 'folder.read', scope: { labelSlug: 'inbox' } });
    beginDestroy(state.storage, 1_000);

    // No MAIL_STORAGE bound, so the r2 stage logs an error and retries rather
    // than advancing — exactly what we want here: it proves this tick did
    // destroy work (attempted the r2 stage) and nothing else.
    await runAlarm(state, makeEnv(), REF);

    expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').toArray()[0]).toEqual({ n: 2 }); // undrained
    const continuation = state.storage.sql.exec("SELECT value FROM meta WHERE key = 'continuation'").toArray();
    expect(continuation).toHaveLength(1); // untouched
    expect(getDestroyState(state.storage.sql)?.stage).toBe('r2'); // still stuck on r2 (no binding)
  });

  it('wipes the object once destroy completes, across three alarm ticks', async () => {
    const state = makeMailbox();
    beginDestroy(state.storage, 1_000);
    const dropMailbox = vi.fn(async () => undefined);
    const { ns } = fakeMailIndexNamespace({ dropMailbox });
    const bucket = createMemoryR2();

    await state.storage.setAlarm(1_000);
    await fireAlarm(state, { alarm: () => runAlarm(state, makeEnv({ MAIL_INDEX: ns, MAIL_STORAGE: bucket }), REF) }); // r2
    await state.storage.setAlarm(1_000);
    await fireAlarm(state, { alarm: () => runAlarm(state, makeEnv({ MAIL_INDEX: ns, MAIL_STORAGE: bucket }), REF) }); // ledger
    expect(dropMailbox).toHaveBeenCalledTimes(1);
    await state.storage.setAlarm(1_000);
    await fireAlarm(state, { alarm: () => runAlarm(state, makeEnv({ MAIL_INDEX: ns, MAIL_STORAGE: bucket }), REF) }); // done -> wipe

    expect(await state.storage.getAlarm()).toBeNull();
    expect(() => state.storage.sql.exec('SELECT * FROM meta').toArray()).toThrow();
  });
});
