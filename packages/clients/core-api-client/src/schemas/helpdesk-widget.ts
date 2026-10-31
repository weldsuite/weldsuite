import { z } from 'zod';

/**
 * Responses of helpdesk-widget-api, WeldDesk's public webchat API.
 *
 * The embeddable widget types them with plain interfaces
 * (`apps/web/helpdesk-widget/src/lib/api/types.ts`), and the worker builds the
 * conversation and message from `PublicDeskConversation` / `PublicDeskMessage`
 * in `@weldsuite/db/lib/desk`; keep the three in step.
 *
 * Unlike the rest of the first-party API these routes answer in the worker's
 * own envelope, `{ success: true, data }` (`src/lib/response.ts`), and their
 * errors are `{ success: false, error: { code, message } }`.
 */

/** `{ success: true, data }`: what every route of the worker answers with on success. */
export const widgetResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ success: z.literal(true), data });

/** A teammate as a visitor sees them: first name and picture. */
export const widgetTeamMemberSchema = z.object({
  name: z.string(),
  avatar: z.string().nullable(),
});

export const WIDGET_EXPECTED_REPLY_TIMES = ['few_minutes', 'hour', 'few_hours', 'day'] as const;

/** GET /api/config. */
export const widgetConfigSchema = z.object({
  widgetId: z.string(),
  name: z.string().nullable(),
  enabled: z.boolean(),
  greeting: z.string(),
  branding: z.object({
    primaryColor: z.string(),
    backgroundColor: z.string(),
    position: z.enum(['right', 'left']),
  }),
  showBranding: z.boolean(),
  /** wss:// origin of the realtime worker; null when none is configured. */
  realtimeUrl: z.string().nullable(),
  team: z.array(widgetTeamMemberSchema),
  /** Office hours, computed by the API in the widget's timezone. */
  availability: z.object({
    isOpen: z.boolean(),
    /** When the team is next in (ISO), while they are away. */
    nextOpenAt: z.string().datetime().nullable(),
  }),
  awayMessage: z.string().nullable(),
  expectedReplyTime: z.enum(WIDGET_EXPECTED_REPLY_TIMES).nullable(),
});

export const widgetMessageAttachmentSchema = z.object({
  name: z.string(),
  url: z.string(),
  contentType: z.string(),
  filesize: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});

/** A message or timeline event; notes and ticket-field changes are never sent. */
export const widgetMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(['message', 'event']),
  body: z.string().nullable(),
  authorType: z.enum(['visitor', 'agent', 'bot', 'system']),
  authorName: z.string().nullable(),
  authorAvatar: z.string().nullable(),
  attachments: z.array(widgetMessageAttachmentSchema).nullable(),
  eventType: z.string().nullable(),
  clientId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const widgetConversationSchema = z.object({
  id: z.string(),
  conversationNumber: z.number().int(),
  title: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  createdAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
  lastMessagePreview: z.string().nullable(),
  /** True when the last public message came from the team (the ball is in the visitor's court). */
  lastMessageFromTeam: z.boolean(),
  assignee: widgetTeamMemberSchema.nullable(),
  /** The visitor's 1 to 5 rating, once given. */
  rating: z.number().int().nullable(),
});

/** GET /api/conversations: the visitor's conversations, most recent activity first. */
export const widgetConversationListSchema = z.array(widgetConversationSchema);

/** POST /api/conversations/identify. */
export const widgetIdentifiedSchema = z.object({
  visitor: z.object({
    id: z.string(),
    name: z.string().nullable(),
    /** The proven email of a verified visitor, else the one they typed. */
    email: z.string().nullable(),
    /** True when the email was proven (identity token or help center sign-in). */
    verified: z.boolean(),
  }),
});

/** POST /api/conversations: the new conversation, its first message (twice, once as a list). */
export const widgetConversationStartedSchema = z.object({
  conversation: widgetConversationSchema,
  messages: z.array(widgetMessageSchema),
  message: widgetMessageSchema,
});

/** GET /api/conversations/:id. */
export const widgetConversationThreadSchema = z.object({
  conversation: widgetConversationSchema,
  messages: z.array(widgetMessageSchema),
});

/** POST /api/conversations/:id/messages and /rating. */
export const widgetConversationMessageSchema = z.object({
  conversation: widgetConversationSchema,
  message: widgetMessageSchema,
});

/** POST /api/realtime/token. */
export const widgetRealtimeTokenSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int(),
});

/** POST /api/attachments/upload. */
export const widgetUploadedAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  url: z.string(),
  fileKey: z.string(),
});

export type WidgetConfig = z.infer<typeof widgetConfigSchema>;
export type WidgetMessage = z.infer<typeof widgetMessageSchema>;
export type WidgetConversation = z.infer<typeof widgetConversationSchema>;
