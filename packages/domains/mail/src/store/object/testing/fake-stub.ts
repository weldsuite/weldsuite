/**
 * An in-memory RPC double for one mailbox, for testing `store/object/*`'s
 * adapters (`ObjectMailboxStore`/`ObjectWorkspaceMailStore`) without the real
 * `MailboxStoreObject` Durable Object class (task C1, built separately in the
 * same PR). Not a mock: it implements `MailboxStoreRpc` by calling the SAME
 * pure functions the real class will wrap — `mailbox-object/{reads,writes}.ts`
 * — against a real SQLite-backed `DurableObjectState` fake
 * (`@weldsuite/worker-kit/testing/durable-sqlite`'s
 * `createSqliteDurableObjectState`). Every query, index, trigger-equivalent
 * and derived-table update the real object runs, runs here too; only the RPC
 * envelope itself (an actual Durable Object stub, serialization, a network
 * hop) is missing — the same tradeoff this package's other object fakes make
 * (`testing/cloudflare-workers-stub.ts`, `mail-index`'s own tests).
 *
 * Swap point: once `mailbox-object/mailbox-object.ts` exports the real
 * `MailboxStoreObject`, a test can switch to constructing that class directly
 * with the same `createSqliteDurableObjectState()` state (it's designed to be
 * constructed that way in tests too) instead of this fake — the call sites in
 * `store/object/*.test.ts` that take a `MailboxStoreRpc` don't need to change
 * either way.
 */

import { createSqliteDurableObjectState, type SqliteDurableObjectTestExtras } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { migrateMailbox } from '../../../mailbox-object/migrate';
import * as reads from '../../../mailbox-object/reads';
import { applyMailboxBatch, applyMailboxOp } from '../../../mailbox-object/writes';
import type { MailboxOp, MailboxRef } from '../../types';
import type { MailboxStoreRpc } from '../stub';

export interface FakeMailboxStub extends MailboxStoreRpc {
  /** The backing fake `DurableObjectState`, for assertions that want to inspect storage directly or drain `waitUntil`. */
  readonly state: DurableObjectState & SqliteDurableObjectTestExtras;
}

/**
 * Builds a fresh, migrated fake stub for `ref`. One call = one mailbox's
 * worth of state (a fresh in-memory SQLite database), matching one Durable
 * Object instance.
 */
export function createFakeMailboxStub(ref: MailboxRef): FakeMailboxStub {
  const state = createSqliteDurableObjectState({ name: `mbx:${ref.workspaceId}:${ref.accountId}` });
  migrateMailbox(state.storage);
  const sql = state.storage.sql;

  return {
    state,

    // ---- reads ----------------------------------------------------------
    listThreads: async (q) => reads.listThreads(sql, ref, q),
    getThread: async (threadKey) => reads.getThread(sql, ref, threadKey),
    getThreadOfMessage: async (messageId) => reads.getThreadOfMessage(sql, ref, messageId),
    getMessage: async (id, o) => reads.getMessage(sql, ref, id, o),
    getMessages: async (ids) => reads.getMessages(sql, ref, ids),
    listMessages: async (q) => reads.listMessages(sql, ref, q),
    stats: async () => reads.stats(sql),
    unreadCount: async (scope) => reads.unreadCount(sql, scope),
    labelCounts: async (keys) => reads.labelCounts(sql, keys),
    listAttachments: async (messageId) => reads.listAttachments(sql, messageId),
    getAttachment: async (id) => reads.getAttachment(sql, ref, id),
    recentAttachments: async (q) => reads.recentAttachments(sql, q),
    recentAddresses: async (limit) => reads.recentAddresses(sql, limit),
    resolveInbound: async (q) => reads.resolveInbound(sql, q),
    findByRfcIds: async (ids, providerIds) => reads.findByRfcIds(sql, ids, providerIds),
    findSentByIdempotencyKey: async (key) => reads.findSentByIdempotencyKey(sql, key),
    countSentSince: async (since) => reads.countSentSince(sql, since),
    listScheduled: async () => reads.listScheduled(sql, ref),
    listSnoozed: async () => reads.listSnoozed(sql, ref),
    listSubscriptions: async (q) => reads.listSubscriptions(sql, ref, q),
    getSubscription: async (id) => reads.getSubscription(sql, ref, id),
    rawSources: async (q) => reads.rawSources(sql, q),
    listDrafts: async (q) => reads.listDrafts(sql, ref, q),
    getDraft: async (id) => reads.getDraft(sql, ref, id),
    exportPage: async (q) => reads.exportPage(sql, ref, q),

    // ---- writes -----------------------------------------------------------
    apply: async (op: MailboxOp, at?: number) => applyMailboxOp(state.storage, ref, op, at),
    applyBatch: async (ops: MailboxOp[], at?: number) => applyMailboxBatch(state.storage, ref, ops, at),
  };
}
