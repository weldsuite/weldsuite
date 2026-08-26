import { z } from 'zod';

export const DESK_CHANNELS = ['messenger', 'email', 'phone', 'whatsapp', 'sms', 'api'] as const;
export const DESK_CONVERSATION_STATES = ['open', 'closed'] as const;
export const DESK_CONVERSATION_SORTS = ['newest', 'oldest', 'waiting_longest'] as const;
export const DESK_MESSAGE_KINDS = ['message', 'note', 'event'] as const;

export const listConversationsQuerySchema = z.object({
  state: z.enum(DESK_CONVERSATION_STATES).optional(),
  assigneeId: z.string().max(255).optional(),
  unassigned: z.coerce.boolean().optional(),
  channel: z.enum(DESK_CHANNELS).optional(),
  sort: z.enum(DESK_CONVERSATION_SORTS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const getConversationQuerySchema = z.object({
  include: z.enum(['messages']).optional(),
});

export const replyToConversationSchema = z.object({
  kind: z.enum(['message', 'note']).default('message'),
  body: z.string().min(1),
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
});

export const manageConversationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('open') }),
  z.object({
    action: z.literal('assign'),
    assigneeId: z.string().max(255).nullish(),
  }),
]);

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ReplyToConversationInput = z.infer<typeof replyToConversationSchema>;
export type ManageConversationInput = z.infer<typeof manageConversationSchema>;
