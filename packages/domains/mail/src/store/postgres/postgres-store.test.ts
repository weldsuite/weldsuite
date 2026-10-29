/**
 * pglite-backed contract tests for the Postgres mailbox store (design task
 * B4): every `MailboxStore`/`WorkspaceMailStore` method gets at least one
 * assertion against seeded data, plus the write ops `apply()` dispatches.
 * These are new tests (the "no behaviour change" contract for *existing*
 * routes is covered by the untouched pglite suites elsewhere in this
 * package); this file is what checks the new abstraction itself.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

import { PostgresMailboxStore } from './mailbox-store';
import { PostgresWorkspaceMailStore } from './workspace-store';
import { createMailLabel } from '../../labels';

const { mailAccounts, mailAttachments, mailDrafts, mailMessages, mailSubscriptions } = schema;

let db: Database;

async function seedAccount(name = 'Test'): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name, email: `${id}@test.dev`, isShared: true });
  return id;
}

async function seedMessage(
  accountId: string,
  labels: string[],
  extra: Partial<typeof mailMessages.$inferInsert> = {},
): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: extra.threadId ?? `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Store test',
    sentDate: new Date(),
    labels,
    ...extra,
  });
  return id;
}

function store(accountId: string): PostgresMailboxStore {
  return new PostgresMailboxStore(db, { workspaceId: 'ws_test', accountId, clerkOrgId: 'org_test' });
}

function workspaceStore(): PostgresWorkspaceMailStore {
  return new PostgresWorkspaceMailStore(db, 'ws_test', 'org_test');
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

// ---------------------------------------------------------------------------
// MailboxStore reads
// ---------------------------------------------------------------------------

describe('PostgresMailboxStore reads', () => {
  it('listThreads pages by offset and by cursor, newest first', async () => {
    const accountId = await seedAccount();
    const day = (n: number) => new Date(Date.UTC(2026, 9, n));
    const older = await seedMessage(accountId, ['INBOX'], { threadId: 't_older', sentDate: day(1) });
    const newer = await seedMessage(accountId, ['INBOX'], { threadId: 't_newer', sentDate: day(2) });

    const s = store(accountId);
    const page1 = await s.listThreads({ labelSlug: 'inbox', pageSize: 1 });
    expect(page1.threads.map((t) => t.latestMessageId)).toEqual([newer]);
    expect(page1.totalCount).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await s.listThreads({ labelSlug: 'inbox', pageSize: 1, cursor: page1.nextCursor });
    expect(page2.threads.map((t) => t.latestMessageId)).toEqual([older]);
    expect(page2.nextCursor).toBeNull();
  });

  it('a full page of the maximum size still reports the next page', async () => {
    // The look-ahead row is added after the 100-row clamp, not swallowed by it.
    const accountId = await seedAccount();
    await db.insert(mailMessages).values(
      Array.from({ length: 101 }, (_, i) => {
        const id = generateId('mmsg');
        return {
          id,
          accountId,
          threadId: `t_max_${i}`,
          messageId: `<${id}@test.dev>`,
          from: { email: 'sender@example.com', name: 'Sender' },
          to: [{ email: 'me@test.dev' }],
          subject: 'Store test',
          sentDate: new Date(Date.UTC(2026, 9, 1, 0, i)),
          labels: ['INBOX'],
        };
      }),
    );

    const page1 = await store(accountId).listThreads({ labelSlug: 'inbox', pageSize: 100 });
    expect(page1.threads).toHaveLength(100);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await store(accountId).listThreads({ labelSlug: 'inbox', pageSize: 100, cursor: page1.nextCursor });
    expect(page2.threads).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const unified = await workspaceStore().listThreads([accountId], { labelSlug: 'inbox', pageSize: 100 });
    expect(unified.threads).toHaveLength(100);
    expect(unified.nextCursor).not.toBeNull();
  });

  it('getThread returns the thread by key with full bodies', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { threadId: 'thread_x', textBody: 'hello body' });
    const thread = await store(accountId).getThread('thread_x');
    expect(thread?.messages.map((m) => m.id)).toEqual([id]);
    expect(thread?.messages[0]?.textBody).toBe('hello body');
    expect(thread?.messages[0]?.rawMessage).toBeNull();
  });

  it('getThreadOfMessage resolves the thread from a message id', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const thread = await store(accountId).getThreadOfMessage(id);
    expect(thread?.messages.map((m) => m.id)).toEqual([id]);
  });

  it('getMessage strips bodies by default and includes them on request', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { textBody: 'plain', htmlBody: '<p>html</p>' });
    const lean = await store(accountId).getMessage(id);
    expect(lean?.textBody).toBeUndefined();
    const withBodies = await store(accountId).getMessage(id, { bodies: true });
    expect(withBodies?.textBody).toBe('plain');
    expect(withBodies?.htmlBody).toBe('<p>html</p>');
  });

  it('getMessage returns null for a message in another mailbox', async () => {
    const accountId = await seedAccount();
    const otherAccountId = await seedAccount();
    const id = await seedMessage(otherAccountId, ['INBOX']);
    expect(await store(accountId).getMessage(id)).toBeNull();
  });

  it('getMessage(o.attachments) includes attachment rows', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { hasAttachments: true });
    await db.insert(mailAttachments).values({ id: generateId('attach'), messageId: id, fileName: 'a.pdf', size: 10 });
    const withAttachments = await store(accountId).getMessage(id, { attachments: true });
    expect(withAttachments?.attachments?.map((a) => a.fileName)).toEqual(['a.pdf']);
  });

  it('getMessages returns live lean rows for a set of ids, scoped to the mailbox', async () => {
    const accountId = await seedAccount();
    const otherAccountId = await seedAccount();
    const mine = await seedMessage(accountId, ['INBOX']);
    const theirs = await seedMessage(otherAccountId, ['INBOX']);
    const rows = await store(accountId).getMessages([mine, theirs]);
    expect(rows.map((r) => r.id)).toEqual([mine]);
    expect(rows[0]?.threadKey).toBeDefined();
  });

  it('listMessages supports the exact-address counterparty filter and keyset paging', async () => {
    const accountId = await seedAccount();
    const match = await seedMessage(accountId, ['INBOX'], { from: { email: 'alice@example.com' } });
    await seedMessage(accountId, ['INBOX'], { from: { email: 'bob@example.com' } });

    const page = await store(accountId).listMessages({ limit: 10, counterparty: 'ALICE@example.com' });
    expect(page.data.map((m) => m.id)).toEqual([match]);
  });

  it('stats reports the base counters plus a label count map', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['INBOX', 'STARRED'], { isStarred: true, isRead: true });
    await createMailLabel(db, { accountId, name: 'Invoices' });
    const s = await store(accountId).stats();
    expect(s.total).toBe(2);
    expect(s.labels.inbox).toEqual({ messages: 2, unread: 1, threads: 2 });
    expect(s.labels.starred).toEqual({ messages: 1, unread: 0, threads: 1 });
    expect(s.labels.invoices).toEqual({ messages: 0, unread: 0, threads: 0 });
  });

  it('unreadCount counts inbox and all-live separately', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['ARCHIVE']);
    await seedMessage(accountId, ['TRASH']);
    const s = store(accountId);
    expect(await s.unreadCount('inbox')).toBe(1);
    expect(await s.unreadCount('all-live')).toBe(2);
  });

  it('labelCounts answers an arbitrary set of folder keys in one call', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['ARCHIVE']);
    const counts = await store(accountId).labelCounts(['inbox', 'archive', '__all']);
    expect(counts.inbox?.messages).toBe(1);
    expect(counts.archive?.messages).toBe(1);
    expect(counts.__all?.messages).toBe(2);
  });

  it('listAttachments / getAttachment', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { hasAttachments: true });
    const attachmentId = generateId('attach');
    await db.insert(mailAttachments).values({ id: attachmentId, messageId: id, fileName: 'invoice.pdf', size: 123 });
    const s = store(accountId);
    expect((await s.listAttachments(id)).map((a) => a.id)).toEqual([attachmentId]);
    const found = await s.getAttachment(attachmentId);
    expect(found?.accountId).toBe(accountId);
    expect(await store(await seedAccount()).getAttachment(attachmentId)).toBeNull();
  });

  it('recentAttachments pages non-inline attachments newest first', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { hasAttachments: true });
    await db.insert(mailAttachments).values([
      { id: generateId('attach'), messageId: id, fileName: 'one.pdf', size: 1, isInline: false },
      { id: generateId('attach'), messageId: id, fileName: 'inline.png', size: 1, isInline: true },
    ]);
    const { data, totalCount } = await store(accountId).recentAttachments({ limit: 10 });
    expect(totalCount).toBe(1);
    expect(data.map((a) => a.fileName)).toEqual(['one.pdf']);
  });

  it('recentAddresses collects distinct from/to addresses, most recent mailbox activity', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX'], {
      from: { email: 'alice@example.com' },
      to: [{ email: 'me@test.dev' }],
    });
    const addresses = await store(accountId).recentAddresses(10);
    expect(addresses).toContain('alice@example.com');
    expect(addresses).toContain('me@test.dev');
  });

  it('resolveInbound finds a reply thread by In-Reply-To and flags a duplicate RFC id', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX'], { messageId: '<root@test.dev>', threadId: 'thread_root' });
    const s = store(accountId);

    const reply = await s.resolveInbound({
      rfcMessageId: '<reply@test.dev>',
      inReplyTo: '<root@test.dev>',
      subject: 'Re: Hello',
      isReply: true,
    });
    expect(reply).toEqual({ duplicate: false, threadId: 'thread_root', isExistingHamThread: true });

    const dup = await s.resolveInbound({
      rfcMessageId: '<root@test.dev>',
      subject: 'Hello',
      isReply: false,
    });
    expect(dup.duplicate).toBe(true);
  });

  it('findByRfcIds / findSentByIdempotencyKey / countSentSince', async () => {
    const accountId = await seedAccount();
    const since = Date.now() - 60_000;
    await seedMessage(accountId, ['SENT'], {
      source: 'sent',
      sendStatus: 'sent',
      idempotencyKey: 'idem-1',
      sentDate: new Date(),
    });
    const s = store(accountId);
    expect(await s.countSentSince(since)).toBe(1);
    const byIdem = await s.findSentByIdempotencyKey('idem-1');
    expect(byIdem).not.toBeNull();
    const byRfc = await s.findByRfcIds([byIdem!.rfcMessageId], []);
    expect(byRfc.map((r) => r.id)).toEqual([byIdem!.id]);
  });

  it('listScheduled / listSnoozed', async () => {
    const accountId = await seedAccount();
    const scheduled = await seedMessage(accountId, ['SENT', 'SCHEDULED'], {
      sendStatus: 'scheduled',
      scheduledFor: new Date(Date.now() + 60_000),
    });
    const snoozed = await seedMessage(accountId, ['SNOOZED'], { snoozedUntil: new Date(Date.now() + 60_000) });
    const s = store(accountId);
    expect((await s.listScheduled()).map((m) => m.id)).toEqual([scheduled]);
    expect((await s.listSnoozed()).map((m) => m.id)).toEqual([snoozed]);
  });

  it('listSubscriptions / getSubscription / rawSources', async () => {
    const accountId = await seedAccount();
    const subId = generateId('msub');
    await db.insert(mailSubscriptions).values({
      id: subId,
      accountId,
      senderEmail: 'news@example.com',
      messageCount: 1,
      firstReceivedAt: new Date(),
      lastReceivedAt: new Date(),
    });
    await seedMessage(accountId, ['INBOX'], { source: 'inbound', isSpam: false, from: { email: 'news@example.com' } });

    const s = store(accountId);
    expect((await s.listSubscriptions({})).map((r) => r.id)).toEqual([subId]);
    expect((await s.getSubscription(subId))?.senderEmail).toBe('news@example.com');
    const raw = await s.rawSources({ since: Date.now() - 60_000, limit: 10 });
    expect(raw).toHaveLength(1);
  });

  it('listDrafts / getDraft', async () => {
    const accountId = await seedAccount();
    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId, subject: 'Draft subject' });
    const s = store(accountId);
    expect((await s.listDrafts({ limit: 10 })).data.map((d) => d.id)).toEqual([draftId]);
    expect((await s.getDraft(draftId))?.subject).toBe('Draft subject');
    expect(await store(await seedAccount()).getDraft(draftId)).toBeNull();
  });

  it('exportPage pages every row (deleted included) by id', async () => {
    const accountId = await seedAccount();
    const a = await seedMessage(accountId, ['INBOX']);
    const b = await seedMessage(accountId, ['INBOX']);
    const ids = [a, b].sort();
    const page1 = await store(accountId).exportPage({ limit: 1 });
    expect(page1.data.map((m) => m.id)).toEqual([ids[0]]);
    expect(page1.cursor).toBe(ids[0]);
    const page2 = await store(accountId).exportPage({ limit: 1, cursor: page1.cursor! });
    expect(page2.data.map((m) => m.id)).toEqual([ids[1]]);
    expect(page2.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MailboxStore writes (apply/applyBatch)
// ---------------------------------------------------------------------------

describe('PostgresMailboxStore.apply', () => {
  it('ingest creates a message once and is idempotent on replay', async () => {
    const accountId = await seedAccount();
    const s = store(accountId);
    const op = {
      kind: 'ingest' as const,
      message: {
        id: generateId('mmsg'),
        source: 'inbound' as const,
        rfcMessageId: '<new@test.dev>',
        threadId: null,
        from: { email: 'sender@example.com' },
        to: [{ email: 'me@test.dev' }],
        subject: 'Ingested',
        preview: 'preview',
        sentAt: Date.now(),
        receivedAt: Date.now(),
        createdAt: Date.now(),
        isRead: false,
        labels: ['INBOX'],
        isSpam: false,
        isReply: false,
        attachments: [],
      },
    };
    const first = await s.apply(op);
    expect(first.ingest?.created).toBe(true);
    expect(first.applied).toEqual([op.message.id]);

    const replay = await s.apply(op);
    expect(replay.ingest?.created).toBe(false);
    expect(replay.ingest?.id).toBe(op.message.id);

    const row = await s.getMessage(op.message.id, { bodies: true });
    expect(row?.subject).toBe('Ingested');
  });

  it('flags: single semantics updates one message and syncs labels', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    const result = await s.apply({ kind: 'flags', ids: [id], patch: { isStarred: true }, semantics: 'single' });
    expect(result.applied).toEqual([id]);
    const row = await s.getMessage(id);
    expect(row?.labels).toContain('STARRED');
    expect(row?.isStarred).toBe(true);
  });

  it('flags: bulk semantics marks read and reports missing ids', async () => {
    const accountId = await seedAccount();
    const a = await seedMessage(accountId, ['INBOX']);
    const b = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    const result = await s.apply({
      kind: 'flags',
      ids: [a, b, 'nonexistent'],
      patch: { isRead: true },
      semantics: 'bulk',
    });
    expect(new Set(result.applied)).toEqual(new Set([a, b]));
    expect(result.missing).toEqual(['nonexistent']);
  });

  it('labels.set replaces the full label array', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX', 'STARRED'], { isStarred: true });
    const s = store(accountId);
    const result = await s.apply({ kind: 'labels.set', id, labels: ['INBOX', 'IMPORTANT'] });
    expect(result.labels?.[id]).toEqual(['INBOX', 'IMPORTANT']);
    const row = await s.getMessage(id);
    expect(row?.isStarred).toBe(false);
    expect(row?.isImportant).toBe(true);
  });

  it('labels.add / labels.remove, single and bulk', async () => {
    const accountId = await seedAccount();
    const a = await seedMessage(accountId, ['INBOX']);
    const b = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);

    await s.apply({ kind: 'labels.add', ids: [a], labels: ['IMPORTANT'], semantics: 'single' });
    expect((await s.getMessage(a))?.labels).toContain('IMPORTANT');

    await s.apply({ kind: 'labels.add', ids: [a, b], labels: ['STARRED'], semantics: 'bulk' });
    expect((await s.getMessage(b))?.labels).toContain('STARRED');

    await s.apply({ kind: 'labels.remove', ids: [a, b], labels: ['STARRED'], semantics: 'bulk' });
    expect((await s.getMessage(b))?.labels).not.toContain('STARRED');
  });

  it('move relocates messages and reports missing ids', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    const result = await s.apply({ kind: 'move', ids: [id, 'nope'], location: 'TRASH' });
    expect(result.applied).toEqual([id]);
    expect(result.missing).toEqual(['nope']);
    const row = await s.getMessage(id);
    expect(row?.isTrash).toBe(true);
    expect(row?.labels).toEqual(['TRASH']);
  });

  it('thread.label applies a label to every message in a thread and reports their ids, not the thread key', async () => {
    const accountId = await seedAccount();
    const first = await seedMessage(accountId, ['INBOX'], { threadId: 'thread_lbl' });
    const second = await seedMessage(accountId, ['INBOX'], { threadId: 'thread_lbl' });
    const s = store(accountId);
    const result = await s.apply({ kind: 'thread.label', threadKey: 'thread_lbl', label: 'IMPORTANT', action: 'add' });
    expect(result.applied.slice().sort()).toEqual([first, second].sort());
    expect(result.updatedIds?.slice().sort()).toEqual([first, second].sort());
  });

  it('thread.read flips every message in a thread and reports updatedIds', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { threadId: 'thread_read' });
    const s = store(accountId);
    const result = await s.apply({ kind: 'thread.read', threadKey: 'thread_read', isRead: true });
    expect(result.updatedIds).toEqual([id]);
  });

  it('folder.read marks every unread message in the folder', async () => {
    const accountId = await seedAccount();
    const a = await seedMessage(accountId, ['INBOX']);
    const b = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    const result = await s.apply({ kind: 'folder.read', scope: { labelSlug: 'inbox' } });
    expect(new Set(result.updatedIds)).toEqual(new Set([a, b]));
  });

  it('thread.set reassigns a message to a different thread', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    await s.apply({ kind: 'thread.set', id, threadId: 'thread_new' });
    expect((await s.getMessage(id))?.threadId).toBe('thread_new');
  });

  it('label.rename relabels carrying messages case-insensitively', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['invoices']);
    const s = store(accountId);
    await s.apply({ kind: 'label.rename', from: 'Invoices', to: 'Bills' });
    expect((await s.getMessage(id))?.labels).toEqual(['Bills']);
  });

  it('label.delete strips the label from carrying messages', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX', 'Promo']);
    const s = store(accountId);
    await s.apply({ kind: 'label.delete', name: 'Promo' });
    expect((await s.getMessage(id))?.labels).toEqual(['INBOX']);
  });

  it('delete: soft keeps the row, hard removes it and returns attachment storage paths', async () => {
    const accountId = await seedAccount();
    const soft = await seedMessage(accountId, ['INBOX']);
    const hard = await seedMessage(accountId, ['INBOX'], { hasAttachments: true });
    await db.insert(mailAttachments).values({ id: generateId('attach'), messageId: hard, fileName: 'x', size: 1, storagePath: 'workspaces/ws_test/x' });
    const s = store(accountId);

    await s.apply({ kind: 'delete', ids: [soft] });
    expect(await s.getMessage(soft)).toBeNull(); // soft-deleted rows are excluded from reads

    const hardResult = await s.apply({ kind: 'delete', ids: [hard], hard: true });
    expect(hardResult.applied).toEqual([hard]);
    expect(hardResult.storagePaths).toEqual(['workspaces/ws_test/x']);
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, hard));
    expect(row).toBeUndefined();
  });

  it('snooze / resnooze / unsnooze a message, and snooze.wake brings it back', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);

    await s.apply({ kind: 'snooze', id, until: Date.now() + 60_000 });
    expect((await s.getMessage(id))?.labels).toEqual(['SNOOZED']);

    await s.apply({ kind: 'resnooze', id, until: Date.now() + 120_000 });
    await s.apply({ kind: 'unsnooze', id });
    expect((await s.getMessage(id))?.labels).toEqual(['INBOX']);

    const due = await seedMessage(accountId, ['INBOX']);
    await s.apply({ kind: 'snooze', id: due, until: Date.now() + 1000 });
    const wake = await s.apply({ kind: 'snooze.wake', now: Date.now() + 5000 });
    expect(wake.ready).toBe(true);
    expect((await s.getMessage(due))?.labels).toEqual(['INBOX']);
  });

  it('scheduled patches the row and can drop the SCHEDULED label', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['SENT', 'SCHEDULED'], { sendStatus: 'scheduled' });
    const s = store(accountId);
    const result = await s.apply({
      kind: 'scheduled',
      id,
      patch: { sendStatus: 'sent', dropScheduledLabel: true, sentAt: Date.now() },
    });
    expect(result.message?.sendStatus).toBe('sent');
    expect((await s.getMessage(id))?.labels).toEqual(['SENT']);
  });

  it('delivery.match sets delivery status on the matching sent copy', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['SENT'], {
      source: 'sent',
      to: [{ email: 'recipient@example.com' }],
      sentDate: new Date(),
    });
    const s = store(accountId);
    const result = await s.apply({
      kind: 'delivery.match',
      recipient: 'recipient@example.com',
      eventAt: Date.now(),
      status: 'delivered',
      detail: null,
    });
    expect(result.applied).toEqual([id]);
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
    expect(row?.deliveryStatus).toBe('delivered');
  });

  it('inbound.finalize applies a labels/flags DELTA from a mail rule run', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    await s.apply({
      kind: 'inbound.finalize',
      id,
      addLabels: ['SPAM'],
      removeLabels: ['INBOX'],
      isSpam: true,
    });
    const row = await s.getMessage(id);
    expect(row?.labels).toEqual(['SPAM']);
    expect(row?.isSpam).toBe(true);
  });

  it('inbound.finalize never resets a field it did not set, and merges labels onto a concurrent user edit', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);

    // The user reads and archives the message while Jev classification
    // (which can take seconds) is still running.
    await s.apply({ kind: 'flags', ids: [id], patch: { isRead: true }, semantics: 'single' });
    await s.apply({ kind: 'move', ids: [id], location: 'ARCHIVE' });

    // Classification finishes afterwards and only adds an AI label — the OLD
    // absolute-snapshot shape (`labels: ['INBOX', 'Jev/xyz'], isRead: false`)
    // would have put it back in the inbox and marked it unread.
    await s.apply({ kind: 'inbound.finalize', id, addLabels: ['Jev/xyz'], removeLabels: [] });

    const row = await s.getMessage(id);
    expect(row?.isRead).toBe(true);
    expect(row?.labels).toEqual(expect.arrayContaining(['ARCHIVE', 'Jev/xyz']));
    expect(row?.labels).not.toContain('INBOX');
  });

  it('categories sets the AI category list and optional importance', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    await s.apply({ kind: 'categories', id, categories: ['receipts'], important: true });
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
    expect(row?.categories).toEqual(['receipts']);
    expect(row?.isImportant).toBe(true);
  });

  it('attachment.create / update / associate / delete', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    const attachmentId = generateId('attach');
    await s.apply({
      kind: 'attachment.create',
      attachment: { id: attachmentId, messageId: id, fileName: 'a.pdf', size: 10 },
    });
    expect((await s.getAttachment(attachmentId))?.fileName).toBe('a.pdf');

    await s.apply({ kind: 'attachment.update', id: attachmentId, patch: { fileName: 'b.pdf' } });
    expect((await s.getAttachment(attachmentId))?.fileName).toBe('b.pdf');

    const other = await seedMessage(accountId, ['INBOX']);
    await s.apply({ kind: 'attachment.associate', messageId: other, attachmentIds: [attachmentId] });
    expect((await s.getAttachment(attachmentId))?.messageId).toBe(other);

    const deleteResult = await s.apply({ kind: 'attachment.delete', id: attachmentId });
    expect(deleteResult.applied).toEqual([attachmentId]);
    expect(await s.getAttachment(attachmentId)).toBeNull();
  });

  it('subscription.upsert reconciles without downgrading a live count, subscription.status records unsubscribe', async () => {
    const accountId = await seedAccount();
    const s = store(accountId);
    const now = new Date();
    await s.apply({
      kind: 'subscription.upsert',
      values: [
        {
          senderEmail: 'list@example.com',
          senderName: 'List',
          senderDomain: 'example.com',
          listId: null,
          unsubscribeUrl: 'https://example.com/unsub',
          unsubscribeMailto: null,
          oneClick: false,
          messageCount: 3,
          lastSubject: 'Hi',
          firstReceivedAt: now,
          lastReceivedAt: now,
        },
      ],
    });
    const [sub] = await s.listSubscriptions({});
    expect(sub?.messageCount).toBe(3);

    await s.apply({
      kind: 'subscription.status',
      id: sub!.id,
      patch: { status: 'unsubscribed', method: 'link', at: Date.now(), by: 'user_1' },
    });
    expect((await s.getSubscription(sub!.id))?.status).toBe('unsubscribed');
  });

  it('draft.create / update / delete', async () => {
    const accountId = await seedAccount();
    const s = store(accountId);
    const draftId = generateId('draft');
    await s.apply({ kind: 'draft.create', draft: { id: draftId, accountId, subject: 'Draft' } });
    expect((await s.getDraft(draftId))?.subject).toBe('Draft');

    await s.apply({ kind: 'draft.update', id: draftId, patch: { subject: 'Updated' } });
    expect((await s.getDraft(draftId))?.subject).toBe('Updated');

    await s.apply({ kind: 'draft.delete', id: draftId });
    expect(await s.getDraft(draftId)).toBeNull();
  });

  it('applyBatch runs every op in order and returns one result each', async () => {
    const accountId = await seedAccount();
    const a = await seedMessage(accountId, ['INBOX']);
    const b = await seedMessage(accountId, ['INBOX']);
    const s = store(accountId);
    const results = await s.applyBatch([
      { kind: 'flags', ids: [a], patch: { isRead: true }, semantics: 'single' },
      { kind: 'flags', ids: [b], patch: { isFlagged: true }, semantics: 'single' },
    ]);
    expect(results).toHaveLength(2);
    expect((await s.getMessage(a))?.isRead).toBe(true);
    expect((await s.getMessage(b))?.isFlagged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceMailStore
// ---------------------------------------------------------------------------

describe('PostgresWorkspaceMailStore', () => {
  it('mailbox() returns a store scoped to that account', () => {
    const ws = workspaceStore();
    const mailbox = ws.mailbox('acct_1');
    expect(mailbox.ref).toEqual({ workspaceId: 'ws_test', accountId: 'acct_1', clerkOrgId: 'org_test' });
  });

  it('listThreads / listMessages / stats / unreadBadge span multiple accounts', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await seedMessage(a, ['INBOX']);
    await seedMessage(b, ['INBOX']);
    const ws = workspaceStore();

    const threads = await ws.listThreads([a, b], { labelSlug: 'inbox', pageSize: 10 });
    expect(threads.totalCount).toBe(2);

    const messages = await ws.listMessages([a, b], { limit: 10 });
    expect(messages.totalCount).toBe(2);

    const stats = await ws.stats([a, b]);
    expect(stats.total).toBe(2);

    expect(await ws.unreadBadge([a, b])).toBe(2);
  });

  it('locateMessages / locateAttachment / locateDraft find a record across accounts', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const msg = await seedMessage(b, ['INBOX'], { hasAttachments: true });
    const attachmentId = generateId('attach');
    await db.insert(mailAttachments).values({ id: attachmentId, messageId: msg, fileName: 'x', size: 1 });
    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId: b, subject: 'D' });

    const ws = workspaceStore();
    const located = await ws.locateMessages([msg], [a, b]);
    expect(located.get(msg)).toBe(b);

    const attachment = await ws.locateAttachment(attachmentId, [a, b]);
    expect(attachment?.accountId).toBe(b);

    const draft = await ws.locateDraft(draftId, [a, b]);
    expect(draft?.accountId).toBe(b);
  });

  it('locateMessages excludes a soft-deleted message by default, and finds it with includeDeleted — still scoped to the given accountIds', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const other = await seedAccount();
    const msg = await seedMessage(b, ['INBOX']);
    await store(b).apply({ kind: 'delete', ids: [msg] });

    const ws = workspaceStore();
    expect((await ws.locateMessages([msg], [a, b])).get(msg)).toBeUndefined();
    expect((await ws.locateMessages([msg], [a, b], undefined, { includeDeleted: true })).get(msg)).toBe(b);
    // Never leaks another mailbox: a caller without `b` in scope still can't resolve it, even with includeDeleted.
    expect((await ws.locateMessages([msg], [a, other], undefined, { includeDeleted: true })).get(msg)).toBeUndefined();
  });

  it('messagesByCounterparty merges the exact-address filter with the workspace scope', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const match = await seedMessage(a, ['INBOX'], { from: { email: 'vip@example.com' } });
    await seedMessage(b, ['INBOX'], { from: { email: 'other@example.com' } });
    const ws = workspaceStore();
    const page = await ws.messagesByCounterparty('vip@example.com', [a, b], { limit: 10 });
    expect(page.data.map((m) => m.id)).toEqual([match]);
  });

  it('recentAttachments / recentMessages span accounts', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const msgA = await seedMessage(a, ['INBOX'], { hasAttachments: true });
    await seedMessage(b, ['INBOX']);
    await db.insert(mailAttachments).values({ id: generateId('attach'), messageId: msgA, fileName: 'x', size: 1 });
    const ws = workspaceStore();
    const { totalCount } = await ws.recentAttachments([a, b], { limit: 10 });
    expect(totalCount).toBe(1);
    const recent = await ws.recentMessages([a, b], 10);
    expect(recent).toHaveLength(2);
  });

  it('markFolderRead marks unread mail across every accessible mailbox', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const idA = await seedMessage(a, ['INBOX']);
    const idB = await seedMessage(b, ['INBOX']);
    const ws = workspaceStore();
    const result = await ws.markFolderRead([a, b], { labelSlug: 'inbox' });
    expect(result.updatedCount).toBe(2);
    expect(new Set(result.updated.map((u) => u.id))).toEqual(new Set([idA, idB]));
  });

  it('listSnoozed / listScheduled / listDrafts are scoped to the accessible accounts only', async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const snoozedA = await seedMessage(a, ['SNOOZED'], { snoozedUntil: new Date(Date.now() + 60_000) });
    await seedMessage(b, ['SNOOZED'], { snoozedUntil: new Date(Date.now() + 60_000) });
    const scheduledA = await seedMessage(a, ['SENT', 'SCHEDULED'], {
      sendStatus: 'scheduled',
      scheduledFor: new Date(Date.now() + 60_000),
    });
    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId: a, subject: 'D' });

    const ws = workspaceStore();
    // Scoped to `a` only: `b`'s snoozed mail must not leak in (design's
    // documented access-bug fix for `listSnoozedMessages`).
    expect((await ws.listSnoozed([a])).map((m) => m.id)).toEqual([snoozedA]);
    expect((await ws.listScheduled([a])).map((m) => m.id)).toEqual([scheduledA]);
    expect((await ws.listDrafts([a], { limit: 10 })).data.map((d) => d.id)).toEqual([draftId]);
  });
});
