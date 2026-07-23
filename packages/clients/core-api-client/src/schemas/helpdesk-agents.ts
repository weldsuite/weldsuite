import { z } from 'zod';

// `/api/helpdesk-agents` — backed by `helpdesk_agents`.

export const createHelpdeskAgentSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  userId: z.string().nullish(),
  departmentId: z.string().nullish(),
  role: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskAgentSchema = createHelpdeskAgentSchema.partial();

export type CreateHelpdeskAgentInput = z.infer<typeof createHelpdeskAgentSchema>;
export type UpdateHelpdeskAgentInput = z.infer<typeof updateHelpdeskAgentSchema>;
