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
 * All of it is best-effort: a realtime or notification failure never fails
 * the visitor's request.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { createAndDeliverNotification } from '@weldsuite/notifications';
import { schema, type Database } from '../db';
import type { Env } from '../index';
import {
  deskAuthorFromMember,
  isPublicDeskMessage,
  toPublicDeskConversation,
  toPublicDeskMessage,
  type DeskAuthorInfo,
  type DeskConversation,
  type DeskMessage,
  type PublicDeskConversation,
  type PublicDeskMessage,
} from '@weldsuite/db/lib/desk';

export type DeskAuthor = DeskAuthorInfo;
export type { PublicDeskMessage, PublicDeskConversation };

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

export const isPublicMessage = isPublicDeskMessage;
export const toPublicMessage = toPublicDeskMessage;
export const toPublicConversation = toPublicDeskConversation;

/** Push a new visitor message to the conversation room and the agents' inbox. */
export async function publishVisitorMessage(
  env: Env,
  orgId: string,
  conversation: DeskConversation,
  message: DeskMessage,
  visitorName: string,
  event: 'created' | 'updated',
): Promise<void> {
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME);
  const record = toPublicMessage(message, new Map());
  const results = await Promise.allSettled([
    rt.conversationPublish(conversation.id, {
      type: 'message',
      id: message.id,
      content: message.body ?? '',
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
    const rt = new RealtimePublisher(env.REALTIME);
    await rt.publish(orgId, 'desk_conversation', 'updated', conversation, 'system');
  } catch (err) {
    console.error('[widget-api] realtime publish failed:', err);
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
    const preview = (message.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
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
