/**
 * Seed data for the route tests that run against a pglite tenant DB (and so
 * also through the Rust conformance harness): members, mailboxes, labels and
 * messages, with fixed ids and dates so both backends start from the same
 * rows.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';

export const ADMIN = 'user_seed_admin';
export const MEMBER = 'user_seed_member';
export const STRANGER = 'user_seed_stranger';

/** A shared mailbox, one assigned to MEMBER, and one assigned to nobody. */
export const SHARED = 'mail_seed_shared';
export const PRIVATE = 'mail_seed_private';
export const UNASSIGNED = 'mail_seed_unassigned';

const AT = new Date('2026-03-01T09:00:00.000Z');

export async function seedMembers(db: Database): Promise<void> {
  await db.insert(schema.workspaceMembers).values(
    [
      [ADMIN, 'ADMIN'],
      [MEMBER, 'MEMBER'],
      [STRANGER, 'MEMBER'],
    ].map(([userId, role]) => ({
      id: `wm_${userId}`,
      userId,
      email: `${userId}@acme.test`,
      role,
      status: 'ACTIVE',
    })) as never,
  );
}

export async function seedMailboxes(db: Database): Promise<void> {
  await db.insert(schema.mailAccounts).values([
    { id: SHARED, name: 'Support', email: 'support@acme.test', displayName: 'Acme Support', isShared: true, createdAt: AT, updatedAt: AT },
    { id: PRIVATE, name: 'Member', email: 'member@acme.test', isShared: false, assignedUserIds: [MEMBER], createdAt: AT, updatedAt: AT },
    { id: UNASSIGNED, name: 'Nobody', email: 'nobody@acme.test', isShared: false, assignedUserIds: [], createdAt: AT, updatedAt: AT },
  ] as never);
  await db.insert(schema.mailLabels).values([
    { id: 'label_seed_inbox', accountId: SHARED, name: 'Inbox', slug: 'INBOX', isSystem: true, createdAt: AT, updatedAt: AT },
    { id: 'label_seed_invoices', accountId: SHARED, name: 'Invoices', slug: 'invoices', isSystem: false, color: '#ff0000', createdAt: AT, updatedAt: AT },
    { id: 'label_seed_private', accountId: PRIVATE, name: 'Projects', slug: 'projects', isSystem: false, createdAt: AT, updatedAt: AT },
  ] as never);
}

export interface SeedMessage {
  id: string;
  accountId?: string;
  threadId?: string | null;
  subject?: string;
  from?: { email: string; name?: string };
  to?: Array<{ email: string; name?: string }>;
  labels?: string[];
  isRead?: boolean;
  minutes?: number;
  hasAttachments?: boolean;
  textBody?: string;
}

/** Messages `minutes` after the seed time, newest last. */
export async function seedMessages(db: Database, rows: SeedMessage[]): Promise<void> {
  await db.insert(schema.mailMessages).values(
    rows.map((m) => {
      const sent = new Date(AT.getTime() + (m.minutes ?? 0) * 60_000);
      const labels = m.labels ?? ['INBOX'];
      return {
        id: m.id,
        accountId: m.accountId ?? SHARED,
        messageId: `<${m.id}@acme.test>`,
        threadId: m.threadId === undefined ? `thread_${m.id}` : m.threadId,
        from: m.from ?? { email: 'customer@example.com', name: 'Customer' },
        to: m.to ?? [{ email: 'support@acme.test' }],
        subject: m.subject ?? `Subject ${m.id}`,
        preview: `Preview of ${m.id}`,
        textBody: m.textBody ?? `Body of ${m.id}`,
        htmlBody: `<p>Body of ${m.id}</p>`,
        sentDate: sent,
        receivedDate: sent,
        labels,
        isRead: m.isRead ?? false,
        isStarred: labels.includes('STARRED'),
        isTrash: labels.includes('TRASH'),
        isSpam: labels.includes('SPAM'),
        hasAttachments: m.hasAttachments ?? false,
        createdAt: sent,
        updatedAt: sent,
      };
    }) as never,
  );
}

export async function seedPeople(db: Database): Promise<void> {
  await db.insert(schema.people).values([
    { id: 'person_seed_1', firstName: 'Carla', lastName: 'Customer', displayName: 'Carla Customer', email: 'customer@example.com', avatarUrl: 'https://cdn.example.com/carla.png', createdAt: AT, updatedAt: AT },
  ] as never);
}
