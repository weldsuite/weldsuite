/**
 * `store/router.ts` (task C3, design §2.2): the mode table, secondary-write
 * failure isolation and its repair hand-off, demotion while a mailbox's
 * object isn't backfilled yet, the mode-downgrade warning, and that
 * `postgres` mode never touches KV or the object.
 *
 * Every dependency (`MailboxStore`, `WorkspaceMailStore`, the admin
 * `MAILBOX_STORE` namespace, `WORKSPACE_CACHE`) is a hand-built fake — this
 * suite is about the ROUTER's own decisions, not the Postgres or object
 * implementations (covered by `store/postgres/postgres-store.test.ts` and
 * `store/object/*.test.ts`) or the real Durable Object (`mailbox-object/*`,
 * covered there and by `store/contract.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAILBOX_DRIFT_TTL_SECONDS,
  RoutedMailboxStore,
  RoutedWorkspaceMailStore,
  __resetMailRouterStateForTests,
  getSecondaryFailureCount,
  rewriteOpForSecondary,
} from './router';
import { ParitySampler } from './parity';
import type { MailboxStoreNamespaceEnv } from './object';
import type {
  MailboxOp,
  MailboxRef,
  MailboxStats,
  MailboxStore,
  MailStoreMode,
  MessagePage,
  OpResult,
  ThreadPage,
  WorkspaceMailStore,
} from './types';

const REF: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1', clerkOrgId: 'org_1' };

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function emptyStats(): MailboxStats {
  return {
    total: 0, unread: 0, inboxUnread: 0, starred: 0, importantUnread: 0, sentUnread: 0,
    archiveUnread: 0, trashUnread: 0, spam: 0, snoozed: 0, scheduled: 0, drafts: 0, labels: {},
  };
}

function emptyThreadPage(): ThreadPage {
  return { threads: [], totalCount: 0, nextCursor: null };
}

function emptyMessagePage(): MessagePage {
  return { data: [], totalCount: 0, nextCursor: null };
}

function okResult(overrides: Partial<OpResult> = {}): OpResult {
  return { applied: [], missing: [], stale: [], ready: true, ...overrides };
}

function createFakeMailboxStore(ref: MailboxRef, backend: 'postgres' | 'object', overrides: Partial<MailboxStore> = {}): MailboxStore {
  return {
    ref,
    backend,
    listThreads: vi.fn(async () => emptyThreadPage()),
    getThread: vi.fn(async () => null),
    getThreadOfMessage: vi.fn(async () => null),
    getMessage: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    listMessages: vi.fn(async () => emptyMessagePage()),
    stats: vi.fn(async () => emptyStats()),
    unreadCount: vi.fn(async () => 0),
    labelCounts: vi.fn(async () => ({})),
    listAttachments: vi.fn(async () => []),
    getAttachment: vi.fn(async () => null),
    recentAttachments: vi.fn(async () => ({ data: [], totalCount: 0 })),
    recentAddresses: vi.fn(async () => []),
    resolveInbound: vi.fn(async () => ({ duplicate: false, threadId: 't1', isExistingHamThread: false })),
    findByRfcIds: vi.fn(async () => []),
    findSentByIdempotencyKey: vi.fn(async () => null),
    countSentSince: vi.fn(async () => 0),
    listScheduled: vi.fn(async () => []),
    listSnoozed: vi.fn(async () => []),
    listSubscriptions: vi.fn(async () => []),
    getSubscription: vi.fn(async () => null),
    rawSources: vi.fn(async () => []),
    listDrafts: vi.fn(async () => ({ data: [], hasMore: false, cursor: null, totalCount: 0 })),
    getDraft: vi.fn(async () => null),
    exportPage: vi.fn(async () => ({ data: [], cursor: null })),
    apply: vi.fn(async (_op: MailboxOp) => okResult()),
    applyBatch: vi.fn(async (ops: MailboxOp[]) => ops.map(() => okResult())),
    ...overrides,
  };
}

function createFakeWorkspaceStore(ref: MailboxRef, mode: MailStoreMode, overrides: Partial<WorkspaceMailStore> = {}): WorkspaceMailStore {
  return {
    workspaceId: ref.workspaceId,
    clerkOrgId: ref.clerkOrgId ?? 'org_1',
    mode,
    mailbox: vi.fn(() => createFakeMailboxStore(ref, mode === 'object' || mode === 'object-only' ? 'object' : 'postgres')),
    listThreads: vi.fn(async () => emptyThreadPage()),
    listMessages: vi.fn(async () => emptyMessagePage()),
    stats: vi.fn(async () => emptyStats()),
    unreadBadge: vi.fn(async () => 0),
    locateMessages: vi.fn(async () => new Map()),
    locateAttachment: vi.fn(async () => null),
    locateDraft: vi.fn(async () => null),
    messagesByCounterparty: vi.fn(async () => emptyMessagePage()),
    recentAttachments: vi.fn(async () => ({ data: [], totalCount: 0 })),
    recentMessages: vi.fn(async () => []),
    markFolderRead: vi.fn(async () => ({ updatedCount: 0, updated: [] })),
    listSnoozed: vi.fn(async () => []),
    listScheduled: vi.fn(async () => []),
    listDrafts: vi.fn(async () => ({ data: [], hasMore: false, cursor: null, totalCount: 0 })),
    ...overrides,
  };
}

interface FakeAdminStub {
  status: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
}

function createFakeAdminStub(opts: { ready?: boolean; previousMode?: MailStoreMode } = {}): FakeAdminStub {
  return {
    status: vi.fn(async () => ({ ready: opts.ready ?? true })),
    setMode: vi.fn(async () => opts.previousMode ?? 'postgres'),
  };
}

function createFakeAdminEnv(stub: FakeAdminStub): MailboxStoreNamespaceEnv {
  const ns = { jurisdiction: (_j: 'eu') => ({ idFromName: (name: string) => name, get: () => stub }) };
  return { MAILBOX_STORE: ns } as unknown as MailboxStoreNamespaceEnv;
}

function throwingAdminEnv(): MailboxStoreNamespaceEnv {
  const ns = {
    jurisdiction: () => ({
      idFromName: () => {
        throw new Error('postgres mode must never look up the mailbox object');
      },
      get: () => {
        throw new Error('postgres mode must never look up the mailbox object');
      },
    }),
  };
  return { MAILBOX_STORE: ns } as unknown as MailboxStoreNamespaceEnv;
}

function createFakeKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    }),
  };
  return { kv: kv as unknown as KVNamespace, raw: kv, store };
}

function throwingKv(): KVNamespace {
  return {
    get: async () => {
      throw new Error('postgres mode must never touch WORKSPACE_CACHE');
    },
    put: async () => {
      throw new Error('postgres mode must never touch WORKSPACE_CACHE');
    },
  } as unknown as KVNamespace;
}

const noopWaitUntil = (p: Promise<unknown>) => {
  p.catch(() => undefined);
};

beforeEach(() => {
  __resetMailRouterStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// rewriteOpForSecondary
// ---------------------------------------------------------------------------

describe('rewriteOpForSecondary', () => {
  it('ingest: sets threadId from the primary result', () => {
    const op: MailboxOp = { kind: 'ingest', message: { threadId: null } as never };
    const rewritten = rewriteOpForSecondary(op, okResult({ ingest: { id: 'msg_1', threadKey: 'thread_x', created: true } }));
    expect(rewritten).toHaveLength(1);
    expect((rewritten[0] as { kind: 'ingest'; message: { threadId: string | null } }).message.threadId).toBe('thread_x');
  });

  it('thread.read: becomes chunked flags ops from updatedIds', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `m${i}`);
    const op: MailboxOp = { kind: 'thread.read', threadKey: 't1', isRead: true };
    const rewritten = rewriteOpForSecondary(op, okResult({ updatedIds: ids }));
    expect(rewritten).toHaveLength(2);
    expect(rewritten[0]).toEqual({ kind: 'flags', ids: ids.slice(0, 1000), patch: { isRead: true }, semantics: 'bulk' });
    expect(rewritten[1]).toEqual({ kind: 'flags', ids: ids.slice(1000), patch: { isRead: true }, semantics: 'bulk' });
  });

  it('thread.read: no updatedIds means nothing to send to the secondary', () => {
    const op: MailboxOp = { kind: 'thread.read', threadKey: 't1', isRead: false };
    expect(rewriteOpForSecondary(op, okResult())).toEqual([]);
  });

  it('folder.read: becomes flags{isRead:true} chunks regardless of the op itself', () => {
    const op: MailboxOp = { kind: 'folder.read', scope: { labelSlug: 'inbox' } };
    const rewritten = rewriteOpForSecondary(op, okResult({ updatedIds: ['m1', 'm2'] }));
    expect(rewritten).toEqual([{ kind: 'flags', ids: ['m1', 'm2'], patch: { isRead: true }, semantics: 'bulk' }]);
  });

  it('snooze.wake is never dual-written', () => {
    const op: MailboxOp = { kind: 'snooze.wake', now: 1000 };
    expect(rewriteOpForSecondary(op, okResult())).toEqual([]);
  });

  it('everything else passes through unchanged', () => {
    const op: MailboxOp = { kind: 'labels.add', ids: ['m1'], labels: ['STARRED'], semantics: 'single' };
    expect(rewriteOpForSecondary(op, okResult())).toEqual([op]);
  });
});

// ---------------------------------------------------------------------------
// RoutedMailboxStore: mode table (reads)
// ---------------------------------------------------------------------------

describe('RoutedMailboxStore: read routing per mode', () => {
  it('postgres: reads Postgres only, never touches adminEnv/kv', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const store = new RoutedMailboxStore({
      ref: REF, mode: 'postgres', postgres, object,
      adminEnv: throwingAdminEnv(), kv: throwingKv(), waitUntil: noopWaitUntil,
    });
    await store.getMessage('m1');
    expect(postgres.getMessage).toHaveBeenCalledWith('m1', undefined);
    expect(object.getMessage).not.toHaveBeenCalled();
    expect(store.backend).toBe('postgres');
  });

  it('shadow: reads Postgres, never the object', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const store = new RoutedMailboxStore({
      ref: REF, mode: 'shadow', postgres, object,
      adminEnv: createFakeAdminEnv(createFakeAdminStub()), waitUntil: noopWaitUntil,
    });
    await store.getMessage('m1');
    expect(postgres.getMessage).toHaveBeenCalled();
    expect(object.getMessage).not.toHaveBeenCalled();
    expect(store.backend).toBe('postgres');
  });

  it('object: reads the object; a thrown error falls back to Postgres', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object', { getMessage: vi.fn(async () => { throw new Error('object down'); }) });
    const store = new RoutedMailboxStore({
      ref: REF, mode: 'object', postgres, object,
      adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv, waitUntil: noopWaitUntil,
    });
    await expect(store.getMessage('m1')).resolves.toBeNull();
    expect(object.getMessage).toHaveBeenCalled();
    expect(postgres.getMessage).toHaveBeenCalled();
    expect(store.backend).toBe('object');
  });

  it('object-only: reads the object; a thrown error propagates (no fallback)', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object', { getMessage: vi.fn(async () => { throw new Error('object down'); }) });
    const store = new RoutedMailboxStore({
      ref: REF, mode: 'object-only', postgres, object,
      adminEnv: createFakeAdminEnv(createFakeAdminStub()), waitUntil: noopWaitUntil,
    });
    await expect(store.getMessage('m1')).rejects.toThrow('object down');
    expect(postgres.getMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RoutedMailboxStore: mode table (writes)
// ---------------------------------------------------------------------------

describe('RoutedMailboxStore: write routing per mode', () => {
  const OP: MailboxOp = { kind: 'flags', ids: ['m1'], patch: { isRead: true }, semantics: 'single' };

  it('postgres: writes Postgres only', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const store = new RoutedMailboxStore({ ref: REF, mode: 'postgres', postgres, object, adminEnv: throwingAdminEnv(), kv: throwingKv(), waitUntil: noopWaitUntil });
    await store.apply(OP, 1000);
    expect(postgres.apply).toHaveBeenCalledWith(OP, 1000);
    expect(object.apply).not.toHaveBeenCalled();
    expect(object.applyBatch).not.toHaveBeenCalled();
  });

  it('shadow: Postgres is primary (awaited); the object gets the secondary write via waitUntil', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const calls: Promise<unknown>[] = [];
    const store = new RoutedMailboxStore({
      ref: REF, mode: 'shadow', postgres, object,
      adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv,
      waitUntil: (p) => calls.push(p),
    });
    const result = await store.apply(OP, 1000);
    expect(postgres.apply).toHaveBeenCalledWith(OP, 1000);
    await Promise.all(calls);
    expect(object.applyBatch).toHaveBeenCalledWith([OP], 1000);
    expect(result.applied).toEqual([]);
  });

  it('object: the object is primary (awaited); Postgres gets the secondary write via waitUntil', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const calls: Promise<unknown>[] = [];
    const store = new RoutedMailboxStore({
      ref: REF, mode: 'object', postgres, object,
      adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv,
      waitUntil: (p) => calls.push(p),
    });
    await store.apply(OP, 1000);
    expect(object.apply).toHaveBeenCalledWith(OP, 1000);
    await Promise.all(calls);
    expect(postgres.applyBatch).toHaveBeenCalledWith([OP], 1000);
  });

  it('object-only: the object only, no secondary at all', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object-only', postgres, object, adminEnv: createFakeAdminEnv(createFakeAdminStub()), waitUntil: noopWaitUntil });
    await store.apply(OP, 1000);
    expect(object.apply).toHaveBeenCalledWith(OP, 1000);
    expect(postgres.apply).not.toHaveBeenCalled();
    expect(postgres.applyBatch).not.toHaveBeenCalled();
  });

  it('a secondary write that rewrites to zero ops (snooze.wake) never calls the secondary store', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const store = new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres, object, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv, waitUntil: noopWaitUntil });
    await store.apply({ kind: 'snooze.wake', now: 1000 }, 1000);
    expect(object.applyBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Secondary write failure isolation + repair hand-off
// ---------------------------------------------------------------------------

describe('Secondary write failure: never fails the request, logs, counts, marks drift', () => {
  const OP: MailboxOp = { kind: 'flags', ids: ['m1', 'm2'], patch: { isRead: true }, semantics: 'bulk' };

  it('shadow: a throwing object secondary does not fail the request, and sets mbxdrift:<ws>:<acct>', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object', { applyBatch: vi.fn(async () => { throw new Error('object unreachable'); }) });
    const { kv, store: kvStore } = createFakeKv();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: Promise<unknown>[] = [];
    const store = new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres, object, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv, waitUntil: (p) => calls.push(p) });

    const before = getSecondaryFailureCount(REF, 'pg-to-object');
    await expect(store.apply(OP, 1000)).resolves.toMatchObject({ ready: true });
    await Promise.all(calls.map((p) => p.catch(() => undefined)));

    expect(getSecondaryFailureCount(REF, 'pg-to-object')).toBe(before + 1);
    expect(errorSpy).toHaveBeenCalled();
    const marker = kvStore.get(`mbxdrift:${REF.workspaceId}:${REF.accountId}`);
    expect(marker).toBeDefined();
    expect(marker!.expirationTtl).toBe(MAILBOX_DRIFT_TTL_SECONDS);
    const parsed = JSON.parse(marker!.value);
    expect(parsed.lastKind).toBe('flags');
    expect(parsed.sampleIds).toEqual(['m1', 'm2']);
  });

  it('object: a throwing Postgres secondary does not fail the request, and sets mbxpgdrift:<ws>:<acct>', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres', { applyBatch: vi.fn(async () => { throw new Error('pg unreachable'); }) });
    const object = createFakeMailboxStore(REF, 'object');
    const { kv, store: kvStore } = createFakeKv();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: Promise<unknown>[] = [];
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object', postgres, object, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv, waitUntil: (p) => calls.push(p) });

    const before = getSecondaryFailureCount(REF, 'object-to-pg');
    await expect(store.apply(OP, 1000)).resolves.toMatchObject({ ready: true });
    await Promise.all(calls.map((p) => p.catch(() => undefined)));

    expect(getSecondaryFailureCount(REF, 'object-to-pg')).toBe(before + 1);
    expect(kvStore.get(`mbxpgdrift:${REF.workspaceId}:${REF.accountId}`)).toBeDefined();
  });

  it('missing ids in the secondary result are NOT a failure (no throw ⇒ no count, no drift marker)', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object', { applyBatch: vi.fn(async (ops: MailboxOp[]) => ops.map(() => okResult({ missing: ['m1', 'm2'] }))) });
    const { kv, store: kvStore } = createFakeKv();
    const calls: Promise<unknown>[] = [];
    const store = new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres, object, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv, waitUntil: (p) => calls.push(p) });

    const before = getSecondaryFailureCount(REF, 'pg-to-object');
    await store.apply(OP, 1000);
    await Promise.all(calls);

    expect(getSecondaryFailureCount(REF, 'pg-to-object')).toBe(before);
    expect(kvStore.get(`mbxdrift:${REF.workspaceId}:${REF.accountId}`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Readiness demotion
// ---------------------------------------------------------------------------

describe('Readiness: object/object-only demote to Postgres while not ready', () => {
  it('object: a not-ready status() demotes the read to Postgres', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const adminStub = createFakeAdminStub({ ready: false });
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object', postgres, object, adminEnv: createFakeAdminEnv(adminStub), kv: createFakeKv().kv, waitUntil: noopWaitUntil });

    await store.getMessage('m1');
    expect(adminStub.status).toHaveBeenCalledWith(REF);
    expect(postgres.getMessage).toHaveBeenCalled();
    expect(object.getMessage).not.toHaveBeenCalled();
  });

  it('object-only ALSO demotes while not ready (the documented exception to "no fallback")', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const adminStub = createFakeAdminStub({ ready: false });
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object-only', postgres, object, adminEnv: createFakeAdminEnv(adminStub), waitUntil: noopWaitUntil });

    await store.getMessage('m1');
    expect(postgres.getMessage).toHaveBeenCalled();
    expect(object.getMessage).not.toHaveBeenCalled();
  });

  it('once ready, reads go to the object and status() is cached across calls within the isolate', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const adminStub = createFakeAdminStub({ ready: true });
    let now = 1_000;
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object', postgres, object, adminEnv: createFakeAdminEnv(adminStub), kv: createFakeKv().kv, waitUntil: noopWaitUntil, now: () => now });

    await store.getMessage('m1');
    await store.getMessage('m2');
    expect(object.getMessage).toHaveBeenCalledTimes(2);
    expect(adminStub.status).toHaveBeenCalledTimes(1); // cached within the 60s TTL

    now += 60_001; // past the TTL
    await store.getMessage('m3');
    expect(adminStub.status).toHaveBeenCalledTimes(2);
  });

  it("a write's OpResult.ready updates the cache, so a read right after a not-ready write also demotes", async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object', { apply: vi.fn(async () => okResult({ ready: false })) });
    const adminStub = createFakeAdminStub({ ready: true }); // status() would say ready, but the write just said otherwise
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object', postgres, object, adminEnv: createFakeAdminEnv(adminStub), kv: createFakeKv().kv, waitUntil: noopWaitUntil });

    await store.apply({ kind: 'thread.read', threadKey: 't1', isRead: true }, 1000);
    await store.getMessage('m1');
    expect(postgres.getMessage).toHaveBeenCalled();
    expect(object.getMessage).not.toHaveBeenCalled();
    expect(adminStub.status).not.toHaveBeenCalled(); // the write's own ready flag was enough
  });

  it('a failed status() probe fails open (assumes ready) rather than demoting forever', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const adminStub = { status: vi.fn(async () => { throw new Error('DO unreachable'); }), setMode: vi.fn(async () => 'postgres' as MailStoreMode) };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new RoutedMailboxStore({ ref: REF, mode: 'object', postgres, object, adminEnv: createFakeAdminEnv(adminStub), kv: createFakeKv().kv, waitUntil: noopWaitUntil });

    await store.getMessage('m1');
    expect(object.getMessage).toHaveBeenCalled();
    expect(postgres.getMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Telling the object its mode + the downgrade warning
// ---------------------------------------------------------------------------

describe('setMode: at most once per isolate per (mailbox, mode), downgrade warning', () => {
  it('calls setMode on first use under a new mode, not again for a second construction under the same mode', async () => {
    const adminStub = createFakeAdminStub({ previousMode: 'postgres' });
    const adminEnv = createFakeAdminEnv(adminStub);
    const makeStore = () =>
      new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres: createFakeMailboxStore(REF, 'postgres'), object: createFakeMailboxStore(REF, 'object'), adminEnv, kv: createFakeKv().kv, waitUntil: noopWaitUntil });

    const first = makeStore();
    await first.getMessage('m1'); // ensure the fire-and-forget setMode call has a chance to run
    await Promise.resolve();
    const second = makeStore();
    await second.getMessage('m1');
    await Promise.resolve();

    expect(adminStub.setMode).toHaveBeenCalledTimes(1);
    expect(adminStub.setMode).toHaveBeenCalledWith(REF, 'shadow');
  });

  it('calls setMode again when the mode actually changes for the same mailbox', async () => {
    const adminStub = createFakeAdminStub({ previousMode: 'postgres' });
    const adminEnv = createFakeAdminEnv(adminStub);
    // eslint-disable-next-line no-new -- constructing fires the fire-and-forget setMode call; we only assert on the stub
    new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres: createFakeMailboxStore(REF, 'postgres'), object: createFakeMailboxStore(REF, 'object'), adminEnv, kv: createFakeKv().kv, waitUntil: noopWaitUntil });
    await Promise.resolve();
    // eslint-disable-next-line no-new
    new RoutedMailboxStore({ ref: REF, mode: 'object', postgres: createFakeMailboxStore(REF, 'postgres'), object: createFakeMailboxStore(REF, 'object'), adminEnv, kv: createFakeKv().kv, waitUntil: noopWaitUntil });
    await Promise.resolve();

    expect(adminStub.setMode).toHaveBeenCalledTimes(2);
  });

  it('logs a warning when the mode is a downgrade from what the object last saw', async () => {
    const adminStub = createFakeAdminStub({ previousMode: 'object-only' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // eslint-disable-next-line no-new
    new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres: createFakeMailboxStore(REF, 'postgres'), object: createFakeMailboxStore(REF, 'object'), adminEnv: createFakeAdminEnv(adminStub), kv: createFakeKv().kv, waitUntil: noopWaitUntil });
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith('[mail-store] mailbox mode downgrade:', expect.stringContaining('"from":"object-only"'));
  });

  it('does not warn when the mode is not a downgrade', async () => {
    const adminStub = createFakeAdminStub({ previousMode: 'postgres' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // eslint-disable-next-line no-new
    new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres: createFakeMailboxStore(REF, 'postgres'), object: createFakeMailboxStore(REF, 'object'), adminEnv: createFakeAdminEnv(adminStub), kv: createFakeKv().kv, waitUntil: noopWaitUntil });
    await Promise.resolve();

    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('downgrade'))).toBe(false);
  });

  it('never calls setMode in postgres mode', async () => {
    const store = new RoutedMailboxStore({ ref: REF, mode: 'postgres', postgres: createFakeMailboxStore(REF, 'postgres'), object: createFakeMailboxStore(REF, 'object'), adminEnv: throwingAdminEnv(), kv: throwingKv(), waitUntil: noopWaitUntil });
    await store.getMessage('m1');
    await Promise.resolve();
    // throwingAdminEnv would have thrown if anything tried to look up the stub — reaching here is the assertion.
    expect(store.backend).toBe('postgres');
  });
});

// ---------------------------------------------------------------------------
// Parity sampling wiring (shadow only)
// ---------------------------------------------------------------------------

describe('Parity sampling wiring', () => {
  it('shadow mode samples listThreads/stats against the object via the injected ParitySampler', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres', {
      listThreads: vi.fn(async () => ({ threads: [], totalCount: 0, nextCursor: null })),
      stats: vi.fn(async () => emptyStats()),
    });
    const object = createFakeMailboxStore(REF, 'object');
    const onMismatch = vi.fn();
    const parity = new ParitySampler({ rate: 1, onMismatch });
    const calls: Promise<unknown>[] = [];
    const store = new RoutedMailboxStore({ ref: REF, mode: 'shadow', postgres, object, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv, parity, waitUntil: (p) => calls.push(p) });

    await store.listThreads({ labelSlug: 'inbox', pageSize: 20 });
    await store.stats();
    await Promise.all(calls);

    expect(object.listThreads).toHaveBeenCalled();
    expect(object.stats).toHaveBeenCalled();
  });

  it('other modes never sample parity, even if a sampler were wired', async () => {
    const postgres = createFakeMailboxStore(REF, 'postgres');
    const object = createFakeMailboxStore(REF, 'object');
    const onMismatch = vi.fn();
    const parity = new ParitySampler({ rate: 1, onMismatch });
    const store = new RoutedMailboxStore({ ref: REF, mode: 'postgres', postgres, object, parity, waitUntil: noopWaitUntil });

    await store.listThreads({ labelSlug: 'inbox', pageSize: 20 });
    expect(object.listThreads).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RoutedWorkspaceMailStore
// ---------------------------------------------------------------------------

describe('RoutedWorkspaceMailStore', () => {
  it('postgres: cross-mailbox reads go to the Postgres workspace store only', async () => {
    const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres');
    const objectWorkspace = createFakeWorkspaceStore(REF, 'object');
    const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'postgres', postgresWorkspace, objectWorkspace, adminEnv: throwingAdminEnv(), kv: throwingKv(), waitUntil: noopWaitUntil });

    await store.listThreads(['acc_1'], { labelSlug: 'inbox', pageSize: 20 });
    expect(postgresWorkspace.listThreads).toHaveBeenCalled();
    expect(objectWorkspace.listThreads).not.toHaveBeenCalled();
  });

  it('object: a total fan-out failure falls back to Postgres', async () => {
    const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres');
    const objectWorkspace = createFakeWorkspaceStore(REF, 'object', { listThreads: vi.fn(async () => { throw new Error('every mailbox failed'); }) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'object', postgresWorkspace, objectWorkspace, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv, waitUntil: noopWaitUntil });

    await store.listThreads(['acc_1'], { labelSlug: 'inbox', pageSize: 20 });
    expect(postgresWorkspace.listThreads).toHaveBeenCalled();
  });

  it('object-only: a total fan-out failure propagates (no fallback)', async () => {
    const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres');
    const objectWorkspace = createFakeWorkspaceStore(REF, 'object-only', { listThreads: vi.fn(async () => { throw new Error('every mailbox failed'); }) });
    const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'object-only', postgresWorkspace, objectWorkspace, adminEnv: createFakeAdminEnv(createFakeAdminStub()), waitUntil: noopWaitUntil });

    await expect(store.listThreads(['acc_1'], { labelSlug: 'inbox', pageSize: 20 })).rejects.toThrow('every mailbox failed');
    expect(postgresWorkspace.listThreads).not.toHaveBeenCalled();
  });

  it('mailbox(accountId) is memoised: the same RoutedMailboxStore comes back for repeat calls', () => {
    const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres');
    const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'postgres', postgresWorkspace, waitUntil: noopWaitUntil });
    expect(store.mailbox('acc_1')).toBe(store.mailbox('acc_1'));
  });

  describe('markFolderRead (a cross-mailbox write)', () => {
    it('postgres: the one Postgres call, unchanged', async () => {
      const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres', { markFolderRead: vi.fn(async () => ({ updatedCount: 1, updated: [{ id: 'm1', accountId: 'acc_1' }] })) });
      const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'postgres', postgresWorkspace, adminEnv: throwingAdminEnv(), kv: throwingKv(), waitUntil: noopWaitUntil });
      const result = await store.markFolderRead(['acc_1'], { labelSlug: 'inbox' });
      expect(result.updatedCount).toBe(1);
      expect(postgresWorkspace.markFolderRead).toHaveBeenCalled();
    });

    it('object-only: the object workspace call only', async () => {
      const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres');
      const objectWorkspace = createFakeWorkspaceStore(REF, 'object-only');
      const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'object-only', postgresWorkspace, objectWorkspace, adminEnv: createFakeAdminEnv(createFakeAdminStub()), waitUntil: noopWaitUntil });
      await store.markFolderRead(['acc_1'], { labelSlug: 'inbox' });
      expect(objectWorkspace.markFolderRead).toHaveBeenCalled();
      expect(postgresWorkspace.markFolderRead).not.toHaveBeenCalled();
    });

    it('object: the object call is primary; Postgres is mirrored via waitUntil', async () => {
      const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres');
      const objectWorkspace = createFakeWorkspaceStore(REF, 'object', { markFolderRead: vi.fn(async () => ({ updatedCount: 1, updated: [{ id: 'm1', accountId: 'acc_1' }] })) });
      const calls: Promise<unknown>[] = [];
      const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'object', postgresWorkspace, objectWorkspace, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv, waitUntil: (p) => calls.push(p) });

      const result = await store.markFolderRead(['acc_1'], { labelSlug: 'inbox' });
      expect(result.updatedCount).toBe(1);
      await Promise.all(calls.map((p) => p.catch(() => undefined)));
      expect(postgresWorkspace.markFolderRead).toHaveBeenCalled();
    });

    it('shadow: Postgres is primary; updated ids are mirrored to each mailbox\'s object as chunked flags{isRead:true}', async () => {
      const updated = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}`, accountId: 'acc_1' }));
      const postgresWorkspace = createFakeWorkspaceStore(REF, 'postgres', { markFolderRead: vi.fn(async () => ({ updatedCount: updated.length, updated })) });
      const objectMailbox = createFakeMailboxStore(REF, 'object');
      const objectWorkspace = createFakeWorkspaceStore(REF, 'object', { mailbox: vi.fn(() => objectMailbox) });
      const calls: Promise<unknown>[] = [];
      const store = new RoutedWorkspaceMailStore({ workspaceId: REF.workspaceId, clerkOrgId: 'org_1', mode: 'shadow', postgresWorkspace, objectWorkspace, adminEnv: createFakeAdminEnv(createFakeAdminStub()), kv: createFakeKv().kv, waitUntil: (p) => calls.push(p) });

      const result = await store.markFolderRead(['acc_1'], { labelSlug: 'inbox' });
      expect(result.updatedCount).toBe(1200);
      await Promise.all(calls.map((p) => p.catch(() => undefined)));

      expect(objectMailbox.applyBatch).toHaveBeenCalledTimes(2); // 1200 ids, chunked by 1000
      const calledOps = (objectMailbox.applyBatch as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => (call[0] as MailboxOp[])[0] as { kind: 'flags'; ids: string[] },
      );
      const allIds = calledOps.flatMap((op) => op.ids);
      expect(allIds).toHaveLength(1200);
    });
  });
});
