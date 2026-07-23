import { z } from 'zod';

// `/api/gl-accounts` — GL accounts / chart of accounts.

export const createGlAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(255),
  type: z.string().max(50).optional(),
  category: z.string().max(50).optional(),
  entityId: z.string().nullish(),
  parentId: z.string().nullish(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateGlAccountSchema = createGlAccountSchema.partial();

export type CreateGlAccountInput = z.infer<typeof createGlAccountSchema>;
export type UpdateGlAccountInput = z.infer<typeof updateGlAccountSchema>;
