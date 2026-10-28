/**
 * `MailboxStoreObject` (task C1): the RPC class wiring reads/writes to the
 * already-landed `reads.ts`/`writes.ts`, ref binding + mismatch rejection,
 * `status()`/`databaseSize` thresholds, and `destroy()`/`setMode()` acting
 * through the same `recomputeAlarm` every write goes through.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqliteDurableObjectState, fireAlarm } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { migrateMailbox } from './migrate';
import * as reads from './reads';
import { MailboxStoreObject, type MailboxStoreObjectEnv } from './mailbox-object';
import { MailboxDestroyedError } from './destroy';
import type { IngestMessage, MailboxRef } from '../store/types';

const REF: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1', clerkOrgId: 'org_1' };

function testEnv(overrides: Partial<MailboxStoreObjectEnv> = {}): MailboxStoreObjectEnv {
  return { ...overrides };
}

function makeObject(env: Partial<MailboxStoreObjectEnv> = {}) {
  const state = createSqliteDurableObjectState();
  const object = new MailboxStoreObject(state, testEnv(env));
  return { state, object };
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

describe('ref binding', () => {
  it('binds on the first call and rejects a mismatching ref afterwards', async () => {
    const { object } = makeObject();
    await object.status(REF);
    await expect(object.status({ workspaceId: 'ws_other', accountId: 'acc_1' })).rejects.toThrow(/bound to ws_1:acc_1/);
    await expect(object.status({ workspaceId: 'ws_1', accountId: 'acc_other' })).rejects.toThrow(/bound to ws_1:acc_1/);
  });

  it('accepts the same ref repeated, and picks up a later clerkOrgId', async () => {
    const { object } = makeObject();
    await object.status({ workspaceId: 'ws_1', accountId: 'acc_1' });
    await object.status(REF); // adds clerkOrgId
    const status = await object.status({ workspaceId: 'ws_1', accountId: 'acc_1' });
    expect(status.clerkOrgId).toBe('org_1');
  });
});

describe('reads: RPC round-trips equal calling reads.ts directly', () => {
  it('listThreads / getThread / getMessage / getMessages / listMessages / stats / unreadCount / labelCounts', async () => {
    const { state, object } = makeObject();
    const message = makeIngest();
    await object.apply(REF, { kind: 'ingest', message }, 1_000);

    const sql = state.storage.sql;
    expect(await object.listThreads(REF, { labelSlug: 'inbox', pageSize: 10 })).toEqual(
      reads.listThreads(sql, REF, { labelSlug: 'inbox', pageSize: 10 }),
    );
    expect(await object.getThread(REF, message.id)).toEqual(reads.getThread(sql, REF, message.id));
    expect(await object.getThreadOfMessage(REF, message.id)).toEqual(reads.getThreadOfMessage(sql, REF, message.id));
    expect(await object.getMessage(REF, message.id)).toEqual(reads.getMessage(sql, REF, message.id));
    expect(await object.getMessages(REF, [message.id])).toEqual(reads.getMessages(sql, REF, [message.id]));
    expect(await object.listMessages(REF, { limit: 10 })).toEqual(reads.listMessages(sql, REF, { limit: 10 }));
    expect(await object.stats(REF)).toEqual(reads.stats(sql));
    expect(await object.unreadCount(REF, 'inbox')).toEqual(reads.unreadCount(sql, 'inbox'));
    expect(await object.labelCounts(REF, ['inbox'])).toEqual(reads.labelCounts(sql, ['inbox']));
  });

  it('listAttachments / getAttachment / recentAttachments / recentAddresses', async () => {
    const { state, object } = makeObject();
    const message = makeIngest({ attachments: [{ id: 'att_1', fileName: 'a.pdf', size: 10, messageId: 'whatever' }] });
    await object.apply(REF, { kind: 'ingest', message }, 1_000);

    const sql = state.storage.sql;
    expect(await object.listAttachments(REF, message.id)).toEqual(reads.listAttachments(sql, message.id));
    expect(await object.getAttachment(REF, 'att_1')).toEqual(reads.getAttachment(sql, REF, 'att_1'));
    expect(await object.recentAttachments(REF, { limit: 10 })).toEqual(reads.recentAttachments(sql, { limit: 10 }));
    expect(await object.recentAddresses(REF, 10)).toEqual(reads.recentAddresses(sql, 10));
  });

  it('resolveInbound / findByRfcIds / findSentByIdempotencyKey / countSentSince', async () => {
    const { state, object } = makeObject();
    const message = makeIngest({ source: 'sent', idempotencyKey: 'idem-1' });
    await object.apply(REF, { kind: 'ingest', message }, 1_000);

    const sql = state.storage.sql;
    const inboundQuery = { rfcMessageId: 'rfc-x@example.com', subject: 'Hi', isReply: false };
    expect(await object.resolveInbound(REF, inboundQuery)).toEqual(reads.resolveInbound(sql, inboundQuery));
    expect(await object.findByRfcIds(REF, [message.rfcMessageId], [])).toEqual(reads.findByRfcIds(sql, [message.rfcMessageId], []));
    expect(await object.findSentByIdempotencyKey(REF, 'idem-1')).toEqual(reads.findSentByIdempotencyKey(sql, 'idem-1'));
    expect(await object.countSentSince(REF, 0)).toEqual(reads.countSentSince(sql, 0));
  });

  it('listScheduled / listSnoozed / listSubscriptions / getSubscription / rawSources / listDrafts / getDraft / exportPage', async () => {
    const { state, object } = makeObject();
    const message = makeIngest();
    await object.apply(REF, { kind: 'ingest', message }, 1_000);
    await object.apply(REF, { kind: 'draft.create', draft: { id: 'draft_1', accountId: REF.accountId } }, 1_000);

    const sql = state.storage.sql;
    expect(await object.listScheduled(REF)).toEqual(reads.listScheduled(sql, REF));
    expect(await object.listSnoozed(REF)).toEqual(reads.listSnoozed(sql, REF));
    expect(await object.listSubscriptions(REF, {})).toEqual(reads.listSubscriptions(sql, REF, {}));
    expect(await object.getSubscription(REF, 'sub_1')).toEqual(reads.getSubscription(sql, REF, 'sub_1'));
    expect(await object.rawSources(REF, { since: 0, limit: 10 })).toEqual(reads.rawSources(sql, { since: 0, limit: 10 }));
    expect(await object.listDrafts(REF, { limit: 10 })).toEqual(reads.listDrafts(sql, REF, { limit: 10 }));
    expect(await object.getDraft(REF, 'draft_1')).toEqual(reads.getDraft(sql, REF, 'draft_1'));
    expect(await object.exportPage(REF, { limit: 10 })).toEqual(reads.exportPage(sql, REF, { limit: 10 }));
  });
});

describe('writes: apply / applyBatch', () => {
  it('apply() ingests a message and returns ready: true (no backfill tracked yet)', async () => {
    const { object } = makeObject();
    const message = makeIngest();
    const result = await object.apply(REF, { kind: 'ingest', message }, 1_000);
    expect(result.ready).toBe(true);
    expect(result.ingest).toMatchObject({ id: message.id, created: true });
  });

  it('applyBatch() applies every op and schedules exactly one alarm for the batch', async () => {
    const { state, object } = makeObject();
    const a = makeIngest();
    const b = makeIngest();
    const results = await object.applyBatch(REF, [
      { kind: 'ingest', message: a },
      { kind: 'ingest', message: b },
    ], 1_000);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ready)).toBe(true);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });

  it('rejects writes once destroy has been accepted', async () => {
    const { object } = makeObject();
    await object.destroy(REF);
    await expect(object.apply(REF, { kind: 'ingest', message: makeIngest() })).rejects.toBeInstanceOf(MailboxDestroyedError);
  });
});

describe('status()', () => {
  it('reports schema version, counts, mode, databaseSize and readiness', async () => {
    const { object } = makeObject();
    await object.apply(REF, { kind: 'ingest', message: makeIngest() }, 1_000);

    const status = await object.status(REF);
    expect(status.schemaVersion).toBe(1);
    expect(status.workspaceId).toBe('ws_1');
    expect(status.accountId).toBe('acc_1');
    expect(status.mode).toBe('postgres');
    expect(status.counts.messages).toBe(1);
    expect(status.counts.outboxPending).toBe(2); // ledger.mail + entity_event
    expect(status.databaseSize).toBeGreaterThan(0);
    expect(status.destroying).toBe(false);
    expect(status.ready).toBe(true);
    expect(status.sizeWarning).toBe(false);
    expect(status.sizeCritical).toBe(false);
  });

  it('warns once past 6 GB and flags sizeCritical once past 8 GB, without ever un-flagging', async () => {
    const { state, object } = makeObject();
    const realSql = state.storage.sql;
    const warnSql = new Proxy(realSql, { get: (t, p) => (p === 'databaseSize' ? 7 * 1024 ** 3 : Reflect.get(t, p, t)) });
    (state.storage as { sql: SqlStorage }).sql = warnSql as unknown as SqlStorage;

    await object.apply(REF, { kind: 'ingest', message: makeIngest() }, 1_000);
    let status = await object.status(REF);
    expect(status.sizeWarning).toBe(true);
    expect(status.sizeCritical).toBe(false);

    const criticalSql = new Proxy(realSql, { get: (t, p) => (p === 'databaseSize' ? 9 * 1024 ** 3 : Reflect.get(t, p, t)) });
    (state.storage as { sql: SqlStorage }).sql = criticalSql as unknown as SqlStorage;
    await object.apply(REF, { kind: 'ingest', message: makeIngest() }, 2_000);
    status = await object.status(REF);
    expect(status.sizeCritical).toBe(true);
  });
});

describe('destroy()', () => {
  it('is accepted immediately and completes across alarm ticks, wiping the object', async () => {
    const bucket = createMemoryR2();
    const dropMailbox = vi.fn(async () => undefined);
    const mailIndexStub = { recordMailAddresses: vi.fn(async () => ({ applied: 0, skipped: 0 })), dropMailbox };
    const ns = {
      idFromName: (name: string) => ({ toString: () => name, equals: (o: unknown) => String(o) === name }),
      get: () => mailIndexStub,
      jurisdiction() {
        return this;
      },
    };
    const { state, object } = makeObject({ MAIL_STORAGE: bucket, MAIL_INDEX: ns as unknown as MailboxStoreObjectEnv['MAIL_INDEX'] });
    await object.apply(REF, { kind: 'ingest', message: makeIngest() }, 1_000);

    const accepted = await object.destroy(REF);
    expect(accepted).toEqual({ accepted: true });

    let ticks = 0;
    while ((await state.storage.getAlarm()) !== null && ticks < 10) {
      // eslint-disable-next-line no-await-in-loop
      await fireAlarm(state, object);
      ticks++;
    }

    expect(dropMailbox).toHaveBeenCalledTimes(1);
    expect(ticks).toBeGreaterThan(1); // genuinely spread across more than one tick
    expect(() => state.storage.sql.exec('SELECT * FROM meta').toArray()).toThrow(); // fully wiped
  });

  it('is idempotent: calling destroy() twice does not duplicate the ledger drop', async () => {
    const dropMailbox = vi.fn(async () => undefined);
    const ns = {
      idFromName: (name: string) => ({ toString: () => name, equals: (o: unknown) => String(o) === name }),
      get: () => ({ recordMailAddresses: vi.fn(async () => ({ applied: 0, skipped: 0 })), dropMailbox }),
      jurisdiction() {
        return this;
      },
    };
    const { state, object } = makeObject({
      MAIL_STORAGE: createMemoryR2(),
      MAIL_INDEX: ns as unknown as MailboxStoreObjectEnv['MAIL_INDEX'],
    });

    await object.destroy(REF);
    await object.destroy(REF); // no-op, same state

    let ticks = 0;
    while ((await state.storage.getAlarm()) !== null && ticks < 10) {
      // eslint-disable-next-line no-await-in-loop
      await fireAlarm(state, object);
      ticks++;
    }
    expect(dropMailbox).toHaveBeenCalledTimes(1);
  });
});

describe('setMode()', () => {
  it('stores the mode and is picked up by status()', async () => {
    const { object } = makeObject();
    await object.setMode(REF, 'object-only');
    expect((await object.status(REF)).mode).toBe('object-only');
  });
});
