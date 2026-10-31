import { z } from 'zod';

export const DESK_CHANNELS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api'] as const;
export const DESK_CONVERSATION_STATES = ['open', 'closed'] as const;
export const DESK_CONVERSATION_SORTS = ['newest', 'oldest', 'waiting_longest', 'sla_due'] as const;
export const DESK_MESSAGE_KINDS = ['message', 'note', 'event'] as const;
export const DESK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
/** Mirrors DESK_MAX_TAGS / DESK_MAX_TAG_LENGTH in @weldsuite/db/lib/desk. */
export const DESK_MAX_TAGS = 20;
export const DESK_MAX_TAG_LENGTH = 50;

export const listConversationsQuerySchema = z.object({
  state: z.enum(DESK_CONVERSATION_STATES).optional(),
  assigneeId: z.string().max(255).optional(),
  unassigned: z.coerce.boolean().optional(),
  channel: z.enum(DESK_CHANNELS).optional(),
  /** One widget visitor's conversations (customer panel when there's no email). */
  visitorId: z.string().max(64).optional(),
  /** Exact customer email (case-insensitive): a customer's other conversations. */
  email: z.string().trim().max(255).optional(),
  /** The caller's own key from `POST /v1/conversations`: at most one conversation. */
  externalId: z.string().trim().max(255).optional(),
  /** Free-text search over customer, subject, number and message text. */
  q: z.string().trim().max(200).optional(),
  /** A priority, or `none` for conversations without one. */
  priority: z.enum([...DESK_PRIORITIES, 'none']).optional(),
  ticketTypeId: z.string().max(30).optional(),
  /** The team (helpdesk department). */
  departmentId: z.string().max(30).optional(),
  tag: z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH).optional(),
  sort: z.enum(DESK_CONVERSATION_SORTS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const getConversationQuerySchema = z.object({
  include: z.enum(['messages']).optional(),
});

export const deskMessageAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(2000),
  contentType: z.string().max(255),
  filesize: z.number().int().nonnegative(),
  width: z.number().optional(),
  height: z.number().optional(),
});

/** A reply needs text, files, or both. */
export const replyToConversationSchema = z
  .object({
    kind: z.enum(['message', 'note']).default('message'),
    body: z.string().trim().max(20_000).default(''),
    attachments: z.array(deskMessageAttachmentSchema).max(10).optional(),
  })
  .refine((data) => data.body.length > 0 || (data.attachments?.length ?? 0) > 0, {
    message: 'A reply needs a message or an attachment',
    path: ['body'],
  });

export const manageConversationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('open') }),
  z.object({
    action: z.literal('assign'),
    assigneeId: z.string().max(255).nullish(),
  }),
]);

// ── responses ────────────────────────────────────────────────────────────────

/** A `desk_conversations` row, as /api/desk/conversations answers it. */
export const deskConversationSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    conversationNumber: z.number().int(),
    title: z.string().nullable(),
    state: z.enum(DESK_CONVERSATION_STATES),
    channel: z.enum(DESK_CHANNELS),
    visitorId: z.string().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    contactId: z.string().nullable(),
    assigneeId: z.string().nullable(),
    ticketTypeId: z.string().nullable(),
    priority: z.enum(DESK_PRIORITIES).nullable(),
    tags: z.array(z.string()),
    departmentId: z.string().nullable(),
    waitingSince: z.string().nullable(),
    lastMessageAt: z.string().nullable(),
    lastMessagePreview: z.string().nullable(),
    rating: z.number().int().nullable(),
    ratingComment: z.string().nullable(),
    ratedAt: z.string().nullable(),
    externalId: z.string().nullable(),
  })
  .passthrough();

/** A `desk_messages` row: a chat message, an internal note or an event. */
export const deskMessageSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    conversationId: z.string(),
    kind: z.enum(DESK_MESSAGE_KINDS),
    body: z.string().nullable(),
    authorType: z.enum(['visitor', 'agent', 'bot', 'system']),
    authorId: z.string().nullable(),
    attachments: z.array(deskMessageAttachmentSchema.passthrough()).nullable(),
    metadata: z.record(z.unknown()).nullable(),
  })
  .passthrough();

/** The type's custom field values, slug → value. */
const deskConversationCustomFieldsSchema = z.record(z.unknown());

/** GET /api/desk/conversations/:id: the conversation and its custom fields, with its timeline under `?include=messages`. */
export const deskConversationDetailSchema = deskConversationSchema.extend({
  customFields: deskConversationCustomFieldsSchema,
  messages: z.array(deskMessageSchema).optional(),
});

/** GET /api/desk/conversations/attributes: what the details panel can pick. */
export const deskConversationAttributeOptionsSchema = z.object({
  ticketTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      icon: z.string().nullable(),
      color: z.string().nullable(),
    }),
  ),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  fields: z.array(
    z.object({
      id: z.string(),
      ticketTypeId: z.string().nullable(),
      slug: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      fieldType: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string(), color: z.string().optional() })).nullable(),
      required: z.boolean(),
      sortOrder: z.number().int(),
    }),
  ),
  tags: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});

/** PATCH /api/desk/conversations/:id: the conversation with its custom fields, and the `attributes_changed` event (null when nothing changed). */
export const deskConversationAttributesChangeSchema = z.object({
  conversation: deskConversationSchema.extend({ customFields: deskConversationCustomFieldsSchema }),
  message: deskMessageSchema.nullable(),
});

/** POST /api/desk/conversations/:id/attachments: the stored file, ready to send in a reply. */
export const deskUploadedAttachmentSchema = z.object({
  name: z.string(),
  url: z.string(),
  contentType: z.string(),
  filesize: z.number().int().nonnegative(),
});

/** POST /api/desk/conversations/:id/{reply,manage}: the conversation after the change, and the new timeline entry. */
export const deskConversationChangeSchema = z.object({
  conversation: deskConversationSchema,
  message: deskMessageSchema,
});

/**
 * The conversation's ticket fields. Omitted fields are left alone, null
 * clears one, `tags` replaces the list, and `customFields` patches the
 * type's fields by slug.
 */
export const updateConversationAttributesSchema = z
  .object({
    ticketTypeId: z.string().max(30).nullable().optional(),
    priority: z.enum(DESK_PRIORITIES).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH)).max(DESK_MAX_TAGS).optional(),
    departmentId: z.string().max(30).nullable().optional(),
    customFields: z.record(z.string().max(100), z.unknown()).optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

// ---------------------------------------------------------------------------
// From outside the inbox: the public API (`/v1/conversations`), the MCP server
// and workflows. Rows are written by `@weldsuite/desk-domain/inbox`.
// ---------------------------------------------------------------------------

/** Open a conversation in the inbox, or add to the one that carries `externalId`. */
export const openDeskConversationSchema = z.object({
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Your own key for what this is about (an alert id, an order number). Sending the same key again adds the message to that conversation, reopening it if it was closed, instead of starting a new one.',
    ),
  title: z.string().trim().max(500).optional().describe('Subject shown in the inbox'),
  body: z.string().trim().min(1).max(20_000).describe('The message, as the customer or sending system wrote it'),
  name: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('Who it is from: the customer, or the sending system (e.g. "Datadog")'),
  email: z.string().trim().email().max(255).optional().describe("The customer's email address, if there is one"),
  contactId: z.string().max(30).optional().describe('The WeldCRM person it is about'),
  // Ticket fields (ADR DESK-007). Set on a repeat too, so an alert can escalate.
  ticketTypeId: z.string().max(30).optional().describe('The ticket type'),
  priority: z.enum(DESK_PRIORITIES).optional(),
  tags: z.array(z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH)).max(DESK_MAX_TAGS).optional(),
  departmentId: z.string().max(30).optional().describe('The team'),
});

/**
 * Change a conversation's state, owner or ticket fields; each change lands on
 * its timeline. Ticket fields follow `updateConversationAttributesSchema`:
 * null clears one, `tags` replaces the list, `customFields` patches by slug.
 */
export const updateDeskConversationSchema = z
  .object({
    state: z.enum(DESK_CONVERSATION_STATES).optional().describe('open or closed'),
    assigneeId: z
      .string()
      .max(255)
      .nullable()
      .optional()
      .describe("The teammate's user id, or null to unassign"),
    ticketTypeId: z.string().max(30).nullable().optional(),
    priority: z.enum(DESK_PRIORITIES).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH)).max(DESK_MAX_TAGS).optional(),
    departmentId: z.string().max(30).nullable().optional(),
    customFields: z.record(z.string().max(100), z.unknown()).optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Give a state, an assignee or a ticket field to change',
  });

/** A reply to the customer (api and messenger conversations) or an internal note. */
export const addDeskConversationMessageSchema = z.object({
  kind: z
    .enum(['message', 'note'])
    .default('note')
    .describe('note stays inside the team; message is a reply the customer sees'),
  body: z.string().trim().min(1).max(20_000),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type UpdateConversationAttributesInput = z.infer<typeof updateConversationAttributesSchema>;
export type OpenDeskConversationInput = z.infer<typeof openDeskConversationSchema>;
export type UpdateDeskConversationInput = z.infer<typeof updateDeskConversationSchema>;
export type AddDeskConversationMessageInput = z.infer<typeof addDeskConversationMessageSchema>;
export type ReplyToConversationInput = z.infer<typeof replyToConversationSchema>;
export type DeskMessageAttachmentInput = z.infer<typeof deskMessageAttachmentSchema>;
export type ManageConversationInput = z.infer<typeof manageConversationSchema>;
