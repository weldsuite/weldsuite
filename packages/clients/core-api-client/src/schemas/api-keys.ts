import { z } from 'zod';

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateApiKeySchema = createApiKeySchema.partial();
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>;
