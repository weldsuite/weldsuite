/**
 * WeldAgent shared schemas — the personal AI assistant's conversations,
 * messages, user settings, and @-mention search.
 *
 * Shared between the app-api route handlers (`apps/workers/app-api/src/routes/weldagent`)
 * and the platform/mobile domain client (`../domains/weldagent`). Zod v3.
 *
 * Wire shapes intentionally mirror the legacy api-worker envelopes
 * (`{ data }` / `{ data: [] }`, no cursor pagination) so the frontend
 * cutover is a base-URL change, not a response-shape change.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request schemas (zValidator on the server, input types on the client)
// ---------------------------------------------------------------------------

export const createConversationSchema = z.object({
  name: z.string().optional(),
  moduleKey: z.string().optional(),
});

export const updateConversationSchema = z.object({
  name: z.string().optional(),
  isPinned: z.boolean().optional(),
});

export const saveMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  toolInvocations: z.array(z.any()).optional(),
  formState: z.any().optional(),
});

export const weldAgentSettingsSchema = z.object({
  preferredModel: z.string().optional(),
  fallbackModel: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(32768).optional(),
  showToolCalls: z.boolean().optional(),
  autoSendSuggestions: z.boolean().optional(),
  saveConversationHistory: z.boolean().optional(),
  appPermissions: z.record(z.boolean()).optional(),
  customInstructions: z.string().max(2000).optional(),
});

export const autoTitleSchema = z.object({
  firstUserMessage: z.string().min(1),
  firstAssistantMessage: z.string().optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type SaveMessageInput = z.infer<typeof saveMessageSchema>;
export type WeldAgentSettingsInput = z.infer<typeof weldAgentSettingsSchema>;
export type AutoTitleInput = z.infer<typeof autoTitleSchema>;

// ---------------------------------------------------------------------------
// Response row shapes
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: string;
  name: string;
  moduleKey: string | null;
  isPinned: boolean;
  lastMessageAt: string | null;
  messageCount: number;
  createdAt: string;
}

export interface WeldAgentMessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolInvocations?: unknown[] | null;
  formState?: {
    formId?: string;
    formType?: string;
    values?: Record<string, unknown>;
    submitted?: boolean;
  } | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeldAgentSettings {
  id: string;
  userId: string;
  preferredModel: string;
  fallbackModel: string | null;
  temperature: number;
  maxTokens: number;
  showToolCalls: boolean;
  autoSendSuggestions: boolean;
  saveConversationHistory: boolean;
  customInstructions: string;
  appPermissions: Record<string, boolean>;
}

export interface MentionSearchResult {
  id: string;
  type: string;
  label: string;
  description?: string;
  icon: string;
}

export interface AutoTitleResult {
  id: string;
  name: string;
  generated: boolean;
}
