import { z } from 'zod';

export const createWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.string().max(30).optional(),
  steps: z.unknown().optional(),
  triggers: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  settings: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWorkflowSchema = createWorkflowSchema.partial();
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
