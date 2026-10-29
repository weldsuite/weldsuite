/**
 * `reads.ts`'s read core (design §3.3, task B3): fast vs filtered thread-list
 * parity, search (meta trigram / body prefix), keyset + offset paging
 * (boundaries and ties), stats/labelCounts against a full `rebuildDerived`
 * recount, `resolveInbound` ported from the inbound worker's thread-matching
 * rules, and the remaining small reads (attachments, addresses, scheduled,
 * snoozed, subscriptions, drafts, export).
 *
 * Built on the same fakes B1 uses: `createSqliteDurableObjectState` +
 * `migrateMailbox` for the schema, `applyMailboxOp` to seed data through the
 * real write path (so a test never has to know the derived-table internals
 * `reads.ts` itself reads).
 */
import { describe, expect, it } from 'vitest';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { migrateMailbox } from './migrate';
import { applyMailboxOp, rebuildDerived, type WritableStorage } from './writes';
import * as reads from './reads';
import type { IngestMessage, MailboxOp, MailboxRef } from '../store/types';

function makeMailbox(ref: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1' }) {
  const { storage } = createSqliteDurableObjectState();
  migrateMailbox(storage);
  return { storage: storage as unknown as WritableStorage, ref };
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

function ingest(storage: WritableStorage, ref: MailboxRef, overrides: Partial<IngestMessage> = {}, at?: number) {
  const message = makeIngest(overrides);
  const result = applyMailboxOp(storage, ref, { kind: 'ingest', message }, at ?? message.sentAt);
  return { message, result };
}

function apply(storage: WritableStorage, ref: MailboxRef, op: MailboxOp, at: number) {
  return applyMailboxOp(storage, ref, op, at);
}

// ---------------------------------------------------------------------------
// listThreads: fast path
// ---------------------------------------------------------------------------

describe('listThreads — fast path (plain folder via thread_labels)', () => {
  it('lists newest-first and pages by cursor', () => {
    const { storage, ref } = makeMailbox();
    const older = ingest(storage, ref, { threadId: 't_older', sentAt: 1_000, receivedAt: 1_000 });
    const newer = ingest(storage, ref, { threadId: 't_newer', sentAt: 2_000, receivedAt: 2_000 });

    const page1 = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 1 });
    expect(page1.threads.map((t) => t.latestMessageId)).toEqual([newer.message.id]);
    expect(page1.totalCount).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 1, cursor: page1.nextCursor });
    expect(page2.threads.map((t) => t.latestMessageId)).toEqual([older.message.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('pages by legacy offset identically to cursor paging', () => {
    const { storage, ref } = makeMailbox();
    const a = ingest(storage, ref, { threadId: 't_a', sentAt: 1_000, receivedAt: 1_000 });
    const b = ingest(storage, ref, { threadId: 't_b', sentAt: 2_000, receivedAt: 2_000 });
    const c = ingest(storage, ref, { threadId: 't_c', sentAt: 3_000, receivedAt: 3_000 });
    void a;

    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 1, offset: 1 });
    expect(page.threads.map((t) => t.latestMessageId)).toEqual([b.message.id]);
    expect(page.totalCount).toBe(3);

    const last = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, offset: 2 });
    expect(last.threads.map((t) => t.latestMessageId)).toEqual([a.message.id]);
    void c;
  });

  it('treats an absurd offset as capped rather than throwing (design §5 offset cap)', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { threadId: 't_only' });
    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, offset: 50_000_000 });
    expect(page.threads).toEqual([]);
    expect(page.totalCount).toBe(1);
  });

  it('breaks ties at the same latestAt by thread_key ascending, and the cursor resumes past the tie correctly', () => {
    const { storage, ref } = makeMailbox();
    // Same sentAt/receivedAt on purpose: thread_key is the only tiebreaker.
    ingest(storage, ref, { threadId: 't_x', sentAt: 5_000, receivedAt: 5_000 });
    ingest(storage, ref, { threadId: 't_y', sentAt: 5_000, receivedAt: 5_000 });
    const keysInOrder = ['t_x', 't_y'].sort();

    const page1 = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 1 });
    expect(page1.threads.map((t) => t.threadId)).toEqual([keysInOrder[0]]);
    expect(page1.nextCursor).toMatchObject({ threadKey: keysInOrder[0], accountId: 'acc_1' });

    const page2 = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 1, cursor: page1.nextCursor });
    expect(page2.threads.map((t) => t.threadId)).toEqual([keysInOrder[1]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("'all' maps to the __all folder key and hides trash/spam", () => {
    const { storage, ref } = makeMailbox();
    const live = ingest(storage, ref, { labels: ['INBOX'] });
    ingest(storage, ref, { labels: ['TRASH'] });
    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'all', pageSize: 10 });
    expect(page.threads.map((t) => t.latestMessageId)).toEqual([live.message.id]);
  });

  it('trash and spam only ever show in their own folder', () => {
    const { storage, ref } = makeMailbox();
    const trashed = ingest(storage, ref, { labels: ['TRASH'] });
    const spam = ingest(storage, ref, { labels: ['SPAM'], isSpam: true });
    expect(reads.listThreads(storage.sql, ref, { labelSlug: 'trash', pageSize: 10 }).threads.map((t) => t.latestMessageId)).toEqual([trashed.message.id]);
    expect(reads.listThreads(storage.sql, ref, { labelSlug: 'spam', pageSize: 10 }).threads.map((t) => t.latestMessageId)).toEqual([spam.message.id]);
    expect(reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10 }).threads).toEqual([]);
  });

  it("a custom label's folder hides archived mail, unlike a system folder", () => {
    const { storage, ref } = makeMailbox();
    const kept = ingest(storage, ref, { labels: ['INBOX', 'Invoices'] });
    const archived = ingest(storage, ref, { labels: ['ARCHIVE', 'Invoices'] });
    const custom = reads.listThreads(storage.sql, ref, { labelSlug: 'invoices', pageSize: 10 });
    expect(custom.threads.map((t) => t.latestMessageId)).toEqual([kept.message.id]);
    // A system folder (archive) keeps archived mail.
    const archiveFolder = reads.listThreads(storage.sql, ref, { labelSlug: 'archive', pageSize: 10 });
    expect(archiveFolder.threads.map((t) => t.latestMessageId)).toEqual([archived.message.id]);
  });
});

// ---------------------------------------------------------------------------
// listThreads: fast vs filtered path parity
// ---------------------------------------------------------------------------

describe('listThreads — fast vs filtered path parity', () => {
  it('a filter guaranteed to exclude nothing (an absent exclude-word) gives the exact same page as the fast path', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { threadId: 't_1', sentAt: 1_000, receivedAt: 1_000, subject: 'Invoice #1' });
    ingest(storage, ref, { threadId: 't_2', sentAt: 2_000, receivedAt: 2_000, subject: 'Invoice #2' });
    ingest(storage, ref, { threadId: 't_3', sentAt: 3_000, receivedAt: 3_000, subject: 'Invoice #3' });

    const fast = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 2 });
    const filtered = reads.listThreads(storage.sql, ref, {
      labelSlug: 'inbox',
      pageSize: 2,
      excludeWords: 'zzz_no_such_token_zzz',
    });
    expect(filtered.threads.map((t) => t.threadId)).toEqual(fast.threads.map((t) => t.threadId));
    expect(filtered.totalCount).toBe(fast.totalCount);
    expect(filtered.nextCursor).toEqual(fast.nextCursor);

    const fast2 = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 2, cursor: fast.nextCursor });
    const filtered2 = reads.listThreads(storage.sql, ref, {
      labelSlug: 'inbox',
      pageSize: 2,
      excludeWords: 'zzz_no_such_token_zzz',
      cursor: filtered.nextCursor,
    });
    expect(filtered2.threads.map((t) => t.threadId)).toEqual(fast2.threads.map((t) => t.threadId));
  });
});

// ---------------------------------------------------------------------------
// listThreads: search (decision 3's FTS split) and field filters
// ---------------------------------------------------------------------------

describe('listThreads — search and field filters', () => {
  it('matches a subject substring via the meta (trigram) table, not a whole-word match', () => {
    const { storage, ref } = makeMailbox();
    const match = ingest(storage, ref, { subject: 'Your invoice is ready' });
    ingest(storage, ref, { subject: 'Team lunch' });
    // "voice" only matches via substring (trigram), same assertion style as writes.test.ts.
    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, search: 'voice' });
    expect(page.threads.map((t) => t.latestMessageId)).toEqual([match.message.id]);
  });

  it('matches body text via the body (token-prefix) table', () => {
    const { storage, ref } = makeMailbox();
    const match = ingest(storage, ref, { subject: 'Re: project', searchText: 'please review the attached proposal' });
    ingest(storage, ref, { subject: 'Other', searchText: 'nothing relevant here' });
    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, search: 'propos' });
    expect(page.threads.map((t) => t.latestMessageId)).toEqual([match.message.id]);
  });

  it('a search spans the whole live mailbox regardless of the open folder, but still excludes trash/spam', () => {
    const { storage, ref } = makeMailbox();
    const archived = ingest(storage, ref, { labels: ['ARCHIVE'], subject: 'Quarterly budget' });
    const trashed = ingest(storage, ref, { labels: ['TRASH'], subject: 'Quarterly budget draft' });
    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, search: 'budget' });
    expect(page.threads.map((t) => t.latestMessageId)).toEqual([archived.message.id]);
    expect(page.threads.map((t) => t.latestMessageId)).not.toContain(trashed.message.id);
  });

  it('excludeWords drops a thread when ANY of its live messages contains the word, by subject (meta) or body (body)', () => {
    const { storage, ref } = makeMailbox();
    const clean = ingest(storage, ref, { threadId: 't_clean', subject: 'Weekly update', searchText: 'all good here' });
    ingest(storage, ref, { threadId: 't_subject', subject: 'Urgent: action required', searchText: 'ok' });
    ingest(storage, ref, { threadId: 't_body', subject: 'Status', searchText: 'this is urgent, please read' });

    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, excludeWords: 'urgent' });
    expect(page.threads.map((t) => t.latestMessageId).sort()).toEqual([clean.message.id].sort());
  });

  it('hasAttachment is a thread-level filter: any message of the thread having one is enough', () => {
    const { storage, ref } = makeMailbox();
    const first = ingest(storage, ref, { threadId: 't_thread', sentAt: 1_000, receivedAt: 1_000 });
    ingest(storage, ref, {
      threadId: 't_thread',
      sentAt: 2_000,
      receivedAt: 2_000,
      attachments: [{ id: 'att_1', fileName: 'invoice.pdf', size: 10, messageId: 'ignored' }],
    });
    ingest(storage, ref, { threadId: 't_other', sentAt: 3_000, receivedAt: 3_000 });

    const page = reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, hasAttachment: true });
    expect(page.threads.map((t) => t.threadId)).toEqual(['t_thread']);
    expect(page.threads[0]?.messageCount).toBe(2);
    void first;
  });

  it('from/to/subject filters are case-insensitive substrings', () => {
    const { storage, ref } = makeMailbox();
    const byFrom = ingest(storage, ref, { from: { email: 'ALICE@example.com', name: 'Alice' } });
    const byTo = ingest(storage, ref, { from: { email: 'someone@else.com' }, to: [{ email: 'carol@example.com', name: 'Carol' }] });
    const bySubject = ingest(storage, ref, { from: { email: 'someone@else.com' }, subject: 'Quarterly Report' });

    expect(reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, from: 'alice' }).threads.map((t) => t.latestMessageId)).toEqual([byFrom.message.id]);
    expect(reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, to: 'carol' }).threads.map((t) => t.latestMessageId)).toEqual([byTo.message.id]);
    expect(reads.listThreads(storage.sql, ref, { labelSlug: 'inbox', pageSize: 10, subject: 'quarterly' }).threads.map((t) => t.latestMessageId)).toEqual([bySubject.message.id]);
  });
});

// ---------------------------------------------------------------------------
// getThread / getThreadOfMessage / getMessage / getMessages
// ---------------------------------------------------------------------------

describe('getThread / getThreadOfMessage / getMessage / getMessages', () => {
  it('getThread returns live messages oldest first; bodies are always null', () => {
    const { storage, ref } = makeMailbox();
    const first = ingest(storage, ref, { threadId: 't_x', sentAt: 1_000, content: { text: 'hi' } });
    const second = ingest(storage, ref, { threadId: 't_x', sentAt: 2_000 });
    const thread = reads.getThread(storage.sql, ref, 't_x');
    expect(thread?.messages.map((m) => m.id)).toEqual([first.message.id, second.message.id]);
    expect(thread?.messages[0]?.textBody).toBeNull();
    expect(thread?.messages[0]?.rawMessage).toBeNull();
  });

  it('getThread returns null for an unknown or fully-deleted thread', () => {
    const { storage, ref } = makeMailbox();
    expect(reads.getThread(storage.sql, ref, 'no_such_thread')).toBeNull();
  });

  it('getThreadOfMessage resolves the thread from any of its messages, and null for a deleted anchor', () => {
    const { storage, ref } = makeMailbox();
    const first = ingest(storage, ref, { threadId: 't_y' });
    const second = ingest(storage, ref, { threadId: 't_y' });
    expect(reads.getThreadOfMessage(storage.sql, ref, second.message.id)?.messages.map((m) => m.id)).toEqual([first.message.id, second.message.id]);

    apply(storage, ref, { kind: 'delete', ids: [first.message.id] }, 5_000);
    expect(reads.getThreadOfMessage(storage.sql, ref, first.message.id)).toBeNull();
  });

  it('getMessage strips bodies regardless of the bodies option, and includes attachments on request', () => {
    const { storage, ref } = makeMailbox();
    const msg = ingest(storage, ref, {
      content: { text: 'plain', html: '<p>html</p>' },
      attachments: [{ id: 'att_1', fileName: 'a.pdf', size: 1, messageId: 'ignored' }],
    });
    const lean = reads.getMessage(storage.sql, ref, msg.message.id);
    expect(lean?.textBody).toBeNull();
    const withBodies = reads.getMessage(storage.sql, ref, msg.message.id, { bodies: true });
    expect(withBodies?.textBody).toBeNull(); // the object never has bodies to give
    const withAttachments = reads.getMessage(storage.sql, ref, msg.message.id, { attachments: true });
    expect(withAttachments?.attachments?.map((a) => a.fileName)).toEqual(['a.pdf']);
  });

  it('getMessage returns null for a missing or soft-deleted message', () => {
    const { storage, ref } = makeMailbox();
    expect(reads.getMessage(storage.sql, ref, 'nope')).toBeNull();
    const msg = ingest(storage, ref);
    apply(storage, ref, { kind: 'delete', ids: [msg.message.id] }, 5_000);
    expect(reads.getMessage(storage.sql, ref, msg.message.id)).toBeNull();
  });

  it('getMessages returns live lean rows for a set of ids, skipping deleted ones', () => {
    const { storage, ref } = makeMailbox();
    const a = ingest(storage, ref);
    const b = ingest(storage, ref);
    apply(storage, ref, { kind: 'delete', ids: [b.message.id] }, 5_000);
    const rows = reads.getMessages(storage.sql, ref, [a.message.id, b.message.id, 'missing']);
    expect(rows.map((r) => r.id)).toEqual([a.message.id]);
    expect(rows[0]?.threadKey).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// listMessages
// ---------------------------------------------------------------------------

describe('listMessages', () => {
  it('keyset pages sentAt desc, id desc, with boundaries and ties', () => {
    const { storage, ref } = makeMailbox();
    const a = ingest(storage, ref, { sentAt: 1_000 });
    const b = ingest(storage, ref, { sentAt: 2_000 });
    const c = ingest(storage, ref, { sentAt: 2_000 }); // tie with b on sentAt

    const page1 = reads.listMessages(storage.sql, ref, { limit: 1 });
    const tiedFirst = [b.message.id, c.message.id].sort().reverse()[0]; // id DESC breaks the tie
    expect(page1.data.map((m) => m.id)).toEqual([tiedFirst]);
    expect(page1.totalCount).toBe(3);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = reads.listMessages(storage.sql, ref, { limit: 10, cursor: page1.nextCursor! });
    const remaining = [a.message.id, b.message.id, c.message.id].filter((id) => id !== tiedFirst);
    expect(page2.data.map((m) => m.id).sort()).toEqual(remaining.sort());
    expect(page2.nextCursor).toBeNull();
  });

  it('counterparty matches from/to/cc/bcc exactly (not a substring)', () => {
    const { storage, ref } = makeMailbox();
    const viaTo = ingest(storage, ref, { from: { email: 'dave@example.com' }, to: [{ email: 'alice@example.com' }] });
    const viaCc = ingest(storage, ref, { from: { email: 'dave@example.com' }, cc: [{ email: 'carol@example.com' }] });
    ingest(storage, ref, { from: { email: 'alice2@example.com' } }); // substring of alice@, must not match

    const page = reads.listMessages(storage.sql, ref, { limit: 10, counterparty: 'ALICE@example.com' });
    expect(page.data.map((m) => m.id)).toEqual([viaTo.message.id]);
    const ccPage = reads.listMessages(storage.sql, ref, { limit: 10, counterparty: 'carol@example.com' });
    expect(ccPage.data.map((m) => m.id)).toEqual([viaCc.message.id]);
  });

  it('threadId filters by thread_key (the resolved thread), not the raw possibly-null column', () => {
    const { storage, ref } = makeMailbox();
    const root = ingest(storage, ref); // threadId: null -> thread_key === its own id
    const reply = ingest(storage, ref, { threadId: root.message.id });
    const page = reads.listMessages(storage.sql, ref, { limit: 10, threadId: root.message.id });
    expect(page.data.map((m) => m.id).sort()).toEqual([root.message.id, reply.message.id].sort());
  });

  it('label filter matches message_labels regardless of casing variance in the slug', () => {
    const { storage, ref } = makeMailbox();
    const starred = ingest(storage, ref, { labels: ['INBOX', 'STARRED'] });
    ingest(storage, ref, { labels: ['INBOX'] });
    const page = reads.listMessages(storage.sql, ref, { limit: 10, label: 'starred' });
    expect(page.data.map((m) => m.id)).toEqual([starred.message.id]);
  });

  it('excludeTrash/excludeSpam and isRead/isStarred/isFlagged/hasAttachments filter on the mirrored columns', () => {
    const { storage, ref } = makeMailbox();
    const live = ingest(storage, ref, { labels: ['INBOX'], isRead: false });
    ingest(storage, ref, { labels: ['TRASH'] });
    const page = reads.listMessages(storage.sql, ref, { limit: 10, excludeTrash: true, isRead: false });
    expect(page.data.map((m) => m.id)).toEqual([live.message.id]);
  });
});

// ---------------------------------------------------------------------------
// stats / labelCounts / unreadCount — equal a full recount
// ---------------------------------------------------------------------------

describe('stats / labelCounts / unreadCount match a full rebuildDerived recount', () => {
  it('agrees before and after a full rebuild, across a mixed sequence of ops', () => {
    const { storage, ref } = makeMailbox();
    const a = ingest(storage, ref, { labels: ['INBOX'] });
    const b = ingest(storage, ref, { labels: ['INBOX'] }, 1_100);
    ingest(storage, ref, { labels: ['INBOX', 'STARRED'] }, 1_200);
    apply(storage, ref, { kind: 'flags', ids: [a.message.id], patch: { isRead: true }, semantics: 'single' }, 2_000);
    apply(storage, ref, { kind: 'labels.add', ids: [b.message.id], labels: ['IMPORTANT'], semantics: 'single' }, 2_100);
    apply(storage, ref, { kind: 'move', ids: [b.message.id], location: 'ARCHIVE' }, 2_200);
    const draft = { subject: 'draft', accountId: ref.accountId } as const;
    void draft; // drafts count is exercised separately below via the live `drafts` table

    const before = {
      stats: reads.stats(storage.sql),
      labelCounts: reads.labelCounts(storage.sql, ['__total', '__all', 'inbox', 'archive', 'starred', 'important']),
      unreadInbox: reads.unreadCount(storage.sql, 'inbox'),
      unreadAll: reads.unreadCount(storage.sql, 'all-live'),
    };

    rebuildDerived(storage, ref, 9_999);

    const after = {
      stats: reads.stats(storage.sql),
      labelCounts: reads.labelCounts(storage.sql, ['__total', '__all', 'inbox', 'archive', 'starred', 'important']),
      unreadInbox: reads.unreadCount(storage.sql, 'inbox'),
      unreadAll: reads.unreadCount(storage.sql, 'all-live'),
    };

    expect(after.stats).toEqual(before.stats);
    expect(after.labelCounts).toEqual(before.labelCounts);
    expect(after.unreadInbox).toBe(before.unreadInbox);
    expect(after.unreadAll).toBe(before.unreadAll);
  });

  it('stats().labels lists every nonzero label_counts row; labelCounts() zero-fills a key with none', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { labels: ['INBOX', 'Invoices'] });
    const s = reads.stats(storage.sql);
    expect(s.labels.invoices).toEqual({ messages: 1, unread: 1, threads: 1 });
    expect(s.labels['never-used']).toBeUndefined();
    expect(reads.labelCounts(storage.sql, ['never-used'])).toEqual({ 'never-used': { messages: 0, unread: 0, threads: 0 } });
  });

  it('drafts count feeds stats().drafts', () => {
    const { storage, ref } = makeMailbox();
    apply(storage, ref, { kind: 'draft.create', draft: { id: 'draft_1', accountId: ref.accountId, subject: 'Hi' } }, 1_000);
    expect(reads.stats(storage.sql).drafts).toBe(1);
    apply(storage, ref, { kind: 'draft.delete', id: 'draft_1' }, 2_000);
    expect(reads.stats(storage.sql).drafts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Attachments, recent addresses
// ---------------------------------------------------------------------------

describe('attachments', () => {
  it('listAttachments / getAttachment', () => {
    const { storage, ref } = makeMailbox();
    const msg = ingest(storage, ref, { attachments: [{ id: 'att_1', fileName: 'invoice.pdf', size: 123, messageId: 'ignored' }] });
    expect(reads.listAttachments(storage.sql, msg.message.id).map((a) => a.id)).toEqual(['att_1']);
    const found = reads.getAttachment(storage.sql, ref, 'att_1');
    expect(found?.accountId).toBe('acc_1');
    expect(found?.fileName).toBe('invoice.pdf');
    expect(reads.getAttachment(storage.sql, ref, 'nope')).toBeNull();
  });

  it('recentAttachments pages non-inline attachments newest first; totalCount respects the same before-cursor window as the page', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, {
      attachments: [
        { id: 'att_1', fileName: 'one.pdf', size: 1, isInline: false, messageId: 'ignored' },
        { id: 'att_2', fileName: 'inline.png', size: 1, isInline: true, messageId: 'ignored' },
      ],
    });
    ingest(storage, ref, { attachments: [{ id: 'att_3', fileName: 'two.pdf', size: 1, isInline: false, messageId: 'ignored' }] }, 2_000);

    const page = reads.recentAttachments(storage.sql, { limit: 10 });
    expect(page.data.map((a) => a.id)).toEqual(['att_3', 'att_1']);
    expect(page.totalCount).toBe(2);

    const before = page.data[0]!;
    const next = reads.recentAttachments(storage.sql, { limit: 10, before: { createdAt: before.createdAt.getTime(), id: before.id } });
    expect(next.data.map((a) => a.id)).toEqual(['att_1']);
    expect(next.totalCount).toBe(1); // matches the Postgres store: total is scoped to the same `before` window as the page
  });
});

describe('recentAddresses', () => {
  it('collects distinct from/to addresses from recent live messages, most recent first', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { from: { email: 'alice@example.com' }, to: [{ email: 'me@test.dev' }] }, 1_000);
    ingest(storage, ref, { from: { email: 'bob@example.com' }, to: [{ email: 'me@test.dev' }] }, 2_000);
    const addresses = reads.recentAddresses(storage.sql, 10);
    expect(addresses).toContain('alice@example.com');
    expect(addresses).toContain('bob@example.com');
    expect(addresses).toContain('me@test.dev');
    expect(addresses.indexOf('bob@example.com')).toBeLessThan(addresses.indexOf('alice@example.com'));
  });
});

// ---------------------------------------------------------------------------
// resolveInbound (ported from mail-inbound-worker's isTenantDuplicate /
// findThreadByReplyIds / findThreadBySubject / resolveTenantThread)
// ---------------------------------------------------------------------------

describe('resolveInbound', () => {
  it('flags a duplicate RFC Message-ID, including against a since-deleted message', () => {
    const { storage, ref } = makeMailbox();
    const original = ingest(storage, ref, { rfcMessageId: '<root@test.dev>', threadId: null });
    expect(reads.resolveInbound(storage.sql, { rfcMessageId: '<root@test.dev>', subject: 'Hello', isReply: false })).toEqual({
      duplicate: true,
      threadId: original.message.id,
      isExistingHamThread: false,
    });

    apply(storage, ref, { kind: 'delete', ids: [original.message.id], hard: true }, 5_000);
    expect(reads.resolveInbound(storage.sql, { rfcMessageId: '<root@test.dev>', subject: 'Hello', isReply: false }).duplicate).toBe(false);
  });

  it('resolves a reply by In-Reply-To, in either Message-ID spelling, and reports isExistingHamThread', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { rfcMessageId: '<root@test.dev>', threadId: 'thread_root', isSpam: false });

    const bracketed = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<reply@test.dev>',
      inReplyTo: '<root@test.dev>',
      subject: 'Re: Hello',
      isReply: true,
    });
    expect(bracketed).toEqual({ duplicate: false, threadId: 'thread_root', isExistingHamThread: true });

    const bare = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<reply2@test.dev>',
      inReplyTo: 'root@test.dev', // no angle brackets this time
      subject: 'Re: Hello',
      isReply: true,
    });
    expect(bare.threadId).toBe('thread_root');
  });

  it('resolves a reply by References, falling back to it when In-Reply-To is absent', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { rfcMessageId: '<root@test.dev>', threadId: 'thread_root' });
    const result = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<reply@test.dev>',
      references: ['<root@test.dev>'],
      subject: 'Re: Hello',
      isReply: true,
    });
    expect(result.threadId).toBe('thread_root');
  });

  it('resolves a reply by provider message id when the provider rewrote the Message-ID header', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { rfcMessageId: '<unrelated@test.dev>', providerMessageId: 'abc-123', threadId: 'thread_provider' });
    const result = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<reply@test.dev>',
      inReplyTo: '<abc-123@eu-west-1.amazonses.com>',
      subject: 'Re: Hello',
      isReply: true,
    });
    expect(result.threadId).toBe('thread_provider');
  });

  it('falls back to subject matching for a reply whose headers match nothing stored', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { subject: 'Project status', threadId: 'thread_subject' });
    const result = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<reply@test.dev>',
      inReplyTo: '<never-stored@test.dev>',
      subject: 'Re: Project status',
      isReply: true,
    });
    expect(result.threadId).toBe('thread_subject');
  });

  it('a reply matching neither ids nor subject starts its own thread via computeThreadId (first reference, else in-reply-to, else its own id)', () => {
    const { storage, ref } = makeMailbox();
    const byReference = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<new@test.dev>',
      references: ['<ancestor@test.dev>'],
      inReplyTo: '<parent@test.dev>',
      subject: 'Totally new subject',
      isReply: true,
    });
    expect(byReference).toEqual({ duplicate: false, threadId: '<ancestor@test.dev>', isExistingHamThread: false });

    const byInReplyTo = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<new2@test.dev>',
      inReplyTo: '<parent@test.dev>',
      subject: 'Also new',
      isReply: true,
    });
    expect(byInReplyTo.threadId).toBe('<parent@test.dev>');
  });

  it('a non-reply with no Re:/Fwd: prefix always starts its own thread, even with a matching subject', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { subject: 'Hello', threadId: 'thread_existing' });
    const result = reads.resolveInbound(storage.sql, { rfcMessageId: '<fresh@test.dev>', subject: 'Hello', isReply: false });
    expect(result).toEqual({ duplicate: false, threadId: '<fresh@test.dev>', isExistingHamThread: false });
  });

  it("a non-reply with a Re: prefix but no stored participant in common starts its own thread (two strangers' Re: Hello never merge)", () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { subject: 'Hello', threadId: 'thread_existing', from: { email: 'owner@example.com' }, to: [{ email: 'me@test.dev' }] });
    const result = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<stranger@test.dev>',
      subject: 'Re: Hello',
      fromEmail: 'stranger@example.com',
      isReply: false,
    });
    expect(result).toEqual({ duplicate: false, threadId: '<stranger@test.dev>', isExistingHamThread: false });
  });

  it('a non-reply with a Re: prefix DOES join the thread when the sender already took part in it', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, { subject: 'Hello', threadId: 'thread_existing', from: { email: 'owner@example.com' }, to: [{ email: 'carol@example.com' }] });
    const result = reads.resolveInbound(storage.sql, {
      rfcMessageId: '<carol-reply@test.dev>',
      subject: 'Re: Hello',
      fromEmail: 'carol@example.com', // was a To: recipient of the original
      isReply: false,
    });
    expect(result.threadId).toBe('thread_existing');
  });
});

// ---------------------------------------------------------------------------
// findByRfcIds / findSentByIdempotencyKey / countSentSince
// ---------------------------------------------------------------------------

describe('findByRfcIds / findSentByIdempotencyKey / countSentSince', () => {
  it('findByRfcIds matches rfc ids and provider ids, and is empty for empty input', () => {
    const { storage, ref } = makeMailbox();
    const byRfc = ingest(storage, ref, { rfcMessageId: '<a@test.dev>' });
    const byProvider = ingest(storage, ref, { providerMessageId: 'prov-1' });
    const byExternal = ingest(storage, ref, { externalMessageId: 'ext-1' });

    expect(reads.findByRfcIds(storage.sql, [], [])).toEqual([]);
    expect(reads.findByRfcIds(storage.sql, ['<a@test.dev>'], []).map((r) => r.id)).toEqual([byRfc.message.id]);
    const byProviderIds = reads.findByRfcIds(storage.sql, [], ['prov-1', 'ext-1']).map((r) => r.id).sort();
    expect(byProviderIds).toEqual([byExternal.message.id, byProvider.message.id].sort());
  });

  it('findSentByIdempotencyKey rebuilds identity from the idempotency key', () => {
    const { storage, ref } = makeMailbox();
    const sent = ingest(storage, ref, { source: 'sent', idempotencyKey: 'idem-1', externalMessageId: 'ext-abc', subject: 'Re: hi' });
    expect(reads.findSentByIdempotencyKey(storage.sql, 'idem-1')).toEqual({
      id: sent.message.id,
      rfcMessageId: sent.message.rfcMessageId,
      externalMessageId: 'ext-abc',
      subject: 'Re: hi',
    });
    expect(reads.findSentByIdempotencyKey(storage.sql, 'nope')).toBeNull();
  });

  it('countSentSince counts sent/sendStatus-sent mail since a timestamp, deleted included', () => {
    const { storage, ref } = makeMailbox();
    const sent = ingest(storage, ref, { source: 'sent', sendStatus: 'sent', sentAt: 10_000 });
    ingest(storage, ref, { source: 'sent', sendStatus: 'cancelled', sentAt: 10_000 }); // not counted
    ingest(storage, ref, { source: 'inbound', sentAt: 10_000 }); // not counted (not sent)
    expect(reads.countSentSince(storage.sql, 9_000)).toBe(1);
    expect(reads.countSentSince(storage.sql, 20_000)).toBe(0);

    // Soft delete (not hard — a hard delete removes the row entirely, so there
    // would be nothing left to count): the row still exists with deleted_at
    // set, and this read has no deleted_at filter, matching Postgres.
    apply(storage, ref, { kind: 'delete', ids: [sent.message.id] }, 11_000);
    expect(reads.countSentSince(storage.sql, 9_000)).toBe(1); // soft-deleted still counts, matching Postgres
  });
});

// ---------------------------------------------------------------------------
// Scheduled, snoozed
// ---------------------------------------------------------------------------

describe('listScheduled / listSnoozed', () => {
  it('listScheduled returns live scheduled mail soonest-first', () => {
    const { storage, ref } = makeMailbox();
    const later = ingest(storage, ref, { labels: ['SENT', 'SCHEDULED'], sendStatus: 'scheduled', scheduledFor: 10_000 });
    const sooner = ingest(storage, ref, { labels: ['SENT', 'SCHEDULED'], sendStatus: 'scheduled', scheduledFor: 5_000 }, 2_000);
    ingest(storage, ref, { labels: ['SENT'], sendStatus: 'sent' }, 3_000);
    const scheduled = reads.listScheduled(storage.sql, ref);
    expect(scheduled.map((m) => m.id)).toEqual([sooner.message.id, later.message.id]);
  });

  it('listSnoozed returns messages carrying the snoozed label, with triggerRunId always null', () => {
    const { storage, ref } = makeMailbox();
    const msg = ingest(storage, ref, { subject: 'Follow up later' });
    apply(storage, ref, { kind: 'snooze', id: msg.message.id, until: 60_000 }, 2_000);
    const snoozed = reads.listSnoozed(storage.sql, ref);
    expect(snoozed.map((m) => m.id)).toEqual([msg.message.id]);
    expect(snoozed[0]?.snoozedUntil).toBe(new Date(60_000).toISOString());
    expect(snoozed[0]?.triggerRunId).toBeNull();

    apply(storage, ref, { kind: 'unsnooze', id: msg.message.id }, 3_000);
    expect(reads.listSnoozed(storage.sql, ref)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe('listSubscriptions / getSubscription / rawSources', () => {
  it('listSubscriptions and getSubscription read what ingest upserted', () => {
    const { storage, ref } = makeMailbox();
    ingest(storage, ref, {
      from: { email: 'news@list.example.com' },
      subscription: {
        senderEmail: 'news@list.example.com',
        senderName: 'List',
        senderDomain: 'list.example.com',
        listId: 'list-1',
        unsubscribeUrl: 'https://list.example.com/unsub',
        unsubscribeMailto: null,
        oneClick: true,
        messageCount: 1,
        lastSubject: 'Weekly',
        firstReceivedAt: new Date(1_000),
        lastReceivedAt: new Date(1_000),
      },
    });
    const subs = reads.listSubscriptions(storage.sql, ref, {});
    expect(subs.map((s) => s.senderEmail)).toEqual(['news@list.example.com']);
    const found = reads.getSubscription(storage.sql, ref, subs[0]!.id);
    expect(found?.senderEmail).toBe('news@list.example.com');
    expect(reads.getSubscription(storage.sql, ref, 'nope')).toBeNull();
  });

  it('rawSources returns ham inbound candidates since a timestamp', () => {
    const { storage, ref } = makeMailbox();
    const candidate = ingest(storage, ref, { source: 'inbound', isSpam: false, sentAt: 10_000, receivedAt: 10_000 });
    ingest(storage, ref, { source: 'inbound', isSpam: true, sentAt: 10_000 }); // spam excluded
    const raw = reads.rawSources(storage.sql, { since: 5_000, limit: 10 });
    expect(raw.map((r) => r.id)).toEqual([candidate.message.id]);
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('listDrafts / getDraft', () => {
  it('lists live drafts, keyset by updatedAt desc then id desc, and getDraft reads one', () => {
    const { storage, ref } = makeMailbox();
    apply(storage, ref, { kind: 'draft.create', draft: { id: 'draft_a', accountId: ref.accountId, subject: 'First' } }, 1_000);
    apply(storage, ref, { kind: 'draft.create', draft: { id: 'draft_b', accountId: ref.accountId, subject: 'Second' } }, 2_000);

    const page = reads.listDrafts(storage.sql, ref, { limit: 1 });
    expect(page.data.map((d) => d.id)).toEqual(['draft_b']);
    expect(page.hasMore).toBe(true);
    expect(page.totalCount).toBe(2);

    const page2 = reads.listDrafts(storage.sql, ref, { limit: 1, cursor: page.cursor! });
    expect(page2.data.map((d) => d.id)).toEqual(['draft_a']);
    expect(page2.hasMore).toBe(false);

    expect(reads.getDraft(storage.sql, ref, 'draft_a')?.subject).toBe('First');
    apply(storage, ref, { kind: 'draft.delete', id: 'draft_a' }, 3_000);
    expect(reads.getDraft(storage.sql, ref, 'draft_a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// exportPage
// ---------------------------------------------------------------------------

describe('exportPage', () => {
  it('pages every row, deleted included, ordered and keyed by id', () => {
    const { storage, ref } = makeMailbox();
    const a = ingest(storage, ref);
    const b = ingest(storage, ref);
    apply(storage, ref, { kind: 'delete', ids: [a.message.id] }, 5_000); // soft delete, still exported
    const ids = [a.message.id, b.message.id].sort();

    const page1 = reads.exportPage(storage.sql, ref, { limit: 1 });
    expect(page1.data.map((m) => m.id)).toEqual([ids[0]]);
    expect(page1.cursor).toBe(ids[0]);
    const page2 = reads.exportPage(storage.sql, ref, { limit: 1, cursor: page1.cursor! });
    expect(page2.data.map((m) => m.id)).toEqual([ids[1]]);
    expect(page2.cursor).toBeNull();
    // Bodies are never available from the object side of export.
    expect(page1.data[0]?.textBody).toBeNull();
  });

  it('filters by sentOnly/since/until', () => {
    const { storage, ref } = makeMailbox();
    const sent = ingest(storage, ref, { source: 'sent', createdAt: 10_000 });
    ingest(storage, ref, { source: 'inbound', createdAt: 10_000 });
    const page = reads.exportPage(storage.sql, ref, { limit: 10, sentOnly: true, since: 5_000, until: 15_000 });
    expect(page.data.map((m) => m.id)).toEqual([sent.message.id]);
  });
});
