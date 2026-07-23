/**
 * Scheduled mail service — store-then-send via a Cloudflare Workflow.
 *
 * Compose flow:
 *   1. Validate the request and resolve any R2-uploaded attachments
 *      (HEAD each fileKey so the size we cap on is the real one, not
 *      what the client claimed).
 *   2. Insert a `mail_messages` row in `scheduled` status with labels
 *      `['SENT', 'SCHEDULED']` and the chosen `scheduledFor` timestamp.
 *   3. Create attachment rows so the workflow can re-fetch from R2 at
 *      delivery time without an extra DB round trip.
 *   4. Kick off the `SEND_SCHEDULED_EMAIL` workflow with the messageId
 *      as the instance id — gives cancel/reschedule trivial lookup
 *      semantics later.
 *
 * Send-now and reschedule terminate the existing workflow first to
 * eliminate any double-fire race. Send-now then drives the same
 * `sendAndPersist` path the regular compose endpoint uses, so the
 * "send via Cloudflare" code lives in one place.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';
import { sendAndPersist, MAX_EMAIL_SIZE_BYTES, type SendAttachmentInput } from './send';

const { mailAccounts, mailAttachments, mailMessages } = schema;

export const MAX_SCHEDULE_DAYS = 7;

export class MailScheduledError extends Error {
  constructor(
    public readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'MESSAGE_NOT_FOUND'
      | 'NOT_SCHEDULED'
      | 'SCHEDULE_IN_PAST'
      | 'SCHEDULE_TOO_FAR'
      | 'ATTACHMENT_NOT_IN_WORKSPACE'
      | 'ATTACHMENT_NOT_IN_STORAGE'
      | 'EMAIL_TOO_LARGE'
      | 'STORAGE_BINDING_MISSING'
      | 'WORKFLOW_BINDING_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'MailScheduledError';
  }
}

function assertScheduleWindow(scheduledFor: Date) {
  const now = new Date();
  if (scheduledFor <= now) {
    throw new MailScheduledError('SCHEDULE_IN_PAST', 'Scheduled time must be in the future');
  }
  const maxDate = new Date(now.getTime() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000);
  if (scheduledFor > maxDate) {
    throw new MailScheduledError(
      'SCHEDULE_TOO_FAR',
      `Scheduled time must be within ${MAX_SCHEDULE_DAYS} days`,
    );
  }
}

export interface ScheduleEmailInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  replyTo?: string;
  importance?: 'low' | 'normal' | 'high';
  attachmentIds?: string[];
  attachments?: SendAttachmentInput[];
  scheduledFor: string;
  inReplyTo?: string;
  references?: string[];
}

export async function scheduleEmail(
  env: Env,
  db: Database,
  workspaceId: string,
  userId: string,
  data: ScheduleEmailInput,
) {
  const scheduledFor = new Date(data.scheduledFor);
  assertScheduleWindow(scheduledFor);
  if (!env.SEND_SCHEDULED_EMAIL) {
    throw new MailScheduledError(
      'WORKFLOW_BINDING_MISSING',
      'Scheduled-send workflow binding is not configured for this environment.',
    );
  }

  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, data.accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new MailScheduledError('ACCOUNT_NOT_FOUND', 'Mail account not found');

  // HEAD each attachment so the cap check uses the real size, not the
  // client-reported one. Wallet-thinness over latency: workflow delivery
  // failure 7 days later would be a confusing UX.
  const validated = await validateScheduledAttachments(env, workspaceId, data);
  const totalAttachmentCount = (data.attachmentIds?.length ?? 0) + validated.length;

  const messageId = generateId('msg');
  const smtpMessageId = `<${messageId}@scheduled.weldsuite.org>`;
  const now = new Date();
  // Sanitize before storing; the delivery workflow re-sends this stored copy.
  const htmlBody = sanitizeEmailHtml(data.htmlBody) || undefined;
  const textPreview = (data.body || (htmlBody ?? '').replace(/<[^>]*>/g, '')).slice(0, 200);

  await db.insert(mailMessages).values({
    id: messageId,
    accountId: data.accountId,
    messageId: smtpMessageId,
    threadId: smtpMessageId,
    from: { email: account.email, name: account.displayName ?? undefined },
    to: data.to.map((email) => ({ email })),
    cc: data.cc?.map((email) => ({ email })),
    bcc: data.bcc?.map((email) => ({ email })),
    subject: data.subject || '(No subject)',
    preview: textPreview,
    textBody: data.body,
    htmlBody,
    sentDate: now,
    isRead: true,
    source: 'sent',
    inReplyTo: data.inReplyTo,
    references: data.references,
    isReply: !!data.inReplyTo,
    hasAttachments: totalAttachmentCount > 0,
    attachmentCount: totalAttachmentCount,
    labels: ['SENT', 'SCHEDULED'],
    scheduledFor,
    sendStatus: 'scheduled',
    createdAt: now,
    updatedAt: now,
  });

  // Re-parent any pre-uploaded attachments (legacy two-step compose) and
  // create rows for the freshly-uploaded ones so the workflow can fetch
  // them from R2 at delivery time.
  if (data.attachmentIds?.length) {
    for (const attachmentId of data.attachmentIds) {
      await db
        .update(mailAttachments)
        .set({ messageId, updatedAt: now })
        .where(eq(mailAttachments.id, attachmentId));
    }
  }
  for (const att of validated) {
    await db.insert(mailAttachments).values({
      id: generateId('attach'),
      messageId,
      fileName: att.filename,
      contentType: att.contentType ?? 'application/octet-stream',
      size: att.size,
      storagePath: att.fileKey,
      isInline: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Workflow instance id == messageId — cancel/reschedule routes look it
  // up by message id without an extra column.
  const instance = await env.SEND_SCHEDULED_EMAIL.create({
    id: messageId,
    params: {
      workspaceId,
      userId,
      messageId,
      accountId: data.accountId,
      scheduledFor: scheduledFor.toISOString(),
    },
  });

  await db
    .update(mailMessages)
    .set({ triggerRunId: instance.id, updatedAt: new Date() })
    .where(eq(mailMessages.id, messageId));

  return {
    messageId,
    smtpMessageId,
    scheduledFor: scheduledFor.toISOString(),
    triggerRunId: instance.id,
  };
}

export async function listScheduled(db: Database, filters: { accountId?: string }) {
  const conditions = [isNull(mailMessages.deletedAt), eq(mailMessages.sendStatus, 'scheduled')];
  if (filters.accountId) conditions.push(eq(mailMessages.accountId, filters.accountId));
  return db
    .select()
    .from(mailMessages)
    .where(and(...conditions))
    .orderBy(mailMessages.scheduledFor);
}

export async function cancelScheduled(env: Env, db: Database, messageId: string) {
  const [message] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!message) throw new MailScheduledError('MESSAGE_NOT_FOUND', 'Message not found');
  if (message.sendStatus !== 'scheduled') {
    throw new MailScheduledError('NOT_SCHEDULED', 'Message is not in scheduled state');
  }

  if (message.triggerRunId) await terminateWorkflow(env, message.triggerRunId);

  const now = new Date();
  await db
    .update(mailMessages)
    .set({
      sendStatus: 'cancelled',
      scheduledFor: null,
      triggerRunId: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(mailMessages.id, messageId));
  return { id: messageId };
}

export async function rescheduleScheduled(
  env: Env,
  db: Database,
  workspaceId: string,
  userId: string,
  messageId: string,
  newScheduledFor: Date,
) {
  assertScheduleWindow(newScheduledFor);
  if (!env.SEND_SCHEDULED_EMAIL) {
    throw new MailScheduledError(
      'WORKFLOW_BINDING_MISSING',
      'Scheduled-send workflow binding is not configured for this environment.',
    );
  }

  const [message] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!message) throw new MailScheduledError('MESSAGE_NOT_FOUND', 'Message not found');
  if (message.sendStatus !== 'scheduled') {
    throw new MailScheduledError('NOT_SCHEDULED', 'Message is not in scheduled state');
  }

  if (message.triggerRunId) await terminateWorkflow(env, message.triggerRunId);

  // Suffix the new instance id so it can never collide with the
  // just-terminated one (CF reserves a grace period after terminate
  // during which the old id is unusable).
  const newInstanceId = `${messageId}-r${Date.now()}`;
  const instance = await env.SEND_SCHEDULED_EMAIL.create({
    id: newInstanceId,
    params: {
      workspaceId,
      userId,
      messageId,
      accountId: message.accountId,
      scheduledFor: newScheduledFor.toISOString(),
    },
  });

  await db
    .update(mailMessages)
    .set({
      scheduledFor: newScheduledFor,
      sendStatus: 'scheduled',
      triggerRunId: instance.id,
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, messageId));

  return { scheduledFor: newScheduledFor.toISOString(), triggerRunId: instance.id };
}

/**
 * Terminate the workflow, hydrate the stored message + attachments,
 * then drive them through `sendAndPersist` so the same Cloudflare
 * send path the live compose endpoint uses runs here. Marks the row
 * `sent` and clears the SCHEDULED label.
 */
export async function sendScheduledNow(
  env: Env,
  db: Database,
  workspaceId: string,
  userId: string,
  messageId: string,
) {
  const [message] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!message) throw new MailScheduledError('MESSAGE_NOT_FOUND', 'Message not found');
  if (message.sendStatus !== 'scheduled') {
    throw new MailScheduledError('NOT_SCHEDULED', 'Message is not in scheduled state');
  }
  if (message.triggerRunId) await terminateWorkflow(env, message.triggerRunId);

  // Rehydrate the persisted attachment rows back into the
  // SendComposeInput shape that sendAndPersist expects.
  const attachmentRows = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.messageId, messageId), isNull(mailAttachments.deletedAt)));
  const attachments: SendAttachmentInput[] = attachmentRows
    .filter((r) => !!r.storagePath)
    .map((r) => ({
      filename: r.fileName,
      contentType: r.contentType ?? undefined,
      size: r.size,
      fileKey: r.storagePath!,
    }));

  const toAddresses = ((message.to as { email?: string }[] | null) ?? [])
    .map((t) => t.email!)
    .filter(Boolean);
  const ccAddresses = ((message.cc as { email?: string }[] | null) ?? [])
    .map((t) => t.email!)
    .filter(Boolean);
  const bccAddresses = ((message.bcc as { email?: string }[] | null) ?? [])
    .map((t) => t.email!)
    .filter(Boolean);

  const result = await sendAndPersist(
    env,
    db,
    workspaceId,
    userId,
    message.accountId,
    {
      to: toAddresses,
      cc: ccAddresses.length ? ccAddresses : undefined,
      bcc: bccAddresses.length ? bccAddresses : undefined,
      subject: message.subject ?? undefined,
      body: message.textBody ?? undefined,
      htmlBody: message.htmlBody ?? undefined,
      inReplyTo: message.inReplyTo ?? undefined,
      references: (message.references as string[] | null) ?? undefined,
      attachments: attachments.length ? attachments : undefined,
    },
  );

  // The stored row stays as the canonical SENT copy for this thread;
  // mark it sent + drop the SCHEDULED label rather than creating a
  // second row.
  const now = new Date();
  const updatedLabels = ((message.labels as string[] | null) ?? []).filter((l) => l !== 'SCHEDULED');
  await db
    .update(mailMessages)
    .set({
      sendStatus: 'sent',
      scheduledFor: null,
      sentDate: now,
      externalMessageId: result.externalMessageId,
      triggerRunId: null,
      labels: updatedLabels,
      updatedAt: now,
    })
    .where(eq(mailMessages.id, messageId));

  // Bump the daily counter for the originating account — sendAndPersist
  // already incremented for the new row it created, so don't double-count.
  // (Send-now reuses the existing scheduled row, but sendAndPersist still
  // increments — we want the counter to reflect the one delivered email,
  // not two.)
  await db
    .update(mailAccounts)
    .set({ sentToday: sql`GREATEST(0, ${mailAccounts.sentToday} - 1)`, updatedAt: now })
    .where(eq(mailAccounts.id, message.accountId));

  return { id: messageId, externalMessageId: result.externalMessageId };
}

async function validateScheduledAttachments(
  env: Env,
  workspaceId: string,
  data: ScheduleEmailInput,
) {
  if (!data.attachments?.length) return [];
  if (!env.STORAGE) {
    throw new MailScheduledError(
      'STORAGE_BINDING_MISSING',
      'Storage binding not configured',
    );
  }
  const workspacePrefix = `workspaces/${workspaceId}/`;
  let totalBytes =
    (data.body ? new TextEncoder().encode(data.body).byteLength : 0) +
    (data.htmlBody ? new TextEncoder().encode(data.htmlBody).byteLength : 0);

  const validated: Array<SendAttachmentInput & { contentType?: string }> = [];
  for (const att of data.attachments) {
    if (!att.fileKey.startsWith(workspacePrefix)) {
      throw new MailScheduledError(
        'ATTACHMENT_NOT_IN_WORKSPACE',
        `Attachment ${att.filename} is not in this workspace`,
      );
    }
    const head = await env.STORAGE.head(att.fileKey);
    if (!head) {
      throw new MailScheduledError(
        'ATTACHMENT_NOT_IN_STORAGE',
        `Attachment ${att.filename} not found in storage`,
      );
    }
    totalBytes += head.size;
    if (totalBytes > MAX_EMAIL_SIZE_BYTES) {
      throw new MailScheduledError(
        'EMAIL_TOO_LARGE',
        `Email exceeds the ${MAX_EMAIL_SIZE_BYTES / (1024 * 1024)} MB limit (body + attachments).`,
      );
    }
    validated.push({
      filename: att.filename,
      contentType: att.contentType || head.httpMetadata?.contentType,
      size: head.size,
      fileKey: att.fileKey,
    });
  }
  return validated;
}

async function terminateWorkflow(env: Env, instanceId: string): Promise<void> {
  if (!env.SEND_SCHEDULED_EMAIL) return;
  try {
    const instance = await env.SEND_SCHEDULED_EMAIL.get(instanceId);
    await instance.terminate();
  } catch (err) {
    // Best-effort: a terminated/missing instance is fine — the row state
    // is what callers care about. Log so a real binding failure is visible.
    console.warn(
      `[mail-scheduled] failed to terminate workflow instance ${instanceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
