import { z } from 'zod';

/**
 * `/api/desk/conversations` — WeldDesk v2 (Intercom-model) conversation core.
 *
 * See .claude/welddesk-intercom-plan.md §5 for the schema this validates
 * against (packages/db/src/schema/desk-conversations.ts +
 * desk-conversation-parts.ts). Phase 1 covers conversation + part CRUD only —
 * tickets/workflows/SLA fields exist on the row but are set by later phases.
 */

// ---------------------------------------------------------------------------
// Shared enums (mirror the DB `$type<>()` unions)
// ---------------------------------------------------------------------------

export const DESK_CHANNELS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api'] as const;
export const DESK_CONVERSATION_STATES = ['open', 'snoozed', 'closed'] as const;
export const DESK_DELIVERED_AS = [
  'customer_initiated',
  'admin_initiated',
  'automated',
  'campaign_initiated',
] as const;
export const DESK_CONVERSATION_SORTS = [
  'newest',
  'oldest',
  'waiting_longest',
  'priority_first',
] as const;

// ---------------------------------------------------------------------------
// Create / list conversations
// ---------------------------------------------------------------------------

export const createConversationSchema = z.object({
  channel: z.enum(DESK_CHANNELS),
  /** Defaults to 'admin_initiated' for POST / (admin-composed conversations). */
  deliveredAs: z.enum(DESK_DELIVERED_AS).optional(),
  title: z.string().max(500).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().min(1),
  contactId: z.string().max(30).nullish(),
  counterpartyId: z.string().max(30).nullish(),
  personId: z.string().max(30).nullish(),
  url: z.string().max(2000).optional(),
  customAttributes: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(100)).optional(),
});

export const listConversationsQuerySchema = z.object({
  state: z.enum(DESK_CONVERSATION_STATES).optional(),
  adminAssigneeId: z.string().max(255).optional(),
  /** 'unassigned' is a sentinel meaning teamAssigneeId IS NULL. */
  teamAssigneeId: z.string().max(30).optional(),
  channel: z.enum(DESK_CHANNELS).optional(),
  priority: z.coerce.boolean().optional(),
  tag: z.string().max(100).optional(),
  isTicket: z.coerce.boolean().optional(),
  contactId: z.string().max(30).optional(),
  /** "Created by you" inbox — conversations whose admin-authored source matches this user. */
  createdById: z.string().max(255).optional(),
  /** Conversations containing a note part that @mentions this user (see reply's `mentionUserIds`). */
  mentionedUserId: z.string().max(255).optional(),
  sort: z.enum(DESK_CONVERSATION_SORTS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const getConversationQuerySchema = z.object({
  include: z.enum(['parts']).optional(),
});

// ---------------------------------------------------------------------------
// Reply (comment | note)
// ---------------------------------------------------------------------------

export const replyToConversationSchema = z.object({
  messageType: z.enum(['comment', 'note']),
  body: z.string().min(1),
  blocks: z.array(z.record(z.unknown())).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
        contentType: z.string(),
        filesize: z.number(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    )
    .optional(),
  /** Only meaningful for messageType='note' — stored in the part's metadata.mentionUserIds. */
  mentionUserIds: z.array(z.string().max(255)).optional(),
});

// ---------------------------------------------------------------------------
// Manage (close | open | snooze | assign)
// ---------------------------------------------------------------------------

export const manageConversationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('open') }),
  z.object({ action: z.literal('snooze'), snoozedUntil: z.string().datetime() }),
  z.object({
    action: z.literal('assign'),
    assigneeType: z.enum(['admin', 'team']),
    /** Empty string / null unassigns (admin only). */
    assigneeId: z.string().max(255).nullish(),
  }),
]);

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const addConversationTagSchema = z.object({
  tag: z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// Attributes (custom attributes + title/priority/read)
// ---------------------------------------------------------------------------

export const updateConversationAttributesSchema = z.object({
  title: z.string().max(500).nullish(),
  priority: z.boolean().optional(),
  read: z.boolean().optional(),
  customAttributes: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

export const rateConversationSchema = z.object({
  rating: z.number().int().min(1).max(5),
  remark: z.string().max(2000).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ReplyToConversationInput = z.infer<typeof replyToConversationSchema>;
export type ManageConversationInput = z.infer<typeof manageConversationSchema>;
export type AddConversationTagInput = z.infer<typeof addConversationTagSchema>;
export type UpdateConversationAttributesInput = z.infer<typeof updateConversationAttributesSchema>;
export type RateConversationInput = z.infer<typeof rateConversationSchema>;
