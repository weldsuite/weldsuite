import { z } from 'zod';

export const createAgentPackageSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  tools: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateAgentPackageSchema = createAgentPackageSchema.partial();
export type CreateAgentPackageInput = z.infer<typeof createAgentPackageSchema>;
export type UpdateAgentPackageInput = z.infer<typeof updateAgentPackageSchema>;
