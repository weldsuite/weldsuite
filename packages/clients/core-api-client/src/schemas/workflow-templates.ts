import { z } from 'zod';

export const createWorkflowTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  steps: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWorkflowTemplateSchema = createWorkflowTemplateSchema.partial();
export type CreateWorkflowTemplateInput = z.infer<typeof createWorkflowTemplateSchema>;
export type UpdateWorkflowTemplateInput = z.infer<typeof updateWorkflowTemplateSchema>;
