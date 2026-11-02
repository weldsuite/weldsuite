/**
 * WeldDesk end-user contracts: the signed-in help center ("portal") and the
 * widget's visitor session. Served by helpdesk-widget-api: `/api/portal/*`
 * (tenant from `?domain=`, session in `x-portal-session`) and
 * `/api/visitor` (tenant from `x-widget-id`).
 */

import { z } from 'zod';

// ── sign-in ────────────────────────────────────────────────────────────────

export const deskPortalAuthRequestSchema = z.object({
  email: z.string().trim().email().max(255),
});

export const deskPortalAuthVerifySchema = z.object({
  email: z.string().trim().email().max(255),
  code: z.string().trim().regex(/^\d{6}$/, 'The code is six digits'),
});

export const deskPortalUserSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
});
export type DeskPortalUser = z.infer<typeof deskPortalUserSchema>;

export const deskPortalSessionSchema = z.object({
  /** Opaque bearer token; the help center keeps it in an httpOnly cookie. */
  session: z.string(),
  expiresAt: z.string(),
  user: deskPortalUserSchema,
});
export type DeskPortalSession = z.infer<typeof deskPortalSessionSchema>;

export const deskPortalConfigSchema = z.object({
  /** Sign-in and requests are switched on for this help center. */
  enabled: z.boolean(),
});
export type DeskPortalConfig = z.infer<typeof deskPortalConfigSchema>;

// ── request form (built from the customer ticket types) ────────────────────

export const DESK_PORTAL_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'select',
  'multiselect',
  'date',
  'checkbox',
  'email',
  'url',
] as const;
export type DeskPortalFieldType = (typeof DESK_PORTAL_FIELD_TYPES)[number];

export const deskPortalFieldConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(['equals', 'not_equals', 'is_set', 'is_not_set']),
  value: z.string().optional(),
});
export type DeskPortalFieldCondition = z.infer<typeof deskPortalFieldConditionSchema>;

export const deskPortalFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(DESK_PORTAL_FIELD_TYPES),
  required: z.boolean(),
  placeholder: z.string().nullable(),
  helpText: z.string().nullable(),
  options: z.array(z.object({ label: z.string(), value: z.string() })),
  /** Shown only when every condition holds; required only while shown. */
  conditions: z.array(deskPortalFieldConditionSchema),
});
export type DeskPortalField = z.infer<typeof deskPortalFieldSchema>;

export const deskPortalRequestTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  /** Label of the title field (the type's own wording, e.g. "Subject"). */
  titleLabel: z.string(),
  /** Label of the description field, null when the type hides it from customers. */
  descriptionLabel: z.string().nullable(),
  descriptionRequired: z.boolean(),
  /** The type's other customer-visible fields, in order. */
  fields: z.array(deskPortalFieldSchema),
});
export type DeskPortalRequestType = z.infer<typeof deskPortalRequestTypeSchema>;

export const DESK_PORTAL_TITLE_MAX = 200;
export const DESK_PORTAL_BODY_MAX = 10_000;

export const deskPortalCreateRequestSchema = z.object({
  ticketTypeId: z.string().min(1).max(30),
  title: z.string().trim().min(1).max(DESK_PORTAL_TITLE_MAX),
  description: z.string().trim().max(DESK_PORTAL_BODY_MAX).optional(),
  /** Field key → value, for the type's customer-visible fields. */
  fields: z.record(z.unknown()).optional(),
});
export type DeskPortalCreateRequest = z.infer<typeof deskPortalCreateRequestSchema>;

// ── my requests ────────────────────────────────────────────────────────────

/** The ticket-type state groups; the conversation's open/closed and last speaker pick one. */
export const DESK_PORTAL_STATUSES = ['submitted', 'in_progress', 'waiting_on_customer', 'resolved'] as const;
export type DeskPortalStatus = (typeof DESK_PORTAL_STATUSES)[number];

export const deskPortalRequestSummarySchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string().nullable(),
  status: z.enum(DESK_PORTAL_STATUSES),
  /** The ticket type's customer wording for the status; null = the help center's default. */
  statusLabel: z.string().nullable(),
  typeName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessagePreview: z.string().nullable(),
});
export type DeskPortalRequestSummary = z.infer<typeof deskPortalRequestSummarySchema>;

export const deskPortalMessageSchema = z.object({
  id: z.string(),
  kind: z.enum(['message', 'event']),
  body: z.string().nullable(),
  /** `visitor` is the signed-in customer (or another of their sessions). */
  authorType: z.enum(['visitor', 'agent', 'bot', 'system']),
  authorName: z.string().nullable(),
  authorAvatar: z.string().nullable(),
  attachments: z
    .array(z.object({ name: z.string(), url: z.string(), contentType: z.string(), filesize: z.number() }))
    .nullable(),
  eventType: z.string().nullable(),
  createdAt: z.string(),
});
export type DeskPortalMessage = z.infer<typeof deskPortalMessageSchema>;

export const deskPortalRequestDetailSchema = deskPortalRequestSummarySchema.extend({
  /** Customer-visible field values: label and display value, in form order. */
  fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
  messages: z.array(deskPortalMessageSchema),
});
export type DeskPortalRequestDetail = z.infer<typeof deskPortalRequestDetailSchema>;

export const deskPortalReplySchema = z.object({
  body: z.string().trim().min(1).max(DESK_PORTAL_BODY_MAX),
});

export const deskPortalListRequestsQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// ── widget visitor session ─────────────────────────────────────────────────

export const deskVisitorSessionRequestSchema = z.object({
  /**
   * HS256 JWT the customer's server signed with the widget's identity secret:
   * `sub` (their user id, required), `email`, `name`, `exp` (required).
   */
  identityToken: z.string().min(1).max(4096).optional(),
  /** The token this browser already holds, to keep the same visitor. */
  visitorToken: z.string().min(1).max(2048).optional(),
  /**
   * Transition only: the id the widget used to generate in the browser. An
   * existing anonymous visitor can swap it once for a visitor token.
   */
  legacyVisitorId: z.string().min(1).max(64).optional(),
});

export const deskVisitorSessionSchema = z.object({
  visitorToken: z.string(),
  visitor: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    /** True when the email was proven (identity token or help center sign-in). */
    verified: z.boolean(),
  }),
});
export type DeskVisitorSession = z.infer<typeof deskVisitorSessionSchema>;
