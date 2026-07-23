import { z } from 'zod';

export const createGoalSchema = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  projectId: z.string().nullish(),
  status: z.string().max(30).optional(),
  progress: z.number().int().optional(),
  dueDate: z.string().optional(),
  ownerId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateGoalSchema = createGoalSchema.partial();
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
