/**
 * Email forward schemas (Zod v3) — powers /api/email-forwards/*.
 *
 * Supersedes the thin host-email-forwards.ts that the original CRUD stub
 * shipped with. Forwards are stored rules; Cloudflare Email Routing
 * provisioning lives in the WeldMail module, not here.
 */

import { z } from 'zod';

export const emailForwardStatusEnum = z.enum(['active', 'pending', 'disabled', 'error']);

export const listEmailForwardsQuery = z.object({
  domainId: z.string().optional(),
  enabled: z.coerce.boolean().optional(),
  status: emailForwardStatusEnum.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const createEmailForwardSchema = z.object({
  domainId: z.string().min(1),
  source: z.string().min(1).max(255),
  destination: z.string().email().max(500),
  additionalDestinations: z.array(z.string().email()).optional(),
  enabled: z.boolean().optional().default(true),
  catchAll: z.boolean().optional().default(false),
  wildcard: z.boolean().optional().default(false),
  status: emailForwardStatusEnum.optional().default('active'),
});

export const updateEmailForwardSchema = createEmailForwardSchema
  .omit({ domainId: true })
  .partial();

export type ListEmailForwardsQuery = z.input<typeof listEmailForwardsQuery>;
export type CreateEmailForwardInput = z.infer<typeof createEmailForwardSchema>;
export type UpdateEmailForwardInput = z.infer<typeof updateEmailForwardSchema>;

export interface EmailForward {
  id: string;
  domainId: string;
  source: string;
  destination: string;
  additionalDestinations: string[] | null;
  enabled: boolean;
  catchAll: boolean | null;
  wildcard: boolean | null;
  status: 'active' | 'pending' | 'disabled' | 'error';
  lastForwardedAt: string | null;
  forwardCount: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  errorCount: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
