import { z } from 'zod';

// `/api/integrations` — backed by `integration_connections`.

export const createIntegrationSchema = z.object({
  provider: z.string().min(1).max(50),
  name: z.string().max(255).optional(),
  status: z.string().max(30).optional(),
  config: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateIntegrationSchema = createIntegrationSchema.partial();
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;
