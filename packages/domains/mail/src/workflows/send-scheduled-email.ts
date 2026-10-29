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
import { getTenantDbForWorkspace, getWorkspaceForOrg, schema } from '@weldsuite/worker-kit/db';
import { getStoredObject, type StorageBindings } from '@weldsuite/worker-kit/storage';
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
import { getWorkspaceMail, type MailboxStore, type MailStoreEnv, type MailStoreMode } from '../store';

/**
 * The bindings the workflow reads: tenant DB resolution, the Cloudflare send
 * binding (@weldsuite/worker-email), the R2 bucket holding the attachments,
 * the outbound guard's bindings, and (design task D1) the mailbox store's own
 * bindings — this workflow reads and updates the scheduled message through
 * `getWorkspaceMail` rather than `mail_messages` directly, since it runs
 * outside a request and so has no `workspaceMailFromContext` to resolve it
 * for it. Any worker Env with them fits; mail-api, which hosts this
 * workflow, already binds everything `MailStoreEnv` lists.
 */
export interface SendScheduledEmailEnv
  extends DbEnv,
    cfEmail.WorkerEmailEnv,
    Omit<OutboundGuardEnv, 'WORKSPACE_CACHE' | 'DATABASE_URL_MASTER' | 'NEON_API_KEY'>,
    MailStoreEnv {
  /** R2 buckets holding the scheduled message's attachments (private first) — unused once a workspace reads attachments through the store instead. */
  STORAGE?: R2Bucket;
  PRIVATE_STORAGE?: R2Bucket;
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
type ResolvedAttachment = { filename: string; contentType?: string; content: ArrayBuffer };

/**
 * The fields this workflow reads off the scheduled message — a narrower
 * shape than the Postgres row so a `MailboxStore.getMessage` record (design
 * task D1: this workflow reads and updates the message through the store,
 * since it runs outside a request and has no `workspaceMailFromContext` to
 * resolve one for it) satisfies it too.
 */
interface MailMessageRow {
  id: string;
  accountId: string;
  messageId: string;
  sendStatus: string | null;
  triggerRunId: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  inReplyTo: string | null;
  references: unknown;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  labels: unknown;
}

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
 * fileKey written when the user clicked "Schedule". The attachment rows
 * themselves come through the store (`listAttachments`) when one is
 * supplied, else the direct-Postgres rows, unchanged.
 */
async function resolveAttachments(
  db: TenantDb,
  store: MailboxStore | undefined,
  storage: StorageBindings,
  messageId: string,
): Promise<ResolvedAttachment[]> {
  const attachmentRows = store
    ? await store.listAttachments(messageId)
    : await db
        .select()
        .from(schema.mailAttachments)
        .where(and(eq(schema.mailAttachments.messageId, messageId), isNull(schema.mailAttachments.deletedAt)));

  if (attachmentRows.length === 0 || (!storage.STORAGE && !storage.PRIVATE_STORAGE)) return [];

  const resolved = await Promise.all(
    attachmentRows.map(async (row): Promise<ResolvedAttachment | null> => {
      if (!row.storagePath) return null;
      const obj = await getStoredObject(storage, row.storagePath);
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
    const { store, mode } = await resolveMailboxStore(this.env, workspaceId, accountId, db);

    const loaded = await loadScheduledSend(db, store, messageId, accountId, event.instanceId);
    if ('status' in loaded) return loaded;
    const { message, account } = loaded;
    const recipients = recipientsOf(message);

    // ---- Outbound guard (docs/plans/weldmail-outbound-abuse.md) -----------
    // The guard call stays exactly as it was (design task D1): only
    // `mailStoreMode` is new, so the workspace's `MailIndex` can answer first
    // contacts authoritatively once the workspace is `object-only`.
    const reservation = await reserveScheduledSend(
      this.env,
      db,
      workspaceId,
      message,
      account,
      recipients,
      { deadline, lastAttempt, mailStoreMode: mode },
      store,
    );
    if ('status' in reservation) return reservation;

    const sendResult = await transmitScheduledSend(this.env, db, store, message, account, recipients, reservation);
    await markScheduledSent(db, store, message, accountId, sendResult.messageId);
    console.log(`[SendScheduledEmail] Sent ${messageId}, externalId: ${sendResult.messageId}`);
    return { status: 'sent' };
  }
}

type MailAccountRow = typeof schema.mailAccounts.$inferSelect;
type ScheduledRecipients = { to: string[]; cc: string[]; bcc: string[] };

/**
 * Resolve the account's mailbox store for this instance (design task D1:
 * "the Workflow reads and updates the message through the store; it runs
 * outside a request, so it resolves the store with `getWorkspaceMail` from
 * the Workflow env and the workspace id"). `event.payload.workspaceId` is
 * the Clerk org id (same convention `services/mail/scheduled.ts` and
 * `send.ts` use their own "workspaceId"/"orgId" parameters for) — the master
 * `workspaces.id` `getWorkspaceMail` actually keys on is looked up from it.
 *
 * Never throws: a workspace that can't be resolved (a stale/removed org,
 * `getWorkspaceForOrg` erroring) falls back to `{store: undefined, mode:
 * undefined}`, so every caller below takes its already-existing
 * direct-Postgres path — today's behaviour, unchanged.
 */
async function resolveMailboxStore(
  env: SendScheduledEmailEnv,
  clerkOrgId: string,
  accountId: string,
  db: TenantDb,
): Promise<{ store: MailboxStore | undefined; mode: MailStoreMode | undefined }> {
  try {
    const { id: workspaceId } = await getWorkspaceForOrg(env, clerkOrgId);
    const workspaceMail = await getWorkspaceMail(env, {
      workspaceId,
      clerkOrgId,
      db,
      // Nothing here needs to outlive this step: best-effort, like the
      // snooze-sweep cron's own system-principal call into this factory.
      waitUntil: (p) => {
        p.catch(() => undefined);
      },
      // A system sweep, not a user request — `MailAccess` is never consulted
      // on this path (no route, no permission check), so the principal only
      // has to be a valid one.
      principal: { kind: 'workspace', keyId: 'system:send-scheduled-email' },
    });
    return { store: workspaceMail.store.mailbox(accountId), mode: workspaceMail.mode };
  } catch (err) {
    console.warn(
      '[SendScheduledEmail] could not resolve the mailbox store, falling back to Postgres:',
      err instanceof Error ? err.message : err,
    );
    return { store: undefined, mode: undefined };
  }
}

/** The message and its account, or why this instance must not send it. */
async function loadScheduledSend(
  db: TenantDb,
  store: MailboxStore | undefined,
  messageId: string,
  accountId: string,
  instanceId: string,
): Promise<{ message: MailMessageRow; account: MailAccountRow } | SendOutcome> {
  const { mailAccounts } = schema;
  const message = await loadScheduledMessage(db, store, messageId);
  if (!message) {
    console.log(`[SendScheduledEmail] Message ${messageId} not found, skipping`);
    return { status: 'skipped' };
  }

  const skipReason = getSkipReason(message, messageId, instanceId);
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
    await markScheduledFailed(db, store, messageId, { sendStatus: 'failed', triggerRunId: null });
    return { status: 'failed' };
  }
  return { message, account };
}

/** `store.getMessage(id, {bodies: true})` when one is supplied, else the direct-Postgres row, unchanged. */
async function loadScheduledMessage(db: TenantDb, store: MailboxStore | undefined, messageId: string): Promise<MailMessageRow | null> {
  if (store) {
    const row = await store.getMessage(messageId, { bodies: true });
    if (!row) return null;
    return { ...row, textBody: row.textBody ?? null, htmlBody: row.htmlBody ?? null };
  }
  const { mailMessages } = schema;
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The failure/skip writes below all patch the same handful of fields on the
 * scheduled row. Through the store's `scheduled` op when one is supplied,
 * else the direct-Postgres update, unchanged.
 */
async function markScheduledFailed(
  db: TenantDb,
  store: MailboxStore | undefined,
  messageId: string,
  patch: {
    sendStatus: 'failed';
    triggerRunId: null;
    delivery?: { status: 'failed'; detail: string };
  },
): Promise<void> {
  const now = new Date();
  if (store) {
    await store.apply({ kind: 'scheduled', id: messageId, patch: { ...patch, delivery: patch.delivery ?? undefined } }, now.getTime());
    return;
  }
  const { mailMessages } = schema;
  await db
    .update(mailMessages)
    .set({
      sendStatus: patch.sendStatus,
      triggerRunId: patch.triggerRunId,
      ...(patch.delivery
        ? { deliveryStatus: patch.delivery.status, deliveryDetail: patch.delivery.detail, deliveryUpdatedAt: now }
        : {}),
      updatedAt: now,
    })
    .where(eq(mailMessages.id, messageId));
}

function recipientsOf(message: MailMessageRow): ScheduledRecipients {
  const addresses = (list: unknown): string[] =>
    ((list as Array<{ email?: string }> | null) ?? []).map((t) => t.email).filter((e): e is string => !!e);
  return { to: addresses(message.to), cc: addresses(message.cc), bcc: addresses(message.bcc) };
}

/**
 * Ask the outbound guard. A limit that clears before the deadline defers the
 * send; any other refusal fails the message with the reason.
 */
async function reserveScheduledSend(
  env: SendScheduledEmailEnv,
  db: TenantDb,
  workspaceId: string,
  message: MailMessageRow,
  account: MailAccountRow,
  recipients: ScheduledRecipients,
  timing: { deadline: number; lastAttempt: boolean; mailStoreMode: MailStoreMode | undefined },
  store?: MailboxStore,
): Promise<OutboundReservation | SendOutcome> {
  try {
    return await checkOutbound(env, db, {
      subject: { kind: 'workspace', clerkOrgId: workspaceId },
      source: 'scheduled',
      kind: await outboundKindOf(db, message),
      from: account.email,
      ...recipients,
      subjectLine: message.subject,
      text: message.textBody,
      html: message.htmlBody,
      senderDailyCap: account.dailySendLimit,
      mailStoreMode: timing.mailStoreMode,
    });
  } catch (err) {
    if (!(err instanceof OutboundDeniedError)) throw err;
    const retryAfter = err.details.retryAfter ? Date.parse(err.details.retryAfter) : NaN;
    if (!timing.lastAttempt && !Number.isNaN(retryAfter) && retryAfter <= timing.deadline) {
      console.log(`[SendScheduledEmail] ${message.id} deferred by ${err.code} until ${err.details.retryAfter}`);
      return { status: 'deferred', retryAfter: new Date(retryAfter).toISOString(), code: err.code };
    }
    console.warn(`[SendScheduledEmail] ${message.id} refused by the outbound guard: ${err.code}`);
    await markScheduledFailed(db, store, message.id, {
      sendStatus: 'failed',
      triggerRunId: null,
      delivery: { status: 'failed', detail: err.message.slice(0, 500) },
    });
    return { status: 'failed' };
  }
}

/** Send through Cloudflare and settle the reservation: commit what went out, release the rest. */
async function transmitScheduledSend(
  env: SendScheduledEmailEnv,
  db: TenantDb,
  store: MailboxStore | undefined,
  message: MailMessageRow,
  account: MailAccountRow,
  recipients: ScheduledRecipients,
  reservation: OutboundReservation,
): Promise<cfEmail.SendEmailResponse> {
  const fromAddress = account.displayName ? `${account.displayName} <${account.email}>` : account.email;
  const extraHeaders = buildExtraHeaders(message);
  try {
    const resolvedAttachments = await resolveAttachments(db, store, env, message.id);
    const result = await cfEmail.sendEmail(env, {
      from: fromAddress,
      to: recipients.to,
      subject: message.subject || '(No subject)',
      html: message.htmlBody || undefined,
      text: message.textBody || undefined,
      cc: recipients.cc.length ? recipients.cc : undefined,
      bcc: recipients.bcc.length ? recipients.bcc : undefined,
      headers: Object.keys(extraHeaders).length ? extraHeaders : undefined,
      attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
    });
    await commitOutbound(env, db, reservation);
    return result;
  } catch (err) {
    const sent = (err as { sentRecipients?: unknown }).sentRecipients;
    if (Array.isArray(sent) && sent.length > 0) {
      await commitOutbound(env, db, reservation, { sentRecipients: sent as string[] });
    } else {
      await releaseOutbound(env, reservation);
    }
    throw err;
  }
}

/**
 * Never anywhere else does a scheduled message get marked sent — only this
 * function, after `transmitScheduledSend` really handed it to Cloudflare
 * (design task D1). Through the store's `scheduled` op when one is supplied;
 * `sentToday` stays a direct Postgres bump either way (design §1: "P").
 */
async function markScheduledSent(
  db: TenantDb,
  store: MailboxStore | undefined,
  message: MailMessageRow,
  accountId: string,
  externalMessageId: string,
): Promise<void> {
  const { mailAccounts } = schema;
  const now = new Date();

  if (store) {
    await store.apply(
      {
        kind: 'scheduled',
        id: message.id,
        patch: { sendStatus: 'sent', externalMessageId, sentAt: now.getTime(), triggerRunId: null, dropScheduledLabel: true },
      },
      now.getTime(),
    );
  } else {
    const { mailMessages } = schema;
    const updatedLabels = ((message.labels as string[]) || []).filter((l) => l !== 'SCHEDULED');
    await db
      .update(mailMessages)
      .set({
        sendStatus: 'sent',
        externalMessageId,
        sentDate: now,
        triggerRunId: null,
        labels: updatedLabels,
        updatedAt: now,
      })
      .where(eq(mailMessages.id, message.id));
  }

  await db.update(mailAccounts)
    .set({ sentToday: sql`${mailAccounts.sentToday} + 1`, updatedAt: now })
    .where(eq(mailAccounts.id, accountId));
}
