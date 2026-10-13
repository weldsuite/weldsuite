/**
 * SendScheduledEmailWorkflow — Cloudflare Workflow
 *
 * Sleeps until the user-specified send time, then dispatches the stored message
 * via the Cloudflare send binding. Uses messageId as the workflow instance ID so
 * cancel / reschedule can look an instance up without a side table.
 *
 * Hosted in mail-api under the workflow names `send-scheduled-email-v3[-dev]`
 * (bound as SEND_SCHEDULED_EMAIL and re-exported from mail-api's src/index.ts,
 * where services/mail/scheduled.ts dispatches it) — no
 * `script_name`, so it also runs under local `wrangler dev` instead of
 * 503-ing on a missing cross-script binding. app-api keeps its old
 * `send-scheduled-email-v2*` names and re-exports this class only while their
 * in-flight instances drain (docs/plans/app-api-module-split.md, "Workflows
 * draining in app-api").
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import * as cfEmail from '@weldsuite/worker-email';
import type { OutboundKind } from '@weldsuite/app-api-client/schemas/outbound-mail';
import {
  OutboundDeniedError,
  checkOutbound,
  commitOutbound,
  releaseOutbound,
  type OutboundGuardEnv,
  type OutboundReservation,
} from '../outbound/guard';

/**
 * The bindings the workflow reads: tenant DB resolution, the Cloudflare send
 * binding (@weldsuite/worker-email), the R2 bucket holding the attachments and
 * the outbound guard's bindings. Any worker Env with them fits.
 */
export interface SendScheduledEmailEnv
  extends DbEnv,
    cfEmail.WorkerEmailEnv,
    Omit<OutboundGuardEnv, 'WORKSPACE_CACHE' | 'DATABASE_URL_MASTER' | 'NEON_API_KEY'> {
  /** R2 bucket holding the scheduled message's attachments. */
  STORAGE?: R2Bucket;
}

/**
 * How long a scheduled message may wait for a sending limit to clear before it
 * is marked failed (the outbound guard paces it; it must not wait forever).
 */
const MAX_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT_WAITS = 6;

/** What one send attempt came to. Serialisable: it is a Workflow step result. */
type SendOutcome =
  | { status: 'sent' | 'skipped' | 'failed' }
  | { status: 'deferred'; retryAfter: string; code: string };

export interface SendScheduledEmailParams {
  workspaceId: string;
  userId: string;
  messageId: string;
  accountId: string;
  scheduledFor: string; // ISO string
}

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
type MailMessageRow = typeof schema.mailMessages.$inferSelect;
type ResolvedAttachment = { filename: string; contentType?: string; content: ArrayBuffer };

/**
 * Why the stored message must not be sent by this instance (or null when it may).
 * Covers not-scheduled-anymore and stale-instance (reschedule) races.
 */
function getSkipReason(message: MailMessageRow, messageId: string, instanceId: string): string | null {
  // Guard: only send if still scheduled (prevents double delivery)
  if (message.sendStatus !== 'scheduled') {
    return `Message ${messageId} status is "${message.sendStatus}", skipping`;
  }

  // Guard: only the instance the row currently points at may send.
  // A reschedule creates a fresh instance and only best-effort-terminates
  // the old one (terminateWorkflow swallows failures), so a surviving
  // orphan would otherwise wake at its *original* time, still see
  // sendStatus 'scheduled', and send the mail early. This also covers the
  // api-worker → app-api cutover: instances created before the cutover
  // live in the old workflow and cannot be terminated via this binding.
  if (message.triggerRunId && message.triggerRunId !== instanceId) {
    return `Message ${messageId} is owned by instance ${message.triggerRunId}, not ${instanceId} — skipping stale instance`;
  }
  return null;
}

function buildExtraHeaders(message: MailMessageRow): Record<string, string> {
  const extraHeaders: Record<string, string> = {};
  if (message.inReplyTo) extraHeaders['In-Reply-To'] = message.inReplyTo;
  if (message.references && (message.references as string[]).length > 0) {
    extraHeaders['References'] = (message.references as string[]).join(' ');
  }
  return extraHeaders;
}

/**
 * Fetch attachments from R2. mail_attachments.storagePath holds the
 * fileKey written when the user clicked "Schedule".
 */
async function resolveAttachments(
  db: TenantDb,
  storage: R2Bucket | undefined,
  messageId: string,
): Promise<ResolvedAttachment[]> {
  const { mailAttachments } = schema;
  const attachmentRows = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.messageId, messageId), isNull(mailAttachments.deletedAt)));

  if (attachmentRows.length === 0 || !storage) return [];

  const resolved = await Promise.all(
    attachmentRows.map(async (row): Promise<ResolvedAttachment | null> => {
      if (!row.storagePath) return null;
      const obj = await storage.get(row.storagePath);
      if (!obj) {
        console.warn(`[SendScheduledEmail] Attachment ${row.id} missing from R2 at ${row.storagePath}`);
        return null;
      }
      return {
        filename: row.fileName,
        contentType: row.contentType || undefined,
        content: await obj.arrayBuffer(),
      };
    }),
  );
  return resolved.filter((att): att is ResolvedAttachment => att !== null);
}

/** `reply` only when the message answers mail someone sent to this mailbox. */
async function outboundKindOf(db: TenantDb, message: MailMessageRow): Promise<OutboundKind> {
  if (!message.inReplyTo) return 'new_thread';
  const { mailMessages } = schema;
  const [parent] = await db
    .select({ source: mailMessages.source })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, message.accountId), eq(mailMessages.messageId, message.inReplyTo)))
    .limit(1);
  return parent && parent.source !== 'sent' ? 'reply' : 'new_thread';
}

export class SendScheduledEmailWorkflow extends WorkflowEntrypoint<SendScheduledEmailEnv, SendScheduledEmailParams> {
  async run(event: WorkflowEvent<SendScheduledEmailParams>, step: WorkflowStep) {
    const { scheduledFor } = event.payload;

    // Sleep until the user-specified send time
    await step.sleepUntil('wait-until-scheduled', new Date(scheduledFor));

    // A sending limit defers the send instead of failing it: the workflow
    // sleeps until the limit clears, for up to a day, then gives up.
    const deadline = new Date(scheduledFor).getTime() + MAX_LIMIT_WAIT_MS;
    for (let attempt = 0; attempt <= MAX_LIMIT_WAITS; attempt++) {
      // Send with retries — the guard inside prevents double delivery on cancel/send-now races
      const outcome = await step.do(
        attempt === 0 ? 'send-email' : `send-email-${attempt}`,
        { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
        () => this.sendOnce(event, deadline, attempt === MAX_LIMIT_WAITS),
      );
      if (outcome.status !== 'deferred') return;
      await step.sleepUntil(`wait-sending-limit-${attempt}`, new Date(outcome.retryAfter));
    }
  }

  private async sendOnce(
    event: WorkflowEvent<SendScheduledEmailParams>,
    deadline: number,
    lastAttempt: boolean,
  ): Promise<SendOutcome> {
    const { workspaceId, messageId, accountId } = event.payload;
    const db = await getTenantDbForWorkspace(this.env, workspaceId);
    const { mailMessages, mailAccounts } = schema;

    const [message] = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
      .limit(1);

    if (!message) {
      console.log(`[SendScheduledEmail] Message ${messageId} not found, skipping`);
      return { status: 'skipped' };
    }

    const skipReason = getSkipReason(message, messageId, event.instanceId);
    if (skipReason) {
      console.log(`[SendScheduledEmail] ${skipReason}`);
      return { status: 'skipped' };
    }

    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
      .limit(1);

    if (!account) {
      console.error(`[SendScheduledEmail] Account ${accountId} not found, marking failed`);
      await db.update(mailMessages)
        .set({ sendStatus: 'failed', triggerRunId: null, updatedAt: new Date() })
        .where(eq(mailMessages.id, messageId));
      return { status: 'failed' };
    }

    const fromAddress = account.displayName
      ? `${account.displayName} <${account.email}>`
      : account.email;

    const addresses = (list: unknown): string[] =>
      ((list as Array<{ email?: string }> | null) ?? []).map((t) => t.email).filter((e): e is string => !!e);
    const toAddresses = addresses(message.to);
    const ccAddresses = addresses(message.cc);
    const bccAddresses = addresses(message.bcc);

    // ---- Outbound guard (docs/plans/weldmail-outbound-abuse.md) -----------
    let reservation: OutboundReservation;
    try {
      reservation = await checkOutbound(this.env, db, {
        subject: { kind: 'workspace', clerkOrgId: workspaceId },
        source: 'scheduled',
        kind: await outboundKindOf(db, message),
        from: account.email,
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subjectLine: message.subject,
        text: message.textBody,
        html: message.htmlBody,
        senderDailyCap: account.dailySendLimit,
      });
    } catch (err) {
      if (!(err instanceof OutboundDeniedError)) throw err;
      const retryAfter = err.details.retryAfter ? Date.parse(err.details.retryAfter) : NaN;
      if (!lastAttempt && !Number.isNaN(retryAfter) && retryAfter <= deadline) {
        console.log(`[SendScheduledEmail] ${messageId} deferred by ${err.code} until ${err.details.retryAfter}`);
        return { status: 'deferred', retryAfter: new Date(retryAfter).toISOString(), code: err.code };
      }
      console.warn(`[SendScheduledEmail] ${messageId} refused by the outbound guard: ${err.code}`);
      await db.update(mailMessages)
        .set({
          sendStatus: 'failed',
          triggerRunId: null,
          deliveryStatus: 'failed',
          deliveryDetail: err.message.slice(0, 500),
          deliveryUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mailMessages.id, messageId));
      return { status: 'failed' };
    }

    const extraHeaders = buildExtraHeaders(message);
    let sendResult: cfEmail.SendEmailResponse;
    try {
      const resolvedAttachments = await resolveAttachments(db, this.env.STORAGE, messageId);
      sendResult = await cfEmail.sendEmail(this.env, {
        from: fromAddress,
        to: toAddresses,
        subject: message.subject || '(No subject)',
        html: message.htmlBody || undefined,
        text: message.textBody || undefined,
        cc: ccAddresses.length ? ccAddresses : undefined,
        bcc: bccAddresses.length ? bccAddresses : undefined,
        headers: Object.keys(extraHeaders).length ? extraHeaders : undefined,
        attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
      });
    } catch (err) {
      const sent = (err as { sentRecipients?: unknown }).sentRecipients;
      if (Array.isArray(sent) && sent.length > 0) {
        await commitOutbound(this.env, db, reservation, { sentRecipients: sent as string[] });
      } else {
        await releaseOutbound(this.env, reservation);
      }
      throw err;
    }
    await commitOutbound(this.env, db, reservation);

    const now = new Date();
    const updatedLabels = ((message.labels as string[]) || []).filter(l => l !== 'SCHEDULED');

    await db.update(mailMessages)
      .set({
        sendStatus: 'sent',
        externalMessageId: sendResult.messageId,
        sentDate: now,
        triggerRunId: null,
        labels: updatedLabels,
        updatedAt: now,
      })
      .where(eq(mailMessages.id, messageId));

    await db.update(mailAccounts)
      .set({ sentToday: sql`${mailAccounts.sentToday} + 1`, updatedAt: now })
      .where(eq(mailAccounts.id, accountId));

    console.log(`[SendScheduledEmail] Sent ${messageId}, externalId: ${sendResult.messageId}`);
    return { status: 'sent' };
  }
}
