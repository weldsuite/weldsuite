/**
 * Snooze service — moves a message from INBOX to SNOOZED with an
 * `until` timestamp. Auto-unsnooze (when `until` passes) is
 * `wakeDueSnoozedMessages`: the cron sweep (src/cron/snooze-sweep.ts) runs it
 * for every workspace with a mailbox, and the thread listing runs it for the
 * mailbox being opened so a due mail is back the moment someone looks.
 *
 * Snooze metadata lives in dedicated `mail_messages` columns
 * (`snoozed_until`, `snoozed_at`, ...). It used to be tucked into the
 * `custom_fields` JSONB blob; migration 0169 gave it real columns and
 * this service was cut over (docs/custom-fields-blob-extraction.md).
 *
 * Migration-window read fallback: a message snoozed by the OLD code path,
 * after the data extraction ran but before this cutover deployed, has its
 * `snoozedUntil` only in the blob. Reads therefore prefer the column and
 * fall back to the blob. Writes only ever touch columns. Remove the
 * fallback once the blob column is dropped in Phase 4.
 */

import { and, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { addLabels, removeLabels } from './labels';

const { mailAccounts, mailMessages } = schema;

export class MailSnoozeError extends Error {
  constructor(
    public readonly code:
      | 'MESSAGE_NOT_FOUND'
      | 'NOT_SNOOZED'
      | 'SNOOZE_IN_PAST',
    message: string,
  ) {
    super(message);
    this.name = 'MailSnoozeError';
  }
}

/** Legacy blob shape — read-only fallback for the migration window. */
interface SnoozeCustomFields extends Record<string, unknown> {
  snoozedUntil?: string | null;
  snoozedAt?: string;
  unsnoozeTriggerRunId?: string | null;
}

type MessageRow = typeof mailMessages.$inferSelect;

/** Is this message currently snoozed? Column first, blob as legacy fallback. */
function readSnoozedUntil(m: MessageRow): Date | string | null {
  if (m.snoozedUntil) return m.snoozedUntil;
  const cf = (m.customFields as SnoozeCustomFields | null) ?? {};
  return cf.snoozedUntil ?? null;
}

async function findMessage(db: Database, accountId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.id, messageId),
        eq(mailMessages.accountId, accountId),
        isNull(mailMessages.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function snoozeMessage(
  db: Database,
  accountId: string,
  messageId: string,
  until: Date,
) {
  if (until <= new Date()) {
    throw new MailSnoozeError('SNOOZE_IN_PAST', 'Snooze time must be in the future');
  }
  const message = await findMessage(db, accountId, messageId);
  if (!message) throw new MailSnoozeError('MESSAGE_NOT_FOUND', 'Message not found');

  const labels = (message.labels as string[] | null) ?? [];
  await db
    .update(mailMessages)
    .set({
      labels: addLabels(removeLabels(labels, 'INBOX'), 'SNOOZED'),
      isRead: true,
      snoozedUntil: until,
      snoozedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId));

  return { id: messageId, snoozedUntil: until.toISOString() };
}

export async function unsnoozeMessage(
  db: Database,
  accountId: string,
  messageId: string,
) {
  const message = await findMessage(db, accountId, messageId);
  if (!message) throw new MailSnoozeError('MESSAGE_NOT_FOUND', 'Message not found');

  if (!readSnoozedUntil(message)) {
    throw new MailSnoozeError('NOT_SNOOZED', 'Message is not snoozed');
  }

  const labels = (message.labels as string[] | null) ?? [];
  await db
    .update(mailMessages)
    .set({
      labels: addLabels(removeLabels(labels, 'SNOOZED'), 'INBOX'),
      isRead: false,
      snoozedUntil: null,
      unsnoozeTriggerRunId: null,
      unsnoozedAt: new Date(),
      unsnoozedEarly: true,
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId));

  return { id: messageId };
}

export async function resnoozeMessage(
  db: Database,
  accountId: string,
  messageId: string,
  until: Date,
) {
  if (until <= new Date()) {
    throw new MailSnoozeError('SNOOZE_IN_PAST', 'Snooze time must be in the future');
  }
  const message = await findMessage(db, accountId, messageId);
  if (!message) throw new MailSnoozeError('MESSAGE_NOT_FOUND', 'Message not found');

  await db
    .update(mailMessages)
    .set({
      snoozedUntil: until,
      resnoozedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId));

  return { id: messageId, snoozedUntil: until.toISOString() };
}

/**
 * Wake every snoozed message whose time has come: SNOOZED goes, INBOX comes
 * back, and the mail is unread again so it stands out as it would have on
 * arrival. One statement, driven by the `snoozed_until` index. `scope`
 * narrows it to some accounts (an extra condition on `mail_messages`).
 *
 * Mail that was trashed or marked spam while snoozed has no SNOOZED label any
 * more (a move clears it), so it is never brought back.
 */
export async function wakeDueSnoozedMessages(
  db: Database,
  options: { now?: Date; scope?: SQL } = {},
): Promise<{ woken: number; accountIds: string[] }> {
  const now = options.now ?? new Date();
  const conditions: SQL[] = [
    isNull(mailMessages.deletedAt)!,
    lte(mailMessages.snoozedUntil, now),
    sql`${mailMessages.labels} @> '["SNOOZED"]'::jsonb`,
  ];
  if (options.scope) conditions.push(options.scope);

  const rows = await db
    .update(mailMessages)
    .set({
      labels: sql`((${mailMessages.labels} - 'SNOOZED') - 'INBOX') || '["INBOX"]'::jsonb`,
      isRead: false,
      snoozedUntil: null,
      unsnoozeTriggerRunId: null,
      unsnoozedAt: now,
      unsnoozedEarly: false,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning({ accountId: mailMessages.accountId });
  return { woken: rows.length, accountIds: [...new Set(rows.map((r) => r.accountId))] };
}

/**
 * Return every message tagged `SNOOZED`, optionally restricted to a
 * single account. Projects the snooze-relevant `customFields` up to
 * the top level so callers don't have to dig into the JSONB blob.
 */
export async function listSnoozedMessages(
  db: Database,
  filters: { accountId?: string },
) {
  let accountIds: string[];
  if (filters.accountId) {
    const [account] = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, filters.accountId), isNull(mailAccounts.deletedAt)))
      .limit(1);
    accountIds = account ? [account.id] : [];
  } else {
    const rows = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(isNull(mailAccounts.deletedAt));
    accountIds = rows.map((r) => r.id);
  }
  if (accountIds.length === 0) return [];

  const rows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        inArray(mailMessages.accountId, accountIds),
        isNull(mailMessages.deletedAt),
        sql`${mailMessages.labels} @> '["SNOOZED"]'::jsonb`,
      ),
    );

  return rows.map((m) => {
    // Column first; fall back to the legacy blob for the migration window.
    const cf = (m.customFields as SnoozeCustomFields | null) ?? {};
    const toIso = (v: Date | string | null | undefined) => {
      if (v == null) return null;
      return v instanceof Date ? v.toISOString() : v;
    };
    return {
      id: m.id,
      accountId: m.accountId,
      subject: m.subject,
      from: m.from,
      snoozedUntil: toIso(m.snoozedUntil) ?? cf.snoozedUntil ?? null,
      snoozedAt: toIso(m.snoozedAt) ?? cf.snoozedAt ?? null,
      triggerRunId: m.unsnoozeTriggerRunId ?? cf.unsnoozeTriggerRunId ?? null,
      createdAt: m.createdAt?.toISOString() ?? null,
    };
  });
}
