/**
 * WeldDesk conversation messages — the `helpdesk_conversation_messages` surface.
 *
 * Ported from api-worker `src/routes/helpdesk/conversations.ts`
 * (GET|POST /:id/messages, PATCH /:id/messages/:messageId/respond) as part of
 * the W5b legacy-worker phase-out. Nothing in app-api read or wrote this table
 * before; `/api/ticket-messages` is a *different* table (helpdesk_ticket_messages)
 * and must not be crossed with it.
 *
 * Pure functions — no Hono context. Side effects that need `c` (entity events,
 * realtime, channel dispatch) stay in the route.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { MessageBlock, BlockResponse } from '@weldsuite/db/schema';

const { helpdeskConversations, helpdeskConversationMessages } = schema;

export interface ConversationMessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

/**
 * The legacy wire shape for a conversation message. Kept field-for-field so the
 * platform's `WeldDeskMessage` / message-thread consumers need no remapping.
 */
export interface ConversationMessageDto {
  id: string;
  conversationId: string;
  authorId: string | null;
  authorName: string;
  authorEmail: string | null;
  authorType: string;
  authorAvatar: string | null;
  content: string;
  htmlContent: string | null;
  plainContent: string | null;
  type: string;
  isPublic: boolean;
  isInternal: boolean | null;
  status: string | null;
  isRead: boolean;
  readAt: string | null;
  attachments: ConversationMessageAttachment[];
  hasAttachments: boolean | null;
  blocks: MessageBlock[] | null;
  blockResponses: Record<string, BlockResponse> | null;
  metadata: Record<string, unknown> | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

type MessageRow = typeof helpdeskConversationMessages.$inferSelect;

function toDto(msg: MessageRow): ConversationMessageDto {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    authorId: msg.authorId,
    authorName: msg.authorName,
    authorEmail: msg.authorEmail,
    authorType: msg.authorType,
    authorAvatar: msg.authorAvatar,
    content: msg.content,
    htmlContent: msg.htmlContent,
    plainContent: msg.plainContent,
    type: msg.type,
    isPublic: msg.isPublic,
    isInternal: msg.isInternal,
    status: msg.status,
    isRead: msg.isRead,
    readAt: msg.readAt?.toISOString() || null,
    attachments: msg.attachments || [],
    hasAttachments: msg.hasAttachments,
    // `blocks` / `blockResponses` were absent from the legacy GET projection
    // even though the platform renders Block Kit messages and the block-respond
    // route writes them — the thread only ever showed blocks that arrived over
    // realtime, and they vanished on refresh. Included here so a reload shows
    // the same thread the socket did.
    blocks: msg.blocks ?? null,
    blockResponses: msg.blockResponses ?? null,
    metadata: msg.metadata || undefined,
    createdAt: msg.createdAt?.toISOString(),
    updatedAt: msg.updatedAt?.toISOString(),
  };
}

/** Does this conversation exist (and is it not soft-deleted)? */
export async function conversationExists(db: Database, conversationId: string): Promise<boolean> {
  const rows = await db
    .select({ id: helpdeskConversations.id })
    .from(helpdeskConversations)
    .where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Fetch the full conversation row (needed for dispatch + auto-assign decisions). */
export async function getConversationForMessaging(db: Database, conversationId: string) {
  const [row] = await db
    .select()
    .from(helpdeskConversations)
    .where(and(eq(helpdeskConversations.id, conversationId), isNull(helpdeskConversations.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** List a conversation's messages, oldest first. */
export async function listConversationMessages(
  db: Database,
  conversationId: string,
): Promise<ConversationMessageDto[]> {
  const messages = await db
    .select()
    .from(helpdeskConversationMessages)
    .where(
      and(
        eq(helpdeskConversationMessages.conversationId, conversationId),
        isNull(helpdeskConversationMessages.deletedAt),
      ),
    )
    .orderBy(helpdeskConversationMessages.createdAt);

  return messages.map(toDto);
}

export interface CreateAgentMessageInput {
  conversationId: string;
  authorId: string;
  authorName?: string;
  content: string;
  contentHtml?: string;
  isInternal?: boolean;
  attachments?: ConversationMessageAttachment[];
  blocks?: MessageBlock[];
}

/**
 * Persist an agent message and roll the conversation's denormalised counters
 * forward. Returns the created row's wire shape.
 */
export async function createAgentMessage(
  db: Database,
  input: CreateAgentMessageInput,
): Promise<ConversationMessageDto> {
  const messageId = generateId('msg');
  const now = new Date();
  const hasAttachments = !!input.attachments && input.attachments.length > 0;
  const authorName = input.authorName || 'Agent';
  const isInternal = input.isInternal || false;

  const [row] = await db
    .insert(helpdeskConversationMessages)
    .values({
      id: messageId,
      conversationId: input.conversationId,
      authorId: input.authorId,
      authorName,
      authorType: 'agent',
      content: input.content,
      htmlContent: input.contentHtml,
      type: isInternal ? 'note' : 'message',
      isPublic: !isInternal,
      isInternal,
      status: 'sent',
      isRead: false,
      attachments: hasAttachments ? input.attachments : null,
      hasAttachments,
      blocks: input.blocks ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await db
    .update(helpdeskConversations)
    .set({
      lastMessage: (input.content || (hasAttachments ? 'Sent an attachment' : '')).substring(0, 500),
      lastMessageAt: now,
      lastAgentMessageAt: now,
      messageCount: sql`${helpdeskConversations.messageCount} + 1`,
      // Sticky: an old attachment must not be un-flagged by a later text-only
      // reply, so only ever set it true (legacy passed `undefined` to skip).
      ...(hasAttachments ? { hasAttachments: true } : {}),
      updatedAt: now,
    })
    .where(eq(helpdeskConversations.id, input.conversationId));

  return toDto(row);
}

/** Persist the "<agent> has joined the conversation" system message. */
export async function createAgentJoinedMessage(
  db: Database,
  conversationId: string,
  agentId: string,
  agentName: string,
): Promise<{ id: string; content: string; createdAt: Date }> {
  const id = generateId('msg');
  const now = new Date();
  const content = `${agentName} has joined the conversation`;

  await db.insert(helpdeskConversationMessages).values({
    id,
    conversationId,
    authorId: agentId,
    authorName: agentName,
    authorType: 'system',
    content,
    type: 'system',
    isPublic: true,
    isInternal: false,
    status: 'sent',
    isRead: true,
    metadata: { systemEvent: true },
    createdAt: now,
    updatedAt: now,
  });

  return { id, content, createdAt: now };
}

/**
 * Assign the conversation to the sending agent when it is unassigned or still
 * parked on the AI agent. Returns true when a write happened.
 */
export async function autoAssignOnAgentReply(
  db: Database,
  conversationId: string,
  currentAssigneeId: string | null,
  userId: string,
  authorName: string,
  isInternal: boolean,
): Promise<boolean> {
  const shouldAutoAssign = !isInternal && (!currentAssigneeId || currentAssigneeId === 'ai-agent');
  if (!shouldAutoAssign) return false;

  await db
    .update(helpdeskConversations)
    .set({ assigneeId: userId, assigneeName: authorName, updatedAt: new Date() })
    .where(eq(helpdeskConversations.id, conversationId));

  return true;
}

export type BlockResponseResult =
  | { ok: true; blockResponses: Record<string, BlockResponse> }
  | { ok: false; reason: 'not_found' | 'no_such_action' | 'already_responded' };

/**
 * Record a customer's response to an interactive block (button / form / rating
 * / file request). Idempotency is enforced per actionId — a second response to
 * the same action is rejected rather than overwriting the first.
 */
export async function recordBlockResponse(
  db: Database,
  conversationId: string,
  messageId: string,
  actionId: string,
  value: unknown,
): Promise<BlockResponseResult> {
  const [message] = await db
    .select()
    .from(helpdeskConversationMessages)
    .where(
      and(
        eq(helpdeskConversationMessages.id, messageId),
        eq(helpdeskConversationMessages.conversationId, conversationId),
      ),
    )
    .limit(1);

  if (!message) return { ok: false, reason: 'not_found' };

  const blocks = (message.blocks || []) as Array<{ actionId?: string; type: string }>;
  const targetBlock = blocks.find((b) => b.actionId === actionId);
  if (!targetBlock) return { ok: false, reason: 'no_such_action' };

  const existingResponses = (message.blockResponses || {}) as Record<string, BlockResponse>;
  if (existingResponses[actionId]) return { ok: false, reason: 'already_responded' };

  const responseType =
    targetBlock.type === 'input_form'
      ? 'form'
      : targetBlock.type === 'rating'
        ? 'rating'
        : targetBlock.type === 'file_request'
          ? 'file'
          : 'button';

  // `value` is caller-supplied and only narrows once paired with its block
  // type, which the union models per-variant — assert at the boundary rather
  // than re-validating every block shape here (legacy did the same).
  const responseEntry = {
    actionId,
    type: responseType,
    value,
    respondedAt: new Date().toISOString(),
  } as unknown as BlockResponse;

  const blockResponses: Record<string, BlockResponse> = {
    ...existingResponses,
    [actionId]: responseEntry,
  };

  await db
    .update(helpdeskConversationMessages)
    .set({ blockResponses, updatedAt: new Date() })
    .where(eq(helpdeskConversationMessages.id, messageId));

  return { ok: true, blockResponses };
}
