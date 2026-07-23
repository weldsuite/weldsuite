import { z } from 'zod';

export const createWorkflowScheduleSchema = z.object({
  workflowId: z.string(),
  cron: z.string().optional(),
  timezone: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
  nextRunAt: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWorkflowScheduleSchema = createWorkflowScheduleSchema.partial();
export type CreateWorkflowScheduleInput = z.infer<typeof createWorkflowScheduleSchema>;
export type UpdateWorkflowScheduleInput = z.infer<typeof updateWorkflowScheduleSchema>;
