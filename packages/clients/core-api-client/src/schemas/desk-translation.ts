import { z } from 'zod';

// ── WeldDesk AI translation (/api/desk/conversations/:id/translate*) ─────────
//
// Both editions; without an AI provider the routes answer 503
// `ai_unavailable` and the platform hides the feature (`desk-ai`).

/** A BCP 47 language tag as the routes take it: `de`, `nl`, `pt-BR`. */
export const deskLocaleSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Must be a language code such as de or pt-BR');

/** `POST /api/desk/conversations/:id/translate`. */
export const translateDeskConversationSchema = z.object({
  /** Messages of this conversation to translate; default the customer's public messages. */
  messageIds: z.array(z.string().max(30)).max(50).optional(),
  /** The language to translate into: the agent's. */
  targetLocale: deskLocaleSchema,
});

/** `POST /api/desk/conversations/:id/translate-reply`. */
export const translateDeskReplySchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** Default: the conversation's detected language. */
  targetLocale: deskLocaleSchema.optional(),
});

/**
 * What the agent wrote before "Translate to …", sent with the reply and kept
 * in the message's internal `metadata.translation` (never shown to the
 * customer), so the timeline keeps the agent's own words.
 */
export const deskReplyTranslationSchema = z.object({
  original: z.string().min(1).max(20_000),
  sourceLocale: z.string().min(2).max(10),
  targetLocale: z.string().min(2).max(10),
});

export const deskMessageTranslationSchema = z.object({
  messageId: z.string(),
  text: z.string(),
});

/** The translate route's answer. */
export const deskConversationTranslationSchema = z.object({
  /** The customer's language, as detected and stored on the conversation. */
  language: z.string().nullable(),
  targetLocale: z.string(),
  /** Empty when the customer already writes in `targetLocale`. */
  translations: z.array(deskMessageTranslationSchema),
});

/** The translate-reply route's answer. */
export const deskReplyTranslationResultSchema = z.object({
  text: z.string(),
  sourceLocale: z.string().nullable(),
  targetLocale: z.string(),
});

export type TranslateDeskConversationInput = z.infer<typeof translateDeskConversationSchema>;
export type TranslateDeskReplyInput = z.infer<typeof translateDeskReplySchema>;
export type DeskReplyTranslation = z.infer<typeof deskReplyTranslationSchema>;
export type DeskMessageTranslation = z.infer<typeof deskMessageTranslationSchema>;
export type DeskConversationTranslation = z.infer<typeof deskConversationTranslationSchema>;
export type DeskReplyTranslationResult = z.infer<typeof deskReplyTranslationResultSchema>;
