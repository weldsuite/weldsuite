import { z } from 'zod';

// `/api/ai-agents` — backed by `agents`. AI agent definitions (separate
// from helpdesk_agents — see naming convention table).

export const createAiAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  model: z.string().max(100).optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateAiAgentSchema = createAiAgentSchema.partial();
export type CreateAiAgentInput = z.infer<typeof createAiAgentSchema>;
export type UpdateAiAgentInput = z.infer<typeof updateAiAgentSchema>;
