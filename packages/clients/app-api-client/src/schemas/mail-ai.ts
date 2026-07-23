/**
 * `/api/mail-ai` — proxies enriched payloads to agent-worker for
 * Anthropic generation. agent-worker may respond with JSON or
 * `text/event-stream` depending on the op.
 */

import { z } from 'zod';

export const mailAiToneEnum = z.enum(['professional', 'friendly', 'casual']);
export const mailAiReplyToneEnum = z.enum(['professional', 'friendly', 'brief']);
export const mailAiLengthEnum = z.enum(['short', 'medium', 'long']);
export const mailAiImproveActionEnum = z.enum([
  'improve', 'shorten', 'expand', 'formalize', 'make_friendly',
]);

export const draftMailAiSchema = z.object({
  prompt: z.string().min(1),
  replyToMessageId: z.string().nullish(),
  accountId: z.string().nullish(),
  tone: mailAiToneEnum.optional(),
  length: mailAiLengthEnum.optional(),
  modelId: z.string().nullish(),
});

export const improveTextMailAiSchema = z.object({
  text: z.string().min(1),
  action: mailAiImproveActionEnum,
  accountId: z.string().nullish(),
  modelId: z.string().nullish(),
});

export const autoDraftMailAiSchema = z.object({
  accountId: z.string().min(1),
  /** When set, draft a reply to this specific message. */
  messageId: z.string().nullish(),
  prompt: z.string().optional(),
  recentMessageIds: z.array(z.string()).max(20).optional(),
  modelId: z.string().nullish(),
});

export const replyMailAiSchema = z.object({
  /**
   * Either an existing message (server pulls the body from DB) or pure
   * user intent (e.g. "agree to the meeting", "decline politely") — the
   * agent-worker side handles both.
   */
  messageId: z.string().nullish(),
  /** User intent for what the reply should say. */
  userPrompt: z.string().optional(),
  /** Sender account — used to pick up aiSettings (default tone, model). */
  accountId: z.string().nullish(),
  tone: mailAiReplyToneEnum.optional(),
  modelId: z.string().nullish(),
});

export const classifyMailAiSchema = z.object({
  messageId: z.string().min(1),
  modelId: z.string().nullish(),
});

export const classifyBatchMailAiSchema = z.object({
  messageIds: z.array(z.string()).min(1).max(50),
  modelId: z.string().nullish(),
});

export const inboxSummaryMailAiSchema = z.object({
  accountId: z.string().nullish(),
  modelId: z.string().nullish(),
}).passthrough();

export const smartRepliesMailAiSchema = z.object({
  messageId: z.string().min(1),
  modelId: z.string().nullish(),
});

export type DraftMailAiInput = z.infer<typeof draftMailAiSchema>;
export type ImproveTextMailAiInput = z.infer<typeof improveTextMailAiSchema>;
export type AutoDraftMailAiInput = z.infer<typeof autoDraftMailAiSchema>;
export type ReplyMailAiInput = z.infer<typeof replyMailAiSchema>;
export type ClassifyMailAiInput = z.infer<typeof classifyMailAiSchema>;
export type ClassifyBatchMailAiInput = z.infer<typeof classifyBatchMailAiSchema>;
export type InboxSummaryMailAiInput = z.infer<typeof inboxSummaryMailAiSchema>;
export type SmartRepliesMailAiInput = z.infer<typeof smartRepliesMailAiSchema>;
