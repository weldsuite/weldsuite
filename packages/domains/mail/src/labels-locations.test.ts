/**
 * pglite-backed tests for the label write paths found broken in the
 * 2026-10-04 QA run:
 *
 * - Inbox / Archive / Trash / Spam are one location, not four labels
 *   (TASK-897): trashing leaves the inbox, restoring leaves the trash, no
 *   duplicates, and `isTrash` / `isSpam` follow the label.
 * - Starring, in any of its spellings, writes the STARRED label and the
 *   `isStarred` column together (TASK-898).
 * - Renaming a label renames it on its messages too (TASK-902).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  addLabels,
  applyLabelToThread,
  createMailLabel,
  MailLabelError,
  updateMailLabel,
} from './labels';
import { addMessageLabels, bulkUpdateMessages, removeMessageLabels, updateMessage } from './messages';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages } = schema;

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
    subject: 'Location test',
    sentDate: new Date(),
    labels,
    ...extra,
  });
  return id;
}

async function rowOf(messageId: string) {
  const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
  return { ...row!, labels: (row!.labels as string[] | null) ?? [] };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('addLabels', () => {
  it('normalises system slugs and never duplicates', () => {
    expect(addLabels(['INBOX'], 'starred', 'STARRED', 'Invoices', 'Invoices')).toEqual([
      'INBOX',
      'STARRED',
      'Invoices',
    ]);
  });

  it('replaces the previous location when a location label is added', () => {
    expect(addLabels(['INBOX', 'Invoices'], 'TRASH')).toEqual(['Invoices', 'TRASH']);
    expect(addLabels(['TRASH', 'INBOX', 'INBOX'], 'inbox')).toEqual(['INBOX']);
  });
});

describe('thread moves (TASK-897)', () => {
  it('deleting a thread takes it out of the inbox and sets isTrash', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { threadId: 't_delete' });

    const result = await applyLabelToThread(db, accountId, 't_delete', 'TRASH', 'add');

    expect(result.affected).toBe(1);
    const row = await rowOf(id);
    expect(row.labels).toEqual(['TRASH']);
    expect(row.isTrash).toBe(true);
    expect(row.isSpam).toBe(false);
  });

  it('marking spam takes it out of the inbox and sets isSpam', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX', 'Invoices'], { threadId: 't_spam' });

    await applyLabelToThread(db, accountId, 't_spam', 'spam', 'add');

    const row = await rowOf(id);
    expect(row.labels).toEqual(['Invoices', 'SPAM']);
    expect(row.isSpam).toBe(true);
  });

  it('moving an archived thread to the inbox drops ARCHIVE', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['ARCHIVE'], { threadId: 't_unarchive' });

    await applyLabelToThread(db, accountId, 't_unarchive', 'INBOX', 'add');

    expect((await rowOf(id)).labels).toEqual(['INBOX']);
  });

  it('untangles a thread that already sits in three folders', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX', 'ARCHIVE', 'TRASH', 'INBOX'], {
      threadId: 't_tangle',
      isTrash: true,
    });

    await applyLabelToThread(db, accountId, 't_tangle', 'ARCHIVE', 'add');

    const row = await rowOf(id);
    expect(row.labels).toEqual(['ARCHIVE']);
    expect(row.isTrash).toBe(false);
  });

  it('a trashed snoozed mail is no longer due to wake', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['SNOOZED'], {
      threadId: 't_snoozed_trash',
      snoozedUntil: new Date(Date.now() + 60_000),
    });

    await applyLabelToThread(db, accountId, 't_snoozed_trash', 'TRASH', 'add');

    const row = await rowOf(id);
    expect(row.labels).toEqual(['TRASH']);
    expect(row.snoozedUntil).toBeNull();
  });
});

describe('bulk trash / restore (TASK-897)', () => {
  it('restore removes TRASH, adds INBOX once and clears isTrash', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX', 'TRASH'], { isTrash: true });

    await bulkUpdateMessages(db, [id], 'restore');

    const row = await rowOf(id);
    expect(row.labels).toEqual(['INBOX']);
    expect(row.isTrash).toBe(false);
  });

  it('restore puts a sent mail back in Sent, not in the inbox', async () => {
    const accountId = await seedAccount();
    const received = await seedMessage(accountId, ['TRASH'], { isTrash: true });
    const sent = await seedMessage(accountId, ['SENT', 'TRASH'], { isTrash: true });

    await bulkUpdateMessages(db, [received, sent], 'restore');

    expect((await rowOf(received)).labels).toEqual(['INBOX']);
    expect((await rowOf(sent)).labels).toEqual(['SENT']);
  });

  it('trash twice leaves a single TRASH label', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    await bulkUpdateMessages(db, [id], 'trash');
    await bulkUpdateMessages(db, [id], 'trash');

    const row = await rowOf(id);
    expect(row.labels).toEqual(['TRASH']);
    expect(row.isTrash).toBe(true);
  });
});

describe('starring (TASK-898)', () => {
  it('the toolbar star (isStarred patch) also writes the STARRED label', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    await updateMessage(db, id, { isStarred: true });
    let row = await rowOf(id);
    expect(row.isStarred).toBe(true);
    expect(row.labels).toEqual(['INBOX', 'STARRED']);

    await updateMessage(db, id, { isStarred: false });
    row = await rowOf(id);
    expect(row.isStarred).toBe(false);
    expect(row.labels).toEqual(['INBOX']);
  });

  it('mark as important writes the IMPORTANT label', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    await updateMessage(db, id, { isImportant: true });

    const row = await rowOf(id);
    expect(row.isImportant).toBe(true);
    expect(row.labels).toContain('IMPORTANT');
  });

  it('the label picker ("starred") stores the system label and the flag', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    expect(await addMessageLabels(db, id, ['starred'])).toEqual(['INBOX', 'STARRED']);
    expect((await rowOf(id)).isStarred).toBe(true);

    expect(await removeMessageLabels(db, id, ['Starred'])).toEqual(['INBOX']);
    expect((await rowOf(id)).isStarred).toBe(false);
  });

  it('starring a thread from the row menu flags every message', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { threadId: 't_star' });

    await applyLabelToThread(db, accountId, 't_star', 'STARRED', 'add');
    let row = await rowOf(id);
    expect(row.labels).toEqual(['INBOX', 'STARRED']);
    expect(row.isStarred).toBe(true);

    await applyLabelToThread(db, accountId, 't_star', 'STARRED', 'remove');
    row = await rowOf(id);
    expect(row.labels).toEqual(['INBOX']);
    expect(row.isStarred).toBe(false);
  });

  it('unstarring a thread clears a star that only lived on the column', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX'], { threadId: 't_legacy_star', isStarred: true });

    const result = await applyLabelToThread(db, accountId, 't_legacy_star', 'STARRED', 'remove');

    expect(result.affected).toBe(1);
    expect((await rowOf(id)).isStarred).toBe(false);
  });

  it('bulk star / unstar keep label and column in step', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX']);

    await bulkUpdateMessages(db, [id], 'star');
    expect((await rowOf(id)).labels).toContain('STARRED');
    expect((await rowOf(id)).isStarred).toBe(true);

    await bulkUpdateMessages(db, [id], 'unstar');
    expect((await rowOf(id)).labels).not.toContain('STARRED');
    expect((await rowOf(id)).isStarred).toBe(false);
  });

  it('moving to trash through the isTrash flag is a move too', async () => {
    const accountId = await seedAccount();
    const id = await seedMessage(accountId, ['INBOX', 'STARRED'], { isStarred: true });

    await updateMessage(db, id, { isTrash: true });
    let row = await rowOf(id);
    expect(row.labels).toEqual(['STARRED', 'TRASH']);
    expect(row.isTrash).toBe(true);

    await updateMessage(db, id, { isTrash: false });
    row = await rowOf(id);
    expect(row.labels).toEqual(['STARRED', 'INBOX']);
    expect(row.isTrash).toBe(false);
  });
});

describe('label rename (TASK-902)', () => {
  it('renames the label on every message that carries it', async () => {
    const accountId = await seedAccount();
    const label = await createMailLabel(db, { accountId, name: 'QA Label Test' });
    const tagged = await seedMessage(accountId, ['INBOX', 'QA Label Test']);
    const other = await seedMessage(accountId, ['INBOX', 'Invoices']);

    const result = await updateMailLabel(db, label.id, { name: 'QA Label Renamed' });

    expect(result.after.name).toBe('QA Label Renamed');
    expect((await rowOf(tagged)).labels).toEqual(['INBOX', 'QA Label Renamed']);
    expect((await rowOf(other)).labels).toEqual(['INBOX', 'Invoices']);
  });

  it('leaves another account with the same label name alone', async () => {
    const accountId = await seedAccount();
    const otherAccountId = await seedAccount();
    const label = await createMailLabel(db, { accountId, name: 'Shared name' });
    const foreign = await seedMessage(otherAccountId, ['Shared name']);

    await updateMailLabel(db, label.id, { name: 'Renamed' });

    expect((await rowOf(foreign)).labels).toEqual(['Shared name']);
  });

  it('refuses a system folder name for a user label', async () => {
    const accountId = await seedAccount();
    await expect(createMailLabel(db, { accountId, name: 'starred' })).rejects.toBeInstanceOf(MailLabelError);

    const label = await createMailLabel(db, { accountId, name: 'Receipts' });
    await expect(updateMailLabel(db, label.id, { name: 'Inbox' })).rejects.toBeInstanceOf(MailLabelError);
  });
});
