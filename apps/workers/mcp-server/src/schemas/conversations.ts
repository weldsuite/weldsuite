// AUTO-COPIED from @weldsuite/core-api-client/schemas/desk-conversations
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// `/v1/conversations` — the WeldDesk inbox (`desk_conversations`), where
// agents work. Tool inputs take plain shapes, so the "change something" rule
// of an update is checked by the route, not here.

export const DESK_CHANNELS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api'] as const;
export const DESK_CONVERSATION_STATES = ['open', 'closed'] as const;
export const DESK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const DESK_MAX_TAGS = 20;
export const DESK_MAX_TAG_LENGTH = 50;

/**
 * A boolean query flag. `z.coerce.boolean()` is `Boolean(value)`, so
 * `?unassigned=false` would read as true; this takes `true` / `false`
 * as strings, and real booleans from tool calls.
 */
const queryBoolean = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

export const listConversationsQuerySchema = z.object({
  state: z.enum(DESK_CONVERSATION_STATES).optional().describe('open or closed'),
  assigneeId: z.string().max(255).optional().describe("A teammate's user id: only their conversations"),
  unassigned: queryBoolean.optional().describe('Only conversations nobody owns yet'),
  channel: z.enum(DESK_CHANNELS).optional().describe('Where the conversation came in'),
  email: z.string().trim().max(255).optional().describe("A customer's email: all their conversations"),
  externalId: z.string().trim().max(255).optional().describe('The key a conversation was opened with'),
  priority: z.enum([...DESK_PRIORITIES, 'none']).optional().describe('A priority, or none for unprioritised'),
  ticketTypeId: z.string().max(30).optional(),
  departmentId: z.string().max(30).optional().describe('The team'),
  tag: z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH).optional(),
  q: z.string().trim().max(200).optional().describe('Search customer, subject, number (#42) and message text'),
  sort: z.enum(['newest', 'oldest', 'waiting_longest']).optional(),
  cursor: z.string().optional().describe('Pagination cursor from a previous response'),
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Page size (1-100, default 30)'),
});

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
  ticketTypeId: z.string().max(30).optional().describe('The ticket type'),
  priority: z.enum(DESK_PRIORITIES).optional().describe('low, medium, high or urgent'),
  tags: z.array(z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH)).max(DESK_MAX_TAGS).optional(),
  departmentId: z.string().max(30).optional().describe('The team'),
});

export const updateDeskConversationShape = {
  state: z.enum(DESK_CONVERSATION_STATES).optional().describe('open or closed'),
  assigneeId: z
    .string()
    .max(255)
    .nullable()
    .optional()
    .describe("The teammate's user id, or null to unassign"),
  ticketTypeId: z.string().max(30).nullable().optional().describe('The ticket type, or null to clear'),
  priority: z.enum(DESK_PRIORITIES).nullable().optional().describe('low, medium, high or urgent; null clears'),
  tags: z
    .array(z.string().trim().min(1).max(DESK_MAX_TAG_LENGTH))
    .max(DESK_MAX_TAGS)
    .optional()
    .describe('Replaces the whole tag list'),
  departmentId: z.string().max(30).nullable().optional().describe('The team, or null to clear'),
  customFields: z.record(z.string().max(100), z.unknown()).optional().describe("The type's custom fields, by slug"),
};

export const addDeskConversationMessageSchema = z.object({
  kind: z
    .enum(['message', 'note'])
    .default('note')
    .describe(
      'note stays inside the team; message is a reply the customer sees (api and chat conversations only: email and phone replies are sent from the inbox)',
    ),
  body: z.string().trim().min(1).max(20_000),
});
