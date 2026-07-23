/**
 * `/api/mail-labels` — backed by `mail_labels`.
 *
 * Includes paginated threads-by-label (`GET /threads`), bulk apply/
 * unapply against `mail_messages.labels` (JSONB), and per-thread apply.
 */

import { z } from 'zod';

export const createMailLabelSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(100),
  color: z.string().max(20).optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

export const updateMailLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(20).optional(),
  position: z.number().int().optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

export const listMailLabelsQuery = z.object({
  accountId: z.string().optional(),
});

export const applyLabelToMessagesSchema = z.object({
  labelName: z.string().min(1),
  messageIds: z.array(z.string()).min(1).max(500),
});

export const applyLabelToThreadSchema = z.object({
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  labelName: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

export const listMailLabelThreadsQuery = z.object({
  accountId: z.string().optional(),
  labelSlug: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateMailLabelInput = z.infer<typeof createMailLabelSchema>;
export type UpdateMailLabelInput = z.infer<typeof updateMailLabelSchema>;
export type ListMailLabelsQuery = z.infer<typeof listMailLabelsQuery>;
export type ApplyLabelToMessagesInput = z.infer<typeof applyLabelToMessagesSchema>;
export type ApplyLabelToThreadInput = z.infer<typeof applyLabelToThreadSchema>;
export type ListMailLabelThreadsQuery = z.infer<typeof listMailLabelThreadsQuery>;
