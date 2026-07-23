import { z } from 'zod';

// ============================================================================
// Accounts
// ============================================================================

export const listAccountsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
  status: z.string().optional(),
  provider: z.string().optional(),
});

export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;

export interface MailAccount {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  provider: string;
  status: string;
  isDefault: boolean | null;
}

// ============================================================================
// Labels
// ============================================================================

export const listLabelsQuery = z.object({
  accountId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export type ListLabelsQuery = z.infer<typeof listLabelsQuery>;

export const createLabelSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(100),
  color: z.string().optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export const updateLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().optional(),
  aiEnabled: z.boolean().optional(),
  aiKeywords: z.array(z.string()).optional(),
  aiDescription: z.string().nullable().optional(),
  aiConfidence: z.number().int().min(0).max(100).optional(),
});

export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export interface MailLabel {
  id: string;
  accountId: string;
  name: string;
  color: string | null;
  isSystem: boolean | null;
  slug: string | null;
  messageCount: number;
  position: number | null;
  aiEnabled: boolean | null;
  aiKeywords: string[] | null;
  aiDescription: string | null;
  aiConfidence: number | null;
  createdAt: string;
  updatedAt: string;
}
