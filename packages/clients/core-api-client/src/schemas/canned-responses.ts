import { z } from 'zod';

// `/api/canned-responses` — backed by `helpdesk_canned_responses`.

export const createCannedResponseSchema = z.object({
  name: z.string().min(1).max(255),
  subject: z.string().max(500).optional(),
  body: z.string(),
  shortcut: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  departmentId: z.string().nullish(),
  isShared: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateCannedResponseSchema = createCannedResponseSchema.partial();

export type CreateCannedResponseInput = z.infer<typeof createCannedResponseSchema>;
export type UpdateCannedResponseInput = z.infer<typeof updateCannedResponseSchema>;
