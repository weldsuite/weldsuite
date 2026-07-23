import { z } from 'zod';

export const createAgentRunSchema = z.object({
  agentId: z.string().nullish(),
  status: z.string().max(30).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateAgentRunSchema = createAgentRunSchema.partial();
export type CreateAgentRunInput = z.infer<typeof createAgentRunSchema>;
export type UpdateAgentRunInput = z.infer<typeof updateAgentRunSchema>;
