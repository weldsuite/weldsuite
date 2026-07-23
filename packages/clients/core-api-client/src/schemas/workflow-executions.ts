import { z } from 'zod';

export const createWorkflowExecutionSchema = z.object({
  workflowId: z.string(),
  status: z.string().max(30).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWorkflowExecutionSchema = createWorkflowExecutionSchema.partial();
export type CreateWorkflowExecutionInput = z.infer<typeof createWorkflowExecutionSchema>;
export type UpdateWorkflowExecutionInput = z.infer<typeof updateWorkflowExecutionSchema>;
