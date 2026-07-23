/**
 * `/api/ai/*` — shared Zod schemas for the WeldAgent chat + one-shot generate
 * endpoints. Both route through `@weldsuite/ai` (Cloudflare AI Gateway) and are
 * metered against the prepaid credit wallet.
 */

import { z } from 'zod';

export const aiChatRoleEnum = z.enum(['user', 'assistant', 'system']);

export const aiChatMessageSchema = z.object({
  role: aiChatRoleEnum,
  content: z.string().min(1).max(20000),
});

export const aiChatSchema = z.object({
  /** Full running conversation — the server is stateless, so send history each turn. */
  messages: z.array(aiChatMessageSchema).min(1).max(50),
  /** Optional canonical model id. Defaults to the free Workers AI copilot model. */
  model: z.string().min(1).max(200).optional(),
  /** Optional extra system context (e.g. the entity the user is viewing). */
  system: z.string().max(8000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
});

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AiChatResult {
  text: string;
  model: string;
  finishReason: string;
  usage?: AiUsage;
  creditsUsed: number;
}

export type AiChatRole = z.infer<typeof aiChatRoleEnum>;
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;
export type AiChatInput = z.infer<typeof aiChatSchema>;
