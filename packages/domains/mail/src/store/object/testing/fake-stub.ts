/**
 * An in-memory RPC double for one mailbox, for testing `store/object/*`'s
 * adapters (`ObjectMailboxStore`/`ObjectWorkspaceMailStore`) and anything else
 * built on `MailboxStoreRpc` (the router, task C3). Not a mock over hand-wired
 * pure functions: it instantiates the REAL `MailboxStoreObject` Durable Object
 * class (`mailbox-object/mailbox-object.ts`, task C1) against a real
 * SQLite-backed `DurableObjectState` fake
 * (`@weldsuite/worker-kit/testing/durable-sqlite`'s
 * `createSqliteDurableObjectState`) and a real in-memory R2 bucket
 * (`@weldsuite/worker-kit/testing/r2`'s `createMemoryR2`) for `MAIL_STORAGE`.
 * Every query, migration, ref-binding check, write-core invariant and
 * alarm-scheduling side effect the real class runs, runs here too — so a
 * future change to the class's RPC surface (a renamed method, a dropped
 * argument, a changed return shape) fails THESE tests, not just the
 * object's own.
 *
 * Calling a method on the resulting stub is a direct method call on the real
 * class instance, not an actual Durable Object RPC round trip — there is no
 * network hop or workerd process boundary to cross in a `node` test
 * environment. The one behavioural gap that matters for a caller is
 * serialization: a real RPC call structured-clones its return value on the
 * way back, so the caller never shares object identity with the Durable
 * Object's own internal state. `asStructuredCloneStub` below reproduces that
 * for every method the stub exposes, so a test that mutates a returned
 * record (or relies on `===` identity across two calls) fails the same way
 * it would against the real binding.
 */

import { createSqliteDurableObjectState, type SqliteDurableObjectTestExtras } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { MailboxStoreObject, type MailboxStoreObjectEnv, type MailboxStoreRpc } from '../../../mailbox-object/mailbox-object';
import type { MailboxRef } from '../../types';
import { mailboxKeyFor } from '../stub';

export interface FakeMailboxStub extends MailboxStoreRpc {
  /** The backing fake `DurableObjectState`, for assertions that want to inspect storage directly or drain `waitUntil`. */
  readonly state: DurableObjectState & SqliteDurableObjectTestExtras;
  /** The real class instance the stub's methods forward to (unwrapped — calling it directly skips the structured-clone step). */
  readonly object: MailboxStoreObject;
}

/**
 * Wraps every method `target` exposes so its return value round-trips
 * through `structuredClone` before reaching the caller, mirroring what a
 * real Durable Object RPC response crosses on the way back (unlike calling a
 * class instance's methods directly in-process, which shares object identity
 * with the callee's own state). A `Proxy` rather than per-method forwarding
 * on purpose: this fake then automatically tracks `MailboxStoreRpc` as
 * methods are added or changed, instead of silently going stale.
 */
function asStructuredCloneStub<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result: unknown = await (value as (...a: unknown[]) => unknown).apply(obj, args);
        return result === undefined ? result : structuredClone(result);
      };
    },
  }) as T;
}

/**
 * Builds a fresh, migrated fake stub for `ref`, backed by a real
 * `MailboxStoreObject` instance. One call = one mailbox's worth of state (a
 * fresh in-memory SQLite database plus a fresh in-memory R2 bucket), matching
 * one Durable Object instance. `MAIL_STORAGE` is always bound (an empty
 * `createMemoryR2()`) so ingest's body writes and `ObjectMailboxStore`'s body
 * reads both work out of the box; `ENTITY_EVENTS`/`MAIL_INDEX` are left
 * unbound, same as any env `MailboxStoreObjectEnv` doesn't require — a test
 * exercising the outbox/alarm against a specific queue or `MailIndex` double
 * should construct `MailboxStoreObject` directly instead of through this
 * helper.
 */
export function createFakeMailboxStub(ref: MailboxRef): FakeMailboxStub {
  const state = createSqliteDurableObjectState({ name: mailboxKeyFor(ref) });
  // The tenant DB settings only matter to backfill, which these stubs never run.
  const env: MailboxStoreObjectEnv = {
    MAIL_STORAGE: createMemoryR2(),
    DATABASE_URL_MASTER: 'postgres://unused',
    WORKSPACE_CACHE: {} as KVNamespace,
    NEON_API_KEY: 'unused',
  };
  const object = new MailboxStoreObject(state, env);
  const rpc = asStructuredCloneStub(object);

  return {
    state,
    object,

    // ---- reads ----------------------------------------------------------
    listThreads: (r, q) => rpc.listThreads(r, q),
    getThread: (r, threadKey) => rpc.getThread(r, threadKey),
    getThreadOfMessage: (r, messageId) => rpc.getThreadOfMessage(r, messageId),
    getMessage: (r, id, o) => rpc.getMessage(r, id, o),
    getMessages: (r, ids) => rpc.getMessages(r, ids),
    listMessages: (r, q) => rpc.listMessages(r, q),
    stats: (r) => rpc.stats(r),
    unreadCount: (r, scope) => rpc.unreadCount(r, scope),
    labelCounts: (r, keys) => rpc.labelCounts(r, keys),
    listAttachments: (r, messageId) => rpc.listAttachments(r, messageId),
    getAttachment: (r, id) => rpc.getAttachment(r, id),
    recentAttachments: (r, q) => rpc.recentAttachments(r, q),
    recentAddresses: (r, limit) => rpc.recentAddresses(r, limit),
    resolveInbound: (r, q) => rpc.resolveInbound(r, q),
    findByRfcIds: (r, ids, providerIds) => rpc.findByRfcIds(r, ids, providerIds),
    findSentByIdempotencyKey: (r, key) => rpc.findSentByIdempotencyKey(r, key),
    countSentSince: (r, since) => rpc.countSentSince(r, since),
    listScheduled: (r) => rpc.listScheduled(r),
    listSnoozed: (r) => rpc.listSnoozed(r),
    listSubscriptions: (r, q) => rpc.listSubscriptions(r, q),
    getSubscription: (r, id) => rpc.getSubscription(r, id),
    rawSources: (r, q) => rpc.rawSources(r, q),
    listDrafts: (r, q) => rpc.listDrafts(r, q),
    getDraft: (r, id) => rpc.getDraft(r, id),
    exportPage: (r, q) => rpc.exportPage(r, q),

    // ---- writes -----------------------------------------------------------
    apply: (r, op, at) => rpc.apply(r, op, at),
    applyBatch: (r, ops, at) => rpc.applyBatch(r, ops, at),
    notePgDrift: (r, ids) => rpc.notePgDrift(r, ids),

    // ---- admin -------------------------------------------------------------
    status: (r) => rpc.status(r),
    destroy: (r) => rpc.destroy(r),
    setMode: (r, mode) => rpc.setMode(r, mode),
  };
}
