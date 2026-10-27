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

/**
 * The spreadsheet open in WeldSheets next to the chat. The agent works on it
 * with the person's own access; name, tab and selection only tell the agent
 * where they are looking.
 */
export const aiOpenSheetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(255).optional(),
  /** Name of the tab on screen. */
  tab: z.string().max(200).optional(),
  /** The selected cells, in A1 notation (`B2:D9`, `A1`). */
  selection: z.string().max(200).optional(),
});

/** What the person has open while they chat. */
export const aiChatContextSchema = z.object({
  sheet: aiOpenSheetSchema.optional(),
});

export type AiOpenSheet = z.infer<typeof aiOpenSheetSchema>;
export type AiChatContext = z.infer<typeof aiChatContextSchema>;

export const aiChatSchema = z.object({
  /** Full running conversation — the server is stateless, so send history each turn. */
  messages: z.array(aiChatMessageSchema).min(1).max(50),
  /** Optional canonical model id. Defaults to the free Workers AI copilot model. */
  model: z.string().min(1).max(200).optional(),
  /** Optional extra system context (e.g. the entity the user is viewing). */
  system: z.string().max(8000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  /** When set, load a workspace agent and run with its tools + instructions. */
  agentId: z.string().min(1).max(30).optional(),
  /** What the person has open (a spreadsheet), for the agent to work on. */
  context: aiChatContextSchema.optional(),
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
