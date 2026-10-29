/**
 * Scheduled-send row reads/writes for the Postgres mailbox store (design task
 * B4). `MailboxStore.listScheduled` and the `scheduled` op cover only the
 * `mail_messages` row itself — the Workflow orchestration (create/terminate a
 * `SEND_SCHEDULED_EMAIL` instance, attachment validation, `sendAndPersist`)
 * stays mail-api's job in `services/mail/scheduled.ts`; that service is wired
 * to call through the store instead of writing `mail_messages` directly in a
 * later task (D1).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailDeliveryStatus } from '@weldsuite/db/schema/mail-messages';
import { removeLabels } from '../model';

const { mailMessages } = schema;

/**
 * Live scheduled messages, soonest first — ported from
 * `services/mail/scheduled.ts`'s `listScheduled`. Takes an explicit account
 * or account list; `WorkspaceMailStore.listScheduled` passes the resolved
 * accessible-account scope (design task B4, "existing access bugs" item 9:
 * the mail-api original has no access filter in its all-accounts form).
 */
export async function listScheduled(db: Database, accountIds: string | string[]) {
  const scope = Array.isArray(accountIds) ? inArray(mailMessages.accountId, accountIds) : eq(mailMessages.accountId, accountIds);
  return db
    .select()
    .from(mailMessages)
    .where(and(isNull(mailMessages.deletedAt), eq(mailMessages.sendStatus, 'scheduled'), scope))
    .orderBy(mailMessages.scheduledFor);
}

export interface ScheduledPatch {
  sendStatus?: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  scheduledFor?: number | null;
  triggerRunId?: string | null;
  sentAt?: number;
  externalMessageId?: string;
  dropScheduledLabel?: boolean;
  softDelete?: boolean;
  delivery?: { status: MailDeliveryStatus; detail: string | null };
}

/**
 * Apply a `scheduled` op's patch to a message row: the field-level updates
 * `cancelScheduled`/`rescheduleScheduled`/`sendScheduledNow` each do today,
 * folded into one generic patch the op dispatcher can drive. `null`/`missing`
 * is for the caller (the message doesn't exist, or is already deleted).
 */
export async function applyScheduledPatch(
  db: Database,
  id: string,
  patch: ScheduledPatch,
  now: Date = new Date(),
): Promise<typeof mailMessages.$inferSelect | null> {
  const [existing] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: now };
  if (patch.sendStatus !== undefined) update.sendStatus = patch.sendStatus;
  if (patch.scheduledFor !== undefined) {
    update.scheduledFor = patch.scheduledFor == null ? null : new Date(patch.scheduledFor);
  }
  if (patch.triggerRunId !== undefined) update.triggerRunId = patch.triggerRunId;
  if (patch.sentAt !== undefined) update.sentDate = new Date(patch.sentAt);
  if (patch.externalMessageId !== undefined) update.externalMessageId = patch.externalMessageId;
  if (patch.delivery) {
    update.deliveryStatus = patch.delivery.status;
    update.deliveryDetail = patch.delivery.detail;
    update.deliveryUpdatedAt = now;
  }
  if (patch.dropScheduledLabel) {
    update.labels = removeLabels(existing.labels as string[] | null, 'SCHEDULED');
  }
  if (patch.softDelete) update.deletedAt = now;

  await db
    .update(mailMessages)
    .set(update as typeof mailMessages.$inferInsert)
    .where(eq(mailMessages.id, id));
  const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1);
  return after!;
}
