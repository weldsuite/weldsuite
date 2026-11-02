import { z } from 'zod';

// `/api/helpdesk-weldagent` — conversation records of conversations the AI
// agent handled. GET/POST /config answer 503 (`ai_unavailable`) with no data.

/** A `helpdesk_conversations` row as these routes return it (the raw row: tags and labels may be null). */
export const weldagentConversationRowSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    conversationNumber: z.string(),
    contactId: z.string().nullable(),
    customerName: z.string(),
    customerEmail: z.string().nullable(),
    subject: z.string(),
    preview: z.string().nullable(),
    lastMessage: z.string().nullable(),
    status: z.string(),
    priority: z.string().nullable(),
    assigneeId: z.string().nullable(),
    assigneeName: z.string().nullable(),
    departmentId: z.string().nullable(),
    channel: z.string(),
    messageCount: z.number(),
    unreadCount: z.number().nullable(),
    lastMessageAt: z.string().nullable(),
    isRead: z.boolean(),
    isStarred: z.boolean(),
    isArchived: z.boolean(),
    hasAttachments: z.boolean(),
    tags: z.array(z.string()).nullable(),
    labels: z.array(z.string()).nullable(),
    metadata: z.record(z.unknown()).nullable(),
  })
  .passthrough();

/** A `helpdesk_conversation_messages` row, raw. */
export const weldagentConversationMessageRowSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    conversationId: z.string(),
    authorId: z.string().nullable(),
    authorName: z.string(),
    authorType: z.string(),
    content: z.string(),
    type: z.string(),
    isPublic: z.boolean(),
    isInternal: z.boolean().nullable(),
    status: z.string().nullable(),
    isRead: z.boolean(),
    attachments: z.array(z.unknown()).nullable(),
    metadata: z.record(z.unknown()).nullable(),
  })
  .passthrough();

/** GET /conversations/:id: the conversation with its live messages, oldest first. */
export const weldagentConversationDetailSchema = weldagentConversationRowSchema.extend({
  messages: z.array(weldagentConversationMessageRowSchema),
});

/**
 * GET /conversations/ai-active and /ai-resolved: a page of conversations.
 * `page`, `pageSize` and `totalPages` are null where the route computed NaN or
 * Infinity (a page that is not a number, `pageSize=0`).
 */
export const weldagentConversationPageSchema = z.object({
  conversations: z.array(weldagentConversationRowSchema),
  pagination: z.object({
    page: z.number().nullable(),
    pageSize: z.number().nullable(),
    totalCount: z.number(),
    totalPages: z.number().nullable(),
  }),
});

/** POST /conversations. */
export const weldagentConversationCreatedSchema = z.object({
  id: z.string(),
  conversationNumber: z.string(),
  subject: z.string(),
  status: z.string(),
  assigneeId: z.string(),
  createdAt: z.string(),
});

/** POST /conversations/:id/messages. */
export const weldagentMessageCreatedSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  content: z.string(),
  role: z.enum(['user', 'assistant']),
  createdAt: z.string(),
});

/** POST /conversations/:id/transfer-to-human. */
export const weldagentTransferredSchema = z.object({
  conversationId: z.string(),
  status: z.literal('pending'),
  escalatedAt: z.string(),
});

/** POST /conversations/:id/accept. */
export const weldagentAcceptedSchema = z.object({
  conversationId: z.string(),
  assigneeId: z.string(),
  status: z.literal('active'),
  acceptedAt: z.string(),
});

/** POST /conversations/:id/convert-to-ticket. */
export const weldagentConvertedTicketSchema = z.object({
  ticketId: z.string(),
  ticketNumber: z.string(),
  subject: z.string(),
  status: z.literal('new'),
  priority: z.string(),
  conversationId: z.string(),
  createdAt: z.string(),
});
