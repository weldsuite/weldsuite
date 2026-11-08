import { z } from 'zod';
import { DESK_CHANNELS, DESK_CONVERSATION_STATES, deskConversationSchema, deskMessageSchema } from './desk-conversations';

/**
 * Linked tickets on /api/desk/conversations/:id/* (desk-api): parent/child
 * links (one level), major incidents and merging duplicates. Rows are written
 * by `@weldsuite/db/lib/desk-links`.
 */

/** PUT /:id/parent: link to a parent, or `null` to unlink. */
export const setDeskConversationParentSchema = z.object({
  parentId: z.string().min(1).max(30).nullable(),
});

/** POST /:id/merge: merge this duplicate into the kept conversation. */
export const mergeDeskConversationSchema = z.object({
  targetId: z.string().min(1).max(30),
});

/** PUT /:id/major-incident: mark or unmark (unmarking unlinks its children). */
export const setDeskMajorIncidentSchema = z.object({
  isMajorIncident: z.boolean(),
});

/** POST /:id/incident-update: one reply on the incident and on each of its open children. */
export const postDeskIncidentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

// ── responses ────────────────────────────────────────────────────────────────

/** A linked conversation as the details panel lists it. */
export const deskConversationLinkSummarySchema = z.object({
  id: z.string(),
  conversationNumber: z.number().int(),
  title: z.string().nullable(),
  state: z.enum(DESK_CONVERSATION_STATES),
  channel: z.enum(DESK_CHANNELS),
  name: z.string().nullable(),
  email: z.string().nullable(),
  assigneeId: z.string().nullable(),
  isMajorIncident: z.boolean(),
});

/** GET /:id/links. */
export const deskConversationLinksSchema = z.object({
  parent: deskConversationLinkSummarySchema.nullable(),
  children: z.array(deskConversationLinkSummarySchema),
  mergedInto: deskConversationLinkSummarySchema.nullable(),
  mergedFrom: z.array(deskConversationLinkSummarySchema),
});

/** PUT /:id/parent, PUT /:id/major-incident: the conversation and its new timeline entries. */
export const deskConversationLinkChangeSchema = z.object({
  conversation: deskConversationSchema,
  messages: z.array(deskMessageSchema),
});

/** POST /:id/merge: the closed duplicate, its new timeline entries and the kept conversation. */
export const deskConversationMergeSchema = deskConversationLinkChangeSchema.extend({
  target: deskConversationSchema,
});

/** POST /:id/incident-update: the incident's reply, and on how many open children it was posted. */
export const deskIncidentUpdateSchema = z.object({
  conversation: deskConversationSchema,
  message: deskMessageSchema,
  delivered: z.number().int().nonnegative(),
});

export type DeskConversationLinkSummary = z.infer<typeof deskConversationLinkSummarySchema>;
export type DeskConversationLinksResponse = z.infer<typeof deskConversationLinksSchema>;
