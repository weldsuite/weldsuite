/**
 * WeldDesk email channel helpers for the inbound pipeline: which attachments
 * of a customer email reach the conversation, where they are stored, and who
 * hears about a new email conversation.
 *
 * Notification rule (same as the chat widget, `helpdesk-widget-api`
 * `desk-live.ts`): a brand-new conversation, or a customer message that moves
 * the ball back to the team, notifies the assignee when there is one and
 * otherwise every active internal non-viewer teammate. A reply on an assigned
 * conversation keeps its existing assignee-only notification (which honours
 * the `notifyOnCustomerReply` setting), so nobody is notified twice.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { createAndDeliverNotification, helpdeskPreview } from '@weldsuite/notifications';
import {
  findDeskConversationByRfcMessageIds,
  findOpenEmailConversationByEmail,
  findRecentEmailConversation,
  normalizeEmailSubject,
  type DeskConversation,
} from '@weldsuite/db/lib/desk';
import { autoAssignDeskConversation, deskAssignmentRouterPicker } from '@weldsuite/db/lib/desk-assignment';
import { tenantSchema, type TenantDatabase } from '../db';
import type { Env } from '../index';
import type { ParsedAttachment, ParsedEmail } from './email-storage';
import { publishDeskAssigned } from './realtime';

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Most files kept per email. */
export const MAX_DESK_ATTACHMENTS = 20;
/** Total bytes kept per email (Cloudflare Email Routing caps a message at 25 MB anyway). */
export const MAX_DESK_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Shape `appendDeskMessage` stores in `desk_messages.attachments`. */
export interface DeskEmailAttachment {
  name: string;
  url: string;
  contentType: string;
  filesize: number;
}

/** Content ids (`cid:` targets) the HTML body embeds, without angle brackets. */
function inlineContentIds(htmlBody: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!htmlBody) return ids;
  for (const match of htmlBody.matchAll(/cid:([^"'\s>)]+)/gi)) {
    ids.add(decodeURIComponent(match[1] ?? '').toLowerCase());
  }
  return ids;
}

/**
 * The attachments worth showing an agent: real files, not the images the HTML
 * body embeds (logos, signature graphics) and not empty parts.
 */
export function selectDeskAttachments(
  attachments: ParsedAttachment[] | undefined,
  htmlBody?: string | null,
): ParsedAttachment[] {
  if (!attachments?.length) return [];
  const embedded = inlineContentIds(htmlBody);
  const kept: ParsedAttachment[] = [];
  let total = 0;
  for (const att of attachments) {
    if (kept.length >= MAX_DESK_ATTACHMENTS) break;
    if (att.content.length === 0) continue;
    const cid = att.contentId?.replace(/^</, '').replace(/>$/, '').toLowerCase();
    if (cid && embedded.has(cid)) continue;
    if (total + att.content.length > MAX_DESK_ATTACHMENT_BYTES) continue;
    total += att.content.length;
    kept.push(att);
  }
  return kept;
}

/**
 * Types served as-is from the public bucket. Anything else (HTML, SVG, …)
 * comes from an untrusted sender and could run script on the storage host,
 * so it is stored as a download — the same passive list desk-api accepts
 * from agents.
 */
const PASSIVE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** How a sender-supplied file is stored: passive types inline, the rest as a download. */
export function storedFileMetadata(
  contentType: string | undefined,
  fileName: string,
): { contentType: string; contentDisposition: string } {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (PASSIVE_TYPES.has(type)) return { contentType: type, contentDisposition: `inline; filename="${fileName}"` };
  return { contentType: 'application/octet-stream', contentDisposition: `attachment; filename="${fileName}"` };
}

function safeFileName(name: string): string {
  const cleaned = name.replaceAll(/[^a-zA-Z0-9._-]/g, '_').replaceAll(/^\.+/g, '');
  return cleaned.slice(-120) || 'attachment';
}

/**
 * Copy an email's attachments to the shared storage bucket under
 * `desk/<workspaceId>/inbound/<emailId>/…` and return them in the desk message
 * shape. The URL is the bucket's public URL, the same exposure the mail
 * pipeline's own attachment URLs already have (unguessable per-email path);
 * with no `R2_PUBLIC_URL` configured nothing is stored. A file that fails to
 * upload is skipped, never fails the email.
 */
export async function storeDeskAttachments(
  env: Pick<Env, 'STORAGE' | 'R2_PUBLIC_URL'>,
  workspaceId: string,
  emailId: string,
  attachments: ParsedAttachment[] | undefined,
  htmlBody?: string | null,
): Promise<DeskEmailAttachment[]> {
  // A loop, not `/\/+$/`, which backtracks.
  let publicUrl = env.R2_PUBLIC_URL ?? '';
  while (publicUrl.endsWith('/')) publicUrl = publicUrl.slice(0, -1);
  if (!env.STORAGE || !publicUrl) return [];

  const stored: DeskEmailAttachment[] = [];
  const files = selectDeskAttachments(attachments, htmlBody);
  for (let i = 0; i < files.length; i++) {
    const att = files[i]!;
    const fileName = safeFileName(att.fileName);
    const metadata = storedFileMetadata(att.contentType, fileName);
    const key = `desk/${workspaceId}/inbound/${emailId}/${i + 1}_${fileName}`;
    try {
      await env.STORAGE.put(key, att.content, { httpMetadata: metadata });
      stored.push({
        name: att.fileName || 'attachment',
        url: `${publicUrl}/${key}`,
        contentType: metadata.contentType,
        filesize: att.content.length,
      });
    } catch (err) {
      console.error(`[HelpdeskInbox] Failed to store attachment ${att.fileName}:`, err);
    }
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Auto-assignment
// ---------------------------------------------------------------------------

/**
 * Give an unowned email conversation to a teammate when the workspace has
 * auto-assignment on (`@weldsuite/db/lib/desk-assignment`), and push the
 * change live. Returns the conversation as it now stands; any failure leaves
 * it unassigned and never fails the email.
 */
export async function autoAssignDeskEmailConversation(
  env: Env,
  db: TenantDatabase,
  clerkOrgId: string,
  conversation: DeskConversation,
  generateId: (prefix: string) => string,
): Promise<DeskConversation> {
  if (conversation.assigneeId || conversation.state !== 'open') return conversation;
  try {
    const result = await autoAssignDeskConversation(db, {
      generateId,
      conversationId: conversation.id,
      pick: deskAssignmentRouterPicker(env.HELPDESK_WORKFLOW, clerkOrgId),
    });
    if (!result) return conversation;
    try {
      await publishDeskAssigned(env, clerkOrgId, result.conversation, result.message);
    } catch (err) {
      console.error(`[HelpdeskInbox] Failed to publish assignment of ${conversation.id}:`, err);
    }
    return result.conversation;
  } catch (err) {
    console.error(`[HelpdeskInbox] Auto-assignment failed for ${conversation.id}:`, err);
    return conversation;
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NOTIFY_BATCH = 10;
const MAX_RECIPIENTS = 200;

/** What a conversation looked like before the customer's email landed on it. */
export type PriorDeskState = Pick<DeskConversation, 'state' | 'waitingSince'>;

export type DeskNotifyAction =
  /** New conversation, or the ball moved back: assignee, else the team. */
  | 'notify'
  /** Reply on an assigned conversation: the existing assignee notification. */
  | 'assignee_reply'
  | 'none';

export function planDeskNotification(params: {
  created: boolean;
  assigneeId: string | null | undefined;
  /** State before this email; null when unknown or the conversation is new. */
  prior: PriorDeskState | null;
}): DeskNotifyAction {
  if (params.created) return 'notify';
  if (params.assigneeId) return 'assignee_reply';
  // The team has already been told when an open conversation is waiting on them.
  const alreadyWaiting = params.prior?.state === 'open' && params.prior.waitingSince !== null;
  return alreadyWaiting ? 'none' : 'notify';
}

/**
 * The conversation the email is about to land on, found the same way
 * `ingestDeskEmail` finds it. Best-effort: null when none (or on error), which
 * the planner reads as "team not yet told".
 */
export async function findPriorDeskState(
  db: TenantDatabase,
  email: Pick<ParsedEmail, 'from' | 'subject' | 'inReplyTo' | 'references'>,
): Promise<PriorDeskState | null> {
  try {
    const fromEmail = email.from.email.toLowerCase();
    const title = normalizeEmailSubject(email.subject) || email.subject || '';
    const found =
      (await findDeskConversationByRfcMessageIds(db, [email.inReplyTo, ...(email.references ?? [])])) ??
      (await findOpenEmailConversationByEmail(db, fromEmail)) ??
      (await findRecentEmailConversation(db, fromEmail, title));
    return found ? { state: found.state, waitingSince: found.waitingSince } : null;
  } catch (err) {
    console.error('[HelpdeskInbox] Prior conversation lookup failed:', err);
    return null;
  }
}

/** The notification text for a customer email. */
export function deskNotificationContent(params: {
  isNew: boolean;
  customerName: string;
  body: string | null | undefined;
  subject: string | null | undefined;
  attachmentNames?: string[];
}): { title: string; body: string } {
  const who = params.customerName.trim() || 'A customer';
  const files = params.attachmentNames?.filter(Boolean) ?? [];
  const body =
    helpdeskPreview(params.body) ||
    helpdeskPreview(params.subject) ||
    (files.length > 0 ? helpdeskPreview(`Sent ${files.join(', ')}`) : 'New email');
  return {
    title: params.isNew ? `New conversation from ${who}` : `${who} replied`,
    body,
  };
}

/** Active internal teammates who can work the inbox (viewers cannot). */
async function teamRecipients(db: TenantDatabase): Promise<string[]> {
  const { workspaceMembers } = tenantSchema;
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        isNull(workspaceMembers.deletedAt),
        eq(workspaceMembers.status, 'ACTIVE'),
        sql`upper(${workspaceMembers.memberType}) = 'INTERNAL'`,
        sql`upper(coalesce(${workspaceMembers.role}, '')) <> 'VIEWER'`,
      ),
    )
    .limit(MAX_RECIPIENTS);
  return Array.from(new Set(rows.map((r) => r.userId)));
}

/**
 * Notify the assignee, else the team, about a customer email. Best-effort:
 * failures are logged and never fail ingestion.
 */
export async function notifyDeskOfEmail(params: {
  db: TenantDatabase;
  env: Env;
  /** Clerk org id. */
  orgId: string;
  conversation: Pick<DeskConversation, 'id' | 'assigneeId'>;
  title: string;
  body: string;
}): Promise<void> {
  const { db, env, orgId, conversation, title, body } = params;
  try {
    const recipients = conversation.assigneeId ? [conversation.assigneeId] : await teamRecipients(db);
    for (let i = 0; i < recipients.length; i += NOTIFY_BATCH) {
      await Promise.allSettled(
        recipients.slice(i, i + NOTIFY_BATCH).map((userId) =>
          createAndDeliverNotification({
            db,
            env,
            workspaceId: orgId,
            userId,
            title,
            body,
            category: 'helpdesk',
            notificationType: 'message_received',
            entityType: 'desk_conversation',
            entityId: conversation.id,
            actionUrl: `/welddesk/inbox/${conversation.id}`,
            severity: 'info',
            actorType: 'system',
            actorId: null,
            data: { conversationId: conversation.id },
          }),
        ),
      );
    }
  } catch (err) {
    console.error(`[HelpdeskInbox] Team notification failed for ${conversation.id}:`, err);
  }
}
