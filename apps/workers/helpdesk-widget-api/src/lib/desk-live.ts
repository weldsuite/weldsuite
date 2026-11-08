/**
 * Live delivery for widget conversations.
 *
 * Every visitor write fans out three ways:
 *   1. ConversationRoom DO — the visitor's other tabs and any agent who has
 *      the conversation open get the message instantly (no refetch).
 *   2. WorkspaceHub `desk_conversation` / `desk_message` topics — every
 *      agent's inbox list re-sorts and updates without polling.
 *   3. In-app/push notifications — agents hear about a new conversation or a
 *      visitor reply even when the inbox isn't open.
 *
 * Rating and auto-assignment also publish a `desk_conversation` entity event to
 * the hub, so audit, webhooks and workflows see them like any other mutation.
 *
 * All of it is best-effort: a realtime or notification failure never fails
 * the visitor's request.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { createAndDeliverNotification } from '@weldsuite/notifications';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { schema, type Database } from '../db';
import type { Env } from '../index';
import {
  deskAuthorFromMember,
  toPublicDeskConversation,
  toPublicDeskMessage,
  type DeskAuthorInfo,
  type DeskConversation,
  type DeskMessage,
} from '@weldsuite/db/lib/desk';
import { autoAssignDeskConversation, deskAssignmentRouterPicker } from '@weldsuite/db/lib/desk-assignment';
import { routeAndAssignDeskConversation, type DeskRoutingStep } from '@weldsuite/db/lib/desk-routing';
import { generateId } from './id';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';

export type { PublicDeskMessage, PublicDeskConversation } from '@weldsuite/db/lib/desk';
export {
  isPublicDeskMessage as isPublicMessage,
  toPublicDeskConversation as toPublicConversation,
} from '@weldsuite/db/lib/desk';

export type DeskAuthor = DeskAuthorInfo;

/** Resolve agent display info (name + avatar) for a set of Clerk user ids. */
export async function resolveAuthors(
  db: Database,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, DeskAuthor>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  const out = new Map<string, DeskAuthor>();
  if (ids.length === 0) return out;
  const { workspaceMembers } = schema;
  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      name: workspaceMembers.name,
      picture: workspaceMembers.picture,
    })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, ids));
  for (const row of rows) out.set(row.userId, deskAuthorFromMember(row));
  return out;
}

export const toPublicMessage = toPublicDeskMessage;

/** Plain-text summary of a message for previews and notifications: its body, or its file names. */
function messageText(message: DeskMessage): string {
  const body = (message.body ?? '').trim();
  if (body) return body;
  const files = message.attachments ?? [];
  if (files.length === 0) return '';
  const more = files.length > 1 ? ` +${files.length - 1}` : '';
  return `📎 ${files[0].name}${more}`;
}

/**
 * Push a new visitor message to the conversation room and the agents' inbox,
 * and to the hub as entity events (`desk_conversation created` for a new
 * conversation, `desk_message created`), so WeldConnect workflows triggered
 * by messenger conversations run.
 */
export async function publishVisitorMessage(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
  message: DeskMessage,
  visitorName: string,
  event: 'created' | 'updated',
): Promise<void> {
  await Promise.all([
    ...(event === 'created' ? [publishConversationEntityEvent(env, orgId, conversation, 'created')] : []),
    publishEntityEventRaw({
      env,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'desk_message',
      action: 'created',
      entityId: message.id,
      data: message as unknown as Record<string, unknown>,
    }),
  ]);
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
  const record = toPublicMessage(message, new Map());
  const results = await Promise.allSettled([
    rt.conversationPublish(conversation.id, {
      type: 'message',
      id: message.id,
      content: messageText(message),
      senderId: `visitor:${message.authorId ?? ''}`,
      senderName: visitorName,
      senderType: 'visitor',
      ts: Date.now(),
      record,
    }),
    rt.publish(orgId, 'desk_conversation', event, conversation, 'system'),
    rt.publish(orgId, 'desk_message', 'created', message, 'system'),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[widget-api] realtime publish failed:', result.reason);
    }
  }
}

export async function publishConversationUpdated(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
): Promise<void> {
  if (!env.REALTIME) return;
  try {
    const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
    await rt.publish(orgId, 'desk_conversation', 'updated', conversation, 'system');
  } catch (err) {
    console.error('[widget-api] realtime publish failed:', err);
  }
}

/**
 * Hub entity event for a conversation mutation the widget worker made (a
 * rating, an auto-assignment). Runs in `waitUntil`, so it takes the context-free
 * publisher; that never throws, and no-ops when `ENTITY_EVENTS` isn't bound.
 */
async function publishConversationEntityEvent(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
  action: 'created' | 'updated' | 'assigned',
): Promise<void> {
  await publishEntityEventRaw({
    env,
    workspaceId: orgId,
    userId: 'system',
    entityType: 'desk_conversation',
    action,
    entityId: conversation.id,
    data: conversation as unknown as Record<string, unknown>,
  });
}

/**
 * Push a visitor-made timeline event (a rating, or the auto-assignment it
 * triggered) to the agents' inbox and to the conversation room, where the
 * visitor's other tabs pick it up as a system event carrying the updated
 * conversation. `authors` must hold the assignee, or those tabs lose the
 * assignee's name and avatar. `entityAction` is the hub event published
 * alongside: `assigned` for an assignment, `updated` for a rating.
 */
export async function publishVisitorEvent(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
  message: DeskMessage,
  authors: Map<string, DeskAuthor>,
  entityAction: 'updated' | 'assigned' = 'updated',
): Promise<void> {
  await Promise.all([
    publishConversationEntityEvent(env, orgId, conversation, entityAction),
    publishVisitorEventRealtime(env, orgId, conversation, message, authors),
  ]);
}

async function publishVisitorEventRealtime(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
  message: DeskMessage,
  authors: Map<string, DeskAuthor>,
): Promise<void> {
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
  const record = toPublicMessage(message, authors);
  const results = await Promise.allSettled([
    rt.conversationPublish(conversation.id, {
      type: 'system',
      event: record.eventType ?? 'event',
      data: {
        state: conversation.state,
        conversation: toPublicDeskConversation(conversation, authors),
        record,
      },
      ts: Date.now(),
    }),
    rt.publish(orgId, 'desk_conversation', 'updated', conversation, 'system'),
    rt.publish(orgId, 'desk_message', 'created', message, 'system'),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[widget-api] realtime publish failed:', result.reason);
    }
  }
}

/** A routing rule's ticket-field change: internal, so the inbox only (never the visitor's room). */
async function publishInternalEvent(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
  message: DeskMessage,
): Promise<void> {
  await publishConversationEntityEvent(env, orgId, conversation, 'updated');
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
  const results = await Promise.allSettled([
    rt.publish(orgId, 'desk_conversation', 'updated', conversation, 'system'),
    rt.publish(orgId, 'desk_message', 'created', message, 'system'),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('[widget-api] realtime publish failed:', result.reason);
  }
}

/**
 * Routing and auto-assignment. A conversation the visitor just `opened` goes
 * through the workspace's routing rules first (`@weldsuite/db/lib/desk-routing`:
 * team, priority, tags, a named owner); then an open, unowned conversation
 * goes to a teammate (its team's members when it has any, else the roster)
 * when the workspace has auto-assignment on. Every step is pushed live: the
 * `assigned` event so the widget shows who joined, a rule's field change to
 * the inbox only. Returns the conversation as it now stands; on any failure
 * it simply stays as it was.
 */
export async function autoAssignConversation(
  env: Env,
  db: Database,
  orgId: string,
  conversation: DeskConversation,
  opened = false,
): Promise<DeskConversation> {
  if (!opened && (conversation.assigneeId || conversation.state !== 'open')) return conversation;
  try {
    const pick = deskAssignmentRouterPicker(env.WORKFLOW_WORKER, orgId);
    let steps: DeskRoutingStep[];
    let slaCheckAt: Date | null;
    if (opened) {
      ({ steps, slaCheckAt } = await routeAndAssignDeskConversation(db, {
        generateId,
        conversationId: conversation.id,
        pick,
        trigger: 'opened',
        // A team the customer picked (the help-center request form) stays.
        keepTeam: Boolean(conversation.departmentId),
      }));
    } else {
      const result = await autoAssignDeskConversation(db, { generateId, conversationId: conversation.id, pick });
      steps = result ? [{ conversation: result.conversation, message: result.message, action: 'assigned' }] : [];
      slaCheckAt = result?.slaCheckAt ?? null;
    }
    if (steps.length === 0) return conversation;
    // The owner and the team can change which SLA policy applies.
    if (slaCheckAt) await markWorkspaceDue(env.SCHEDULE_INDEX, 'desk_sla', orgId, slaCheckAt);
    for (const step of steps) {
      if (step.action === 'assigned') {
        const authors = await resolveAuthors(db, [step.conversation.assigneeId]);
        await publishVisitorEvent(env, orgId, step.conversation, step.message, authors, 'assigned');
      } else {
        await publishInternalEvent(env, orgId, step.conversation, step.message);
      }
    }
    return steps[steps.length - 1]!.conversation;
  } catch (err) {
    console.error('[widget-api] routing / auto-assignment failed:', err);
    return conversation;
  }
}

const NOTIFY_BATCH = 10;
const MAX_RECIPIENTS = 200;

/**
 * Who hears about a visitor message: the assignee when there is one,
 * otherwise every active internal teammate who can work the inbox.
 */
async function notificationRecipients(db: Database, conversation: DeskConversation): Promise<string[]> {
  if (conversation.assigneeId) return [conversation.assigneeId];
  const { workspaceMembers } = schema;
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        sql`upper(${workspaceMembers.status}) = 'ACTIVE'`,
        sql`upper(${workspaceMembers.memberType}) = 'INTERNAL'`,
        sql`upper(${workspaceMembers.role}) <> 'VIEWER'`,
      ),
    )
    .limit(MAX_RECIPIENTS);
  return Array.from(new Set(rows.map((r) => r.userId)));
}

/**
 * Notify the team about a visitor message. Only fires when the conversation
 * starts or when the ball moves back to the team (the first visitor message
 * after an agent reply) — a visitor typing five lines in a row is one
 * notification, not five.
 */
export async function notifyTeamOfVisitorMessage(params: {
  env: Env;
  db: Database;
  orgId: string;
  conversation: DeskConversation;
  message: DeskMessage;
  visitorName: string;
  isNewConversation: boolean;
}): Promise<void> {
  const { env, db, orgId, conversation, message, visitorName, isNewConversation } = params;
  try {
    const recipients = await notificationRecipients(db, conversation);
    const preview = messageText(message).replace(/\s+/g, ' ').trim().slice(0, 180);
    const title = isNewConversation
      ? `New conversation from ${visitorName}`
      : `${visitorName} replied`;

    for (let i = 0; i < recipients.length; i += NOTIFY_BATCH) {
      const batch = recipients.slice(i, i + NOTIFY_BATCH);
      await Promise.allSettled(
        batch.map((userId) =>
          createAndDeliverNotification({
            db,
            env,
            workspaceId: orgId,
            userId,
            title,
            body: preview,
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
    console.error('[widget-api] team notification failed:', err);
  }
}

/** Look up the visitor's display name for realtime payloads + notifications. */
export async function visitorDisplayName(
  db: Database,
  visitorId: string,
  fallback?: { name?: string | null; email?: string | null },
): Promise<string> {
  if (fallback?.name?.trim()) return fallback.name.trim();
  if (fallback?.email?.trim()) return fallback.email.trim();
  const { deskVisitors } = schema;
  const [row] = await db
    .select({ name: deskVisitors.name, email: deskVisitors.email })
    .from(deskVisitors)
    .where(eq(deskVisitors.id, visitorId))
    .limit(1);
  return row?.name?.trim() || row?.email?.trim() || 'Visitor';
}
