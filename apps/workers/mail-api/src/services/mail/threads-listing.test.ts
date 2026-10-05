/**
 * pglite-backed tests for what the folder listings, the search and the
 * sidebar counters read, from the 2026-10-04 QA run:
 *
 * - a user label's folder finds its mail whatever the casing of the slug
 *   (TASK-900);
 * - Starred / Important list mail flagged through any path (TASK-898);
 * - trash and spam never show in another folder (TASK-897);
 * - search looks through the whole mailbox: subject, body, participants
 *   (TASK-906);
 * - the stats endpoint has a number for every folder badge (TASK-908);
 * - snoozed mail comes back when its time has passed (TASK-931).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { createMailLabel } from './labels';
import { getMessageStats, listMessages, updateMessage } from './messages';
import { snoozeMessage, wakeDueSnoozedMessages } from './snooze';
import { listThreadsByLabel } from './threads';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailDrafts, mailMessages } = schema;

const USER = 'user_test';

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, isShared: true });
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
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Listing test',
    sentDate: new Date(),
    labels,
    ...extra,
  });
  return id;
}

async function threadIdsIn(accountId: string, labelSlug: string, extra: Record<string, unknown> = {}) {
  const { threads, totalCount } = await listThreadsByLabel(db, USER, { accountId, labelSlug, ...extra });
  expect(totalCount).toBe(threads.length);
  return threads.map((t) => t.latestMessageId);
}

async function labelsOf(messageId: string): Promise<string[]> {
  const [row] = await db
    .select({ labels: mailMessages.labels })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);
  return (row?.labels as string[] | null) ?? [];
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('user label folders (TASK-900)', () => {
  it('lists the mail labelled "Invoices" under the /invoices slug', async () => {
    const accountId = await seedAccount();
    await createMailLabel(db, { accountId, name: 'Invoices' });
    const tagged = await seedMessage(accountId, ['INBOX', 'Invoices']);
    await seedMessage(accountId, ['INBOX']);

    expect(await threadIdsIn(accountId, 'invoices')).toEqual([tagged]);
    expect(await threadIdsIn(accountId, 'Invoices')).toEqual([tagged]);
    expect(await threadIdsIn(accountId, 'INVOICES')).toEqual([tagged]);
  });

  it('matches a multi-word label and the message list endpoint the same way', async () => {
    const accountId = await seedAccount();
    await createMailLabel(db, { accountId, name: 'QA Label Test' });
    const tagged = await seedMessage(accountId, ['QA Label Test']);

    expect(await threadIdsIn(accountId, 'qa label test')).toEqual([tagged]);
    const { data } = await listMessages(db, { accountId, label: 'qa label test' });
    expect(data.map((m) => m.id)).toEqual([tagged]);
  });

  it('does not match another account that spells the label differently', async () => {
    const accountId = await seedAccount();
    const otherAccountId = await seedAccount();
    await createMailLabel(db, { accountId: otherAccountId, name: 'PROJECTS' });
    await seedMessage(otherAccountId, ['PROJECTS']);

    expect(await threadIdsIn(accountId, 'projects')).toEqual([]);
  });
});

describe('starred and important folders (TASK-898)', () => {
  it('a star set from the toolbar shows in Starred and on the thread', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    await updateMessage(db, id, { isStarred: true });

    expect(await threadIdsIn(accountId, 'starred')).toEqual([id]);
    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'inbox' });
    expect(threads[0]!.isStarred).toBe(true);
    expect((await getMessageStats(db, accountId)).starred).toBe(1);
  });

  it('a star that only lives on the column still shows', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { isStarred: true });

    expect(await threadIdsIn(accountId, 'starred')).toEqual([id]);
    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'inbox' });
    expect(threads[0]!.isStarred).toBe(true);
  });

  it('mark as important shows in Important', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    await updateMessage(db, id, { isImportant: true });

    expect(await threadIdsIn(accountId, 'important')).toEqual([id]);
  });
});

describe('trash and spam stay in their own folder (TASK-897)', () => {
  it('a legacy INBOX+TRASH row lists in Trash only', async () => {
    const accountId = await seedAccount();
    const trashed = await seedMessage(accountId, ['INBOX', 'TRASH']);
    const spam = await seedMessage(accountId, ['INBOX', 'SPAM', 'STARRED']);
    const kept = await seedMessage(accountId, ['INBOX']);

    expect(await threadIdsIn(accountId, 'inbox')).toEqual([kept]);
    expect(await threadIdsIn(accountId, 'all')).toEqual([kept]);
    expect(await threadIdsIn(accountId, 'starred')).toEqual([]);
    expect(await threadIdsIn(accountId, 'trash')).toEqual([trashed]);
    expect(await threadIdsIn(accountId, 'spam')).toEqual([spam]);
  });
});

describe('search (TASK-906)', () => {
  it('finds mail in another folder by a word in the body', async () => {
    const accountId = await seedAccount();
    const sent = await seedMessage(accountId, ['SENT'], {
      subject: 'Quarterly numbers',
      textBody: 'The osprey has landed.',
    });
    await seedMessage(accountId, ['INBOX'], { subject: 'Lunch', textBody: 'Sandwiches at noon.' });

    // Searching from the Inbox still finds the Sent mail.
    expect(await threadIdsIn(accountId, 'inbox', { search: 'osprey' })).toEqual([sent]);
    expect(await threadIdsIn(accountId, 'inbox', { search: 'OSPREY landed' })).toEqual([sent]);
    expect(await threadIdsIn(accountId, 'inbox', { search: 'osprey sandwiches' })).toEqual([]);
  });

  it('matches the sender, the recipients and the subject', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], {
      subject: 'Zebrafinch report',
      from: { email: 'dana@acme.example', name: 'Dana Whitlock' },
      to: [{ email: 'team@weld.example', name: 'Team Inbox' }],
      cc: [{ email: 'cc-person@weld.example' }],
    });

    for (const term of ['zebrafinch', 'dana@acme', 'whitlock', 'team inbox', 'cc-person']) {
      expect(await threadIdsIn(accountId, 'inbox', { search: term }), term).toEqual([id]);
    }
    const { data } = await listMessages(db, { accountId, search: 'cc-person' });
    expect(data.map((m) => m.id)).toEqual([id]);
  });

  it('treats LIKE wildcards literally and leaves trash out', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX'], { subject: 'Plain subject' });
    await seedMessage(accountId, ['TRASH'], { subject: 'Discarded kingfisher' });

    expect(await threadIdsIn(accountId, 'inbox', { search: '%' })).toEqual([]);
    expect(await threadIdsIn(accountId, 'inbox', { search: 'kingfisher' })).toEqual([]);
  });

  it('applies the From / To / Subject / attachment filters inside the folder', async () => {
    const accountId = await seedAccount();
    const match = await seedMessage(accountId, ['INBOX'], {
      subject: 'Invoice 42',
      from: { email: 'billing@acme.example', name: 'Acme Billing' },
      hasAttachments: true,
    });
    await seedMessage(accountId, ['INBOX'], { subject: 'Invoice 43' });
    await seedMessage(accountId, ['ARCHIVE'], {
      subject: 'Invoice 41',
      from: { email: 'billing@acme.example' },
      hasAttachments: true,
    });

    expect(
      await threadIdsIn(accountId, 'inbox', { from: 'acme', subject: 'invoice', hasAttachment: true }),
    ).toEqual([match]);
    expect(await threadIdsIn(accountId, 'inbox', { to: 'me@test' })).toHaveLength(2);
  });
});

describe('folder counters (TASK-908)', () => {
  it('counts every folder the sidebar has a badge for', async () => {
    const accountId = await seedAccount();
    await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['INBOX'], { isRead: true });
    await seedMessage(accountId, ['INBOX', 'STARRED'], { isRead: true });
    await seedMessage(accountId, ['INBOX', 'IMPORTANT']);
    await seedMessage(accountId, ['ARCHIVE']);
    await seedMessage(accountId, ['TRASH', 'STARRED']);
    await seedMessage(accountId, ['SPAM']);
    await seedMessage(accountId, ['SPAM'], { isRead: true });
    await seedMessage(accountId, ['SNOOZED'], { isRead: true });
    await seedMessage(accountId, ['SENT', 'SCHEDULED'], { isRead: true, sendStatus: 'scheduled' });
    await seedMessage(accountId, ['SENT'], { isRead: true, sendStatus: 'sent' });
    for (const subject of ['Draft one', 'Draft two']) {
      await db.insert(mailDrafts).values({ id: generateId('draft'), accountId, subject });
    }
    // Another mailbox must not leak into the numbers.
    const otherAccountId = await seedAccount();
    await seedMessage(otherAccountId, ['INBOX']);

    expect(await getMessageStats(db, accountId)).toEqual({
      total: 11,
      unread: 5,
      inboxUnread: 2,
      starred: 1,
      importantUnread: 1,
      sentUnread: 0,
      archiveUnread: 1,
      trashUnread: 1,
      spam: 2,
      snoozed: 1,
      scheduled: 1,
      drafts: 2,
    });
  });

  it('returns zeros for an empty mailbox', async () => {
    const accountId = await seedAccount();
    const stats = await getMessageStats(db, accountId);
    expect(Object.values(stats).every((n) => n === 0)).toBe(true);
  });
});

describe('auto-unsnooze (TASK-931)', () => {
  it('wakes mail whose time has passed and leaves the rest snoozed', async () => {
    const accountId = await seedAccount();
    const due = await seedMessage(accountId, ['INBOX']);
    const later = await seedMessage(accountId, ['INBOX']);
    await snoozeMessage(db, accountId, due, new Date(Date.now() + 60 * 60_000));
    await snoozeMessage(db, accountId, later, new Date(Date.now() + 3 * 60 * 60_000));
    expect(await labelsOf(due)).toEqual(['SNOOZED']);

    const now = new Date(Date.now() + 2 * 60 * 60_000);
    const result = await wakeDueSnoozedMessages(db, { now });

    expect(result).toEqual({ woken: 1, accountIds: [accountId] });
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, due)).limit(1);
    expect(row!.labels).toEqual(['INBOX']);
    expect(row!.isRead).toBe(false);
    expect(row!.snoozedUntil).toBeNull();
    expect(row!.unsnoozedAt).toEqual(now);
    expect(row!.unsnoozedEarly).toBe(false);
    expect(await labelsOf(later)).toEqual(['SNOOZED']);

    // Nothing left to do on the next sweep.
    expect((await wakeDueSnoozedMessages(db, { now })).woken).toBe(0);
  });

  it('keeps the other labels of a woken mail', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['muted', 'SNOOZED', 'STARRED'], {
      snoozedUntil: new Date(Date.now() - 60_000),
      isRead: true,
    });

    await wakeDueSnoozedMessages(db);

    expect(await labelsOf(id)).toEqual(['muted', 'STARRED', 'INBOX']);
  });

  it('opening the mailbox brings a due mail back without waiting for the sweep', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['SNOOZED'], {
      snoozedUntil: new Date(Date.now() - 60_000),
      isRead: true,
    });

    expect(await threadIdsIn(accountId, 'inbox')).toEqual([id]);
    expect(await threadIdsIn(accountId, 'snoozed')).toEqual([]);
  });

  it('only wakes mail in the given scope', async () => {
    const accountId = await seedAccount();
    const otherAccountId = await seedAccount();
    const mine = await seedMessage(accountId, ['SNOOZED'], { snoozedUntil: new Date(Date.now() - 1000) });
    const theirs = await seedMessage(otherAccountId, ['SNOOZED'], { snoozedUntil: new Date(Date.now() - 1000) });

    await wakeDueSnoozedMessages(db, { scope: eq(mailMessages.accountId, accountId) });

    expect(await labelsOf(mine)).toEqual(['INBOX']);
    expect(await labelsOf(theirs)).toEqual(['SNOOZED']);
  });
});
