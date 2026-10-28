/**
 * `ObjectWorkspaceMailStore`: fan-out + merge across mailboxes (design §5),
 * exercised with real per-mailbox logic via the fake stub
 * (`./testing/fake-stub`) so the merge, cursor and offset-cap wiring runs
 * against actual SQLite-backed mailboxes, not hand-built fixtures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { ObjectWorkspaceMailStore, type ObjectWorkspaceMailStoreEnv } from './workspace-store';
import { createFakeMailboxNamespace, createFailingMailIndexEnv, createFakeMailIndexEnv } from './testing/fake-env';
import { createFakeMailboxStub, type FakeMailboxStub } from './testing/fake-stub';
import { MailboxFanoutError } from './fanout';
import type { IngestMessage, MailboxRef, ThreadCursor } from '../types';

const WORKSPACE_ID = 'ws_1';
const CLERK_ORG_ID = 'org_1';

function makeEnv(
  makeStub: (ref: MailboxRef) => FakeMailboxStub = createFakeMailboxStub,
  extra: Partial<ObjectWorkspaceMailStoreEnv> = {},
) {
  const { namespace, stubs } = createFakeMailboxNamespace(makeStub);
  const bucket = createMemoryR2();
  const env: ObjectWorkspaceMailStoreEnv = { MAILBOX_STORE: namespace, MAIL_STORAGE: bucket, ...extra };
  return { env, stubs, bucket };
}

function makeStore(env: ObjectWorkspaceMailStoreEnv): ObjectWorkspaceMailStore {
  return new ObjectWorkspaceMailStore(env, WORKSPACE_ID, CLERK_ORG_ID);
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Unified thread list: merge order, cursor continuation, ties
// ---------------------------------------------------------------------------

describe('listThreads: merge + cursor continuation across 3 mailboxes', () => {
  it('pages through 3 mailboxes with no gaps, dupes or reordering', async () => {
    const { env } = makeEnv();
    const store = makeStore(env);
    const accountIds = ['acc_a', 'acc_b', 'acc_c'];

    const latestAts = [9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000];
    let i = 0;
    for (const accountId of accountIds) {
      for (let n = 0; n < 3; n++) {
        const at = latestAts[i]!;
        i++;
        await store
          .mailbox(accountId)
          .apply({ kind: 'ingest', message: makeIngest({ sentAt: at, receivedAt: at, createdAt: at, labels: ['INBOX'] }) });
      }
    }

    let cursor: ThreadCursor | null = null;
    const seen: number[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const page = await store.listThreads(accountIds, { labelSlug: '__all', pageSize: 4, cursor });
      expect(page.totalCount).toBe(9);
      for (const t of page.threads) seen.push(t.latestDate!.getTime());
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([...latestAts].sort((a, b) => b - a));
    expect(new Set(seen).size).toBe(9); // no duplicates
  });

  it('breaks a latestAt tie across mailboxes by accountId ascending, then threadKey ascending', async () => {
    const { env } = makeEnv();
    const store = makeStore(env);

    // Same `latestAt` in two different mailboxes.
    await store.mailbox('acc_b').apply({
      kind: 'ingest',
      message: makeIngest({ id: 'msg_tie_b', sentAt: 5000, receivedAt: 5000, createdAt: 5000, labels: ['INBOX'] }),
    });
    await store.mailbox('acc_a').apply({
      kind: 'ingest',
      message: makeIngest({ id: 'msg_tie_a', sentAt: 5000, receivedAt: 5000, createdAt: 5000, labels: ['INBOX'] }),
    });

    const page = await store.listThreads(['acc_a', 'acc_b'], { labelSlug: '__all', pageSize: 10 });
    expect(page.threads.map((t) => t.accountId)).toEqual(['acc_a', 'acc_b']);
  });

  it('offset mode over-fetches `offset + pageSize` from every mailbox with no per-mailbox offset, and clamps the offset at 5000', async () => {
    const seenQueries: Array<{ pageSize: number; offset: number | undefined; cursor: unknown }> = [];
    const { env } = makeEnv((ref) => {
      const stub = createFakeMailboxStub(ref);
      const real = stub.listThreads.bind(stub);
      stub.listThreads = (async (r, q) => {
        seenQueries.push({ pageSize: q.pageSize, offset: q.offset, cursor: q.cursor });
        return real(r, q);
      }) as typeof stub.listThreads;
      return stub;
    });
    const store = makeStore(env);

    await store.listThreads(['acc_a', 'acc_b'], { labelSlug: '__all', pageSize: 20, offset: 10_000 });

    expect(seenQueries).toHaveLength(2);
    for (const q of seenQueries) {
      expect(q.offset).toBeUndefined();
      expect(q.cursor).toBeNull();
      expect(q.pageSize).toBe(5000 + 20); // MAX_THREAD_OFFSET, not the raw 10_000
    }
  });
});

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------

describe('partial mailbox failure', () => {
  it('returns the mailboxes that answered when one fails, and logs the failure', async () => {
    const { env } = makeEnv((ref) => {
      const stub = createFakeMailboxStub(ref);
      if (ref.accountId === 'acc_bad') {
        stub.listThreads = (async () => {
          throw new Error('mailbox unreachable');
        }) as typeof stub.listThreads;
      }
      return stub;
    });
    const store = makeStore(env);
    await store.mailbox('acc_good').apply({ kind: 'ingest', message: makeIngest({ labels: ['INBOX'] }) });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = await store.listThreads(['acc_good', 'acc_bad'], { labelSlug: '__all', pageSize: 10 });

    expect(page.threads).toHaveLength(1);
    expect(page.totalCount).toBe(1);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('throws MailboxFanoutError when every mailbox in the fan-out fails', async () => {
    const { env } = makeEnv(() => {
      const stub = createFakeMailboxStub({ workspaceId: WORKSPACE_ID, accountId: 'irrelevant' });
      stub.listThreads = (async () => {
        throw new Error('down');
      }) as typeof stub.listThreads;
      return stub;
    });
    const store = makeStore(env);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(store.listThreads(['acc_a', 'acc_b'], { labelSlug: '__all', pageSize: 10 })).rejects.toThrow(MailboxFanoutError);
  });

  it('empty accountIds short-circuits without calling any mailbox', async () => {
    const { env } = makeEnv();
    const store = makeStore(env);
    await expect(store.listThreads([], { labelSlug: '__all', pageSize: 10 })).resolves.toEqual({
      threads: [],
      totalCount: 0,
      nextCursor: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Counterparty routing via MailIndex
// ---------------------------------------------------------------------------

describe('messagesByCounterparty', () => {
  async function seedCounterpartyMessages(store: ObjectWorkspaceMailStore) {
    await store.mailbox('acc_a').apply({
      kind: 'ingest',
      message: makeIngest({ to: [{ email: 'carol@example.com' }] }),
    });
    await store.mailbox('acc_b').apply({
      kind: 'ingest',
      message: makeIngest({ to: [{ email: 'carol@example.com' }] }),
    });
  }

  it('narrows to MailIndex.mailboxesForAddress ∩ accessible when the index is seeded', async () => {
    const mailIndexEnv = createFakeMailIndexEnv({
      seeded: true,
      addressToMailboxes: new Map([['carol@example.com', ['acc_b', 'acc_not_accessible']]]),
    });
    const { env } = makeEnv(createFakeMailboxStub, mailIndexEnv);
    const store = makeStore(env);
    await seedCounterpartyMessages(store);

    const page = await store.messagesByCounterparty('carol@example.com', ['acc_a', 'acc_b'], { limit: 10 });
    expect(page.data).toHaveLength(1); // only acc_b was in the index's answer
  });

  it('falls back to every accessible mailbox when the index is not yet seeded', async () => {
    const mailIndexEnv = createFakeMailIndexEnv({ seeded: false });
    const { env } = makeEnv(createFakeMailboxStub, mailIndexEnv);
    const store = makeStore(env);
    await seedCounterpartyMessages(store);

    const page = await store.messagesByCounterparty('carol@example.com', ['acc_a', 'acc_b'], { limit: 10 });
    expect(page.data).toHaveLength(2); // both accessible mailboxes checked
  });

  it('falls back to every accessible mailbox when the index call throws', async () => {
    const { env } = makeEnv(createFakeMailboxStub, createFailingMailIndexEnv());
    const store = makeStore(env);
    await seedCounterpartyMessages(store);

    const page = await store.messagesByCounterparty('carol@example.com', ['acc_a', 'acc_b'], { limit: 10 });
    expect(page.data).toHaveLength(2);
  });

  it('falls back to every accessible mailbox when MAIL_INDEX is not bound at all', async () => {
    const { env } = makeEnv();
    const store = makeStore(env);
    await seedCounterpartyMessages(store);

    const page = await store.messagesByCounterparty('carol@example.com', ['acc_a', 'acc_b'], { limit: 10 });
    expect(page.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Locate*
// ---------------------------------------------------------------------------

describe('locateMessages', () => {
  it('finds a hinted message without fanning out to the rest', async () => {
    const calls: string[] = [];
    const { env } = makeEnv((ref) => {
      const stub = createFakeMailboxStub(ref);
      const real = stub.getMessages.bind(stub);
      stub.getMessages = (async (r, ids) => {
        calls.push(ref.accountId);
        return real(r, ids);
      }) as typeof stub.getMessages;
      return stub;
    });
    const store = makeStore(env);
    const message = makeIngest();
    await store.mailbox('acc_hint').apply({ kind: 'ingest', message });

    const result = await store.locateMessages([message.id], ['acc_hint', 'acc_other'], 'acc_hint');
    expect(result.get(message.id)).toBe('acc_hint');
    expect(calls).toEqual(['acc_hint']); // never touched acc_other
  });

  it('falls back to a fan-out when the hint does not have the message', async () => {
    const { env } = makeEnv();
    const store = makeStore(env);
    const message = makeIngest();
    await store.mailbox('acc_other').apply({ kind: 'ingest', message });

    const result = await store.locateMessages([message.id], ['acc_hint', 'acc_other'], 'acc_hint');
    expect(result.get(message.id)).toBe('acc_other');
  });
});

// ---------------------------------------------------------------------------
// Stats / unread badge
// ---------------------------------------------------------------------------

describe('stats and unreadBadge', () => {
  it('sums field-wise across mailboxes', async () => {
    const { env } = makeEnv();
    const store = makeStore(env);
    await store.mailbox('acc_a').apply({ kind: 'ingest', message: makeIngest({ labels: ['INBOX'] }) });
    await store.mailbox('acc_b').apply({ kind: 'ingest', message: makeIngest({ labels: ['INBOX'] }) });

    const stats = await store.stats(['acc_a', 'acc_b']);
    expect(stats.total).toBe(2);
    expect(stats.inboxUnread).toBe(2);

    const badge = await store.unreadBadge(['acc_a', 'acc_b']);
    expect(badge).toBe(2);
  });
});
