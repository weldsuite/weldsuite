import { z } from 'zod';

export const createWorkflowVariableSchema = z.object({
  name: z.string().min(1).max(255),
  value: z.unknown().optional(),
  type: z.string().max(30).optional(),
  isSecret: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWorkflowVariableSchema = createWorkflowVariableSchema.partial();
export type CreateWorkflowVariableInput = z.infer<typeof createWorkflowVariableSchema>;
export type UpdateWorkflowVariableInput = z.infer<typeof updateWorkflowVariableSchema>;
