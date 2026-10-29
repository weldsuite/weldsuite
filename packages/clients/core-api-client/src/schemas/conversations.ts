import { z } from 'zod';

// `/api/conversations` — backed by `helpdesk_conversations`. A conversation
// is the top-level thread for an inbox/widget chat session; tickets attach
// to conversations.

export const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  customerId: z.string().nullish(),
  customerName: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional(),
  channel: z.string().max(30).optional(),
  status: z.string().max(30).optional(),
  assigneeId: z.string().nullish(),
  departmentId: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateConversationSchema = createConversationSchema.partial();

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

/** A `helpdesk_conversations` row as `/api/conversations` returns it: the linked contact laid over. */
export const helpdeskConversationSchema = z
  .object({
    id: z.string(),
    conversationNumber: z.string(),
    subject: z.string(),
    customerName: z.string(),
    customerEmail: z.string().nullable(),
    customerAvatarUrl: z.string().optional(),
    status: z.string(),
    channel: z.string().nullable(),
    assigneeId: z.string().nullable(),
    contactId: z.string().nullable(),
    tags: z.array(z.unknown()),
    labels: z.array(z.unknown()),
    isRead: z.boolean(),
    isStarred: z.boolean(),
    isArchived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A conversation message, as the thread (`GET /:id/messages`) and a reply return it. */
export const helpdeskConversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string(),
  authorEmail: z.string().nullable(),
  authorType: z.string(),
  authorAvatar: z.string().nullable(),
  content: z.string(),
  htmlContent: z.string().nullable(),
  plainContent: z.string().nullable(),
  type: z.string(),
  isPublic: z.boolean(),
  isInternal: z.boolean().nullable(),
  status: z.string().nullable(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  attachments: z.array(z.unknown()),
  hasAttachments: z.boolean().nullable(),
  blocks: z.array(z.unknown()).nullable(),
  blockResponses: z.record(z.unknown()).nullable(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/** `GET /api/conversations/folder-counts`. */
export const conversationFolderCountsSchema = z.object({
  all: z.number(),
  chat: z.number(),
  unassigned: z.number(),
  mine: z.number(),
  active: z.number(),
  pending: z.number(),
  resolved: z.number(),
  closed: z.number(),
});

/** A `helpdesk_conversation_events` row. */
export const helpdeskConversationEventSchema = z
  .object({ id: z.string(), conversationId: z.string(), eventType: z.string(), isPublic: z.boolean().nullable() })
  .passthrough();

/** `GET /api/conversations/:id/review`: the CSAT response, or null. */
export const conversationReviewSchema = z
  .object({
    id: z.string(),
    rating: z.number(),
    content: z.string(),
    reviewerName: z.string(),
    reviewerEmail: z.string(),
    createdAt: z.string(),
  })
  .nullable();

/** An `audit_logs` row. */
export const auditLogRowSchema = z
  .object({ id: z.string(), entityType: z.string(), entityId: z.string(), action: z.string(), createdAt: z.string() })
  .passthrough();

/** What a conversation sub-action answers: the id and the fields it changed. */
export const conversationActionSchema = z.object({ id: z.string() }).passthrough();

/** `PATCH /:id/messages/:messageId/respond`. */
export const blockResponseResultSchema = z.object({ messageId: z.string(), blockResponses: z.record(z.unknown()) });

/** `POST /:id/convert-to-ticket`. */
export const convertedTicketSchema = z.object({
  id: z.string(),
  ticketNumber: z.string(),
  subject: z.string(),
  status: z.string(),
  priority: z.string(),
  conversationId: z.string(),
  createdAt: z.string(),
});

/** `POST /:id/auto-link-contact`. */
export const autoLinkedContactSchema = z.object({ contactId: z.string() });
