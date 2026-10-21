/**
 * pglite-backed tests for the WeldMail QA run of 2026-10-19:
 *
 * - label badges count what the label's folder lists (TASK-940): trash and
 *   spam left out, a label added on one message and then renamed still counts;
 * - the thread list has a server-side "doesn't have" filter and an attachment
 *   filter that sees the whole conversation (TASK-940);
 * - a thread sorts by its newest message, own replies included (TASK-910);
 * - the reading pane and the list agree on who sent a message (TASK-910 /
 *   TASK-1009).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { applyLabelToThread, createMailLabel, getMailLabel, listMailLabels, updateMailLabel } from './labels';
import { addMessageLabels, getMessage, getThread, removeMessageLabels } from './messages';
import { listThreadsByLabel, normalizeSubject } from './threads';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages, people } = schema;

const USER = 'user_test';

let db: Database;

async function seedAccount(extra: Partial<typeof mailAccounts.$inferInsert> = {}): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, isShared: true, ...extra });
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
    subject: 'Counts test',
    sentDate: new Date(),
    labels,
    ...extra,
  });
  return id;
}

async function threadIdsIn(accountId: string, labelSlug: string, extra: Record<string, unknown> = {}) {
  const { threads, totalCount } = await listThreadsByLabel(db, USER, { accountId, labelSlug, ...extra });
  expect(totalCount).toBe(threads.length);
  return threads.map((t) => t.threadId);
}

async function countOf(accountId: string, name: string): Promise<number | undefined> {
  const rows = await listMailLabels(db, { accountId });
  return rows.find((r) => r.name === name)?.messageCount;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('label counts match the label folder (TASK-940)', () => {
  it('leaves trashed, spam and archived mail out, by label or by flag', async () => {
    const accountId = await seedAccount();
    await createMailLabel(db, { accountId, name: 'Invoices' });
    await seedMessage(accountId, ['INBOX', 'Invoices']);
    // Neither inbox nor archive (e.g. sent mail you labelled) still counts.
    await seedMessage(accountId, ['SENT', 'Invoices']);
    await seedMessage(accountId, ['ARCHIVE', 'Invoices']);
    await seedMessage(accountId, ['TRASH', 'Invoices'], { isTrash: true });
    await seedMessage(accountId, ['SPAM', 'Invoices'], { isSpam: true });
    // Flag only: the label list never saw this one.
    await seedMessage(accountId, ['Invoices'], { isTrash: true });
    const deleted = await seedMessage(accountId, ['INBOX', 'Invoices']);
    await db.update(mailMessages).set({ deletedAt: new Date() }).where(eq(mailMessages.id, deleted));

    const listed = await threadIdsIn(accountId, 'invoices');
    expect(listed).toHaveLength(2);
    expect(await countOf(accountId, 'Invoices')).toBe(listed.length);
  });

  it('does not count another account carrying the same label name', async () => {
    const accountId = await seedAccount();
    const otherId = await seedAccount();
    await createMailLabel(db, { accountId, name: 'Shared Name' });
    await createMailLabel(db, { accountId: otherId, name: 'Shared Name' });
    await seedMessage(otherId, ['INBOX', 'Shared Name']);
    await seedMessage(otherId, ['INBOX', 'Shared Name']);
    await seedMessage(accountId, ['INBOX', 'Shared Name']);

    expect(await countOf(accountId, 'Shared Name')).toBe(1);
    expect(await countOf(otherId, 'Shared Name')).toBe(2);
  });

  it('counts a label added with the single-message route, before and after a rename', async () => {
    const accountId = await seedAccount();
    const label = await createMailLabel(db, { accountId, name: 'QA Label' });
    const a = await seedMessage(accountId, ['INBOX']);
    const b = await seedMessage(accountId, ['INBOX']);
    await seedMessage(accountId, ['INBOX']);

    await addMessageLabels(db, a, ['QA Label']);
    await addMessageLabels(db, b, ['QA Label']);
    expect(await countOf(accountId, 'QA Label')).toBe(2);

    const { after } = await updateMailLabel(db, label.id, { name: 'QA Renamed' });
    expect(after.messageCount).toBe(2);
    expect(await countOf(accountId, 'QA Renamed')).toBe(2);
    expect((await getMailLabel(db, label.id))?.messageCount).toBe(2);
    expect(await threadIdsIn(accountId, 'qa renamed')).toHaveLength(2);

    await removeMessageLabels(db, a, ['QA Renamed']);
    expect(await countOf(accountId, 'QA Renamed')).toBe(1);
  });

  it('writes a label in the casing of the label row, so it counts and renames with it', async () => {
    const accountId = await seedAccount();
    const label = await createMailLabel(db, { accountId, name: 'Receipts' });
    const id = await seedMessage(accountId, ['INBOX']);

    expect(await addMessageLabels(db, id, ['receipts'])).toEqual(['INBOX', 'Receipts']);
    expect(await countOf(accountId, 'Receipts')).toBe(1);

    await updateMailLabel(db, label.id, { name: 'Bills' });
    expect(await countOf(accountId, 'Bills')).toBe(1);
  });

  it('renames mail that carries the label in another casing', async () => {
    const accountId = await seedAccount();
    const label = await createMailLabel(db, { accountId, name: 'Projects' });
    await seedMessage(accountId, ['INBOX', 'projects']);

    await updateMailLabel(db, label.id, { name: 'Work' });

    expect(await countOf(accountId, 'Work')).toBe(1);
    expect(await threadIdsIn(accountId, 'work')).toHaveLength(1);
  });
});

describe('archiving takes a thread out of a user label folder', () => {
  it('drops the thread from the label folder and its badge, and keeps the label', async () => {
    const accountId = await seedAccount();
    await createMailLabel(db, { accountId, name: 'Clients' });
    const id = await seedMessage(accountId, ['INBOX', 'Clients'], { isStarred: true });
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
    const threadId = row!.threadId!;
    expect(await threadIdsIn(accountId, 'clients')).toEqual([threadId]);
    expect(await countOf(accountId, 'Clients')).toBe(1);

    await applyLabelToThread(db, accountId, threadId, 'ARCHIVE', 'add');

    expect(await threadIdsIn(accountId, 'clients')).toEqual([]);
    expect(await countOf(accountId, 'Clients')).toBe(0);
    expect((await getMessage(db, id))?.labels).toContain('Clients');
    // System folders keep archived mail, and a search still finds it.
    expect(await threadIdsIn(accountId, 'archive')).toContain(threadId);
    expect(await threadIdsIn(accountId, 'starred')).toContain(threadId);
    expect(await threadIdsIn(accountId, 'clients', { search: 'Counts test' })).toContain(threadId);

    // Moving it back to the inbox puts it back in the label folder.
    await applyLabelToThread(db, accountId, threadId, 'INBOX', 'add');
    expect(await threadIdsIn(accountId, 'clients')).toEqual([threadId]);
  });
});

describe('"doesn\'t have" filter (TASK-940)', () => {
  it('leaves out threads where any message has the word in subject, body or sender', async () => {
    const accountId = await seedAccount();
    const keep = await seedMessage(accountId, ['INBOX'], { subject: 'Lunch', textBody: 'Sandwiches' });
    await seedMessage(accountId, ['INBOX'], { subject: 'Newsletter', textBody: 'Plain' });
    await seedMessage(accountId, ['INBOX'], { subject: 'Hello', textBody: 'Please see the invoice' });
    await seedMessage(accountId, ['INBOX'], {
      subject: 'Hi',
      from: { email: 'noreply@spamco.example', name: 'SpamCo' },
    });

    const all = await threadIdsIn(accountId, 'inbox');
    expect(all).toHaveLength(4);
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'newsletter' })).toHaveLength(3);
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'INVOICE' })).toHaveLength(3);
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'spamco' })).toHaveLength(3);
    // Any of the words rules a thread out.
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'newsletter invoice spamco' })).toEqual([
      `thread_${keep}`,
    ]);
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: '   ' })).toHaveLength(4);
  });

  it('rules out the whole thread when an older reply has the word, and treats % literally', async () => {
    const accountId = await seedAccount();
    const threadId = 'thread_conversation';
    await seedMessage(accountId, ['INBOX'], {
      threadId,
      subject: 'Plan',
      textBody: 'confidential figures',
      sentDate: new Date(Date.now() - 60_000),
    });
    await seedMessage(accountId, ['INBOX'], { threadId, subject: 'Re: Plan', textBody: 'thanks' });
    const other = await seedMessage(accountId, ['INBOX'], { subject: 'Other' });

    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'confidential' })).toEqual([`thread_${other}`]);
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: '%' })).toHaveLength(2);
  });

  it('does not look at another account', async () => {
    const accountId = await seedAccount();
    const otherId = await seedAccount();
    const mine = await seedMessage(accountId, ['INBOX'], { subject: 'Mine' });
    await seedMessage(otherId, ['INBOX'], { subject: 'Mine too' });

    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'mine' })).toEqual([]);
    expect(await threadIdsIn(accountId, 'inbox', { excludeWords: 'unrelated' })).toEqual([`thread_${mine}`]);
  });
});

describe('attachment filter sees the whole thread (TASK-940)', () => {
  it('matches a thread whose attachment sits on an older message', async () => {
    const accountId = await seedAccount();
    const threadId = 'thread_with_old_attachment';
    await seedMessage(accountId, ['INBOX'], {
      threadId,
      hasAttachments: true,
      attachmentCount: 1,
      sentDate: new Date(Date.now() - 120_000),
    });
    await seedMessage(accountId, ['INBOX'], { threadId, subject: 'Re: files', sentDate: new Date() });
    await seedMessage(accountId, ['INBOX'], { subject: 'No attachment here' });

    expect(await threadIdsIn(accountId, 'inbox', { hasAttachment: true })).toEqual([threadId]);
  });

  it('matches when the attachment is on a message that is not in the folder', async () => {
    const accountId = await seedAccount();
    const threadId = 'thread_sent_attachment';
    await seedMessage(accountId, ['SENT'], {
      threadId,
      hasAttachments: true,
      attachmentCount: 2,
      sentDate: new Date(Date.now() - 120_000),
    });
    await seedMessage(accountId, ['INBOX'], { threadId, subject: 'Re: the file' });

    expect(await threadIdsIn(accountId, 'inbox', { hasAttachment: true })).toEqual([threadId]);
  });
});

describe('thread order includes own replies (TASK-910)', () => {
  it('lists a thread first when its newest message is your own reply', async () => {
    const accountId = await seedAccount();
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 23, minutes));

    const repliedThread = 'thread_replied';
    await seedMessage(accountId, ['INBOX'], { threadId: repliedThread, receivedDate: at(0), sentDate: at(0) });
    // 11:11 PM own reply: SENT only, so the Inbox filter does not match it.
    await seedMessage(accountId, ['SENT'], {
      threadId: repliedThread,
      receivedDate: null,
      sentDate: at(11),
      subject: 'Re: Counts test',
    });
    await seedMessage(accountId, ['INBOX'], {
      threadId: 'thread_later',
      receivedDate: at(5),
      sentDate: at(5),
    });

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'inbox' });
    expect(threads.map((t) => t.threadId)).toEqual([repliedThread, 'thread_later']);
    expect(threads[0]!.latestDate).toEqual(at(11));
  });
});

describe('sender names agree between list and reading pane (TASK-910, TASK-1009)', () => {
  it('shows the contact name in the thread list, the message and the thread', async () => {
    const accountId = await seedAccount();
    await db.insert(people).values({
      id: generateId('person'),
      displayName: 'Dana Whitlock',
      firstName: 'Dana',
      lastName: 'Whitlock',
      email: 'dana@acme.example',
      inCrm: true,
    } as unknown as typeof people.$inferInsert);
    const id = await seedMessage(accountId, ['INBOX'], {
      from: { email: 'Dana@Acme.example', name: 'dana (acme)' },
    });

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'inbox' });
    expect(threads[0]!.latestSender).toBe('Dana Whitlock');

    const message = await getMessage(db, id);
    expect((message!.from as { name?: string }).name).toBe('Dana Whitlock');
    const thread = await getThread(db, id);
    expect((thread!.messages[0]!.from as { name?: string }).name).toBe('Dana Whitlock');
  });

  it('falls back to the From name and then the address', async () => {
    const accountId = await seedAccount();
    const named = await seedMessage(accountId, ['INBOX'], { from: { email: 'a@nowhere.example', name: 'A Person' } });
    const bare = await seedMessage(accountId, ['INBOX'], { from: { email: 'b@nowhere.example' } });

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'inbox' });
    const senderOf = (messageId: string) => threads.find((t) => t.latestMessageId === messageId)!.latestSender;
    expect(senderOf(named)).toBe('A Person');
    expect(senderOf(bare)).toBe('b@nowhere.example');
    expect(((await getMessage(db, named))!.from as { name?: string }).name).toBe('A Person');
    expect(((await getMessage(db, bare))!.from as { name?: string }).name).toBeUndefined();
  });

  it('uses the mailbox display name for the mailbox itself in both places', async () => {
    const email = `own-${generateId('mail')}@test.dev`;
    const accountId = await seedAccount({ email, displayName: 'Support Desk' });
    const id = await seedMessage(accountId, ['SENT'], {
      from: { email, name: 'E2E Test Workspace' },
    });

    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'sent' });
    expect(threads[0]!.latestSender).toBe('Support Desk');
    expect(((await getMessage(db, id))!.from as { name?: string }).name).toBe('Support Desk');
    expect(((await getThread(db, id))!.messages[0]!.from as { name?: string }).name).toBe('Support Desk');
  });
});

describe('a forwarded thread keeps its Fwd: title (TASK-910)', () => {
  it('titles a forwarded thread with its Fwd: and drops only reply prefixes', async () => {
    expect(normalizeSubject('Re: RE: Budget')).toBe('Budget');
    expect(normalizeSubject('Fwd: Budget')).toBe('Fwd: Budget');
    expect(normalizeSubject('Re: Fwd: Budget')).toBe('Fwd: Budget');

    const accountId = await seedAccount();
    await seedMessage(accountId, ['SENT'], { subject: 'Fwd: Budget' });
    const { threads } = await listThreadsByLabel(db, USER, { accountId, labelSlug: 'sent' });
    expect(threads[0]!.subject).toBe('Fwd: Budget');
  });
});
