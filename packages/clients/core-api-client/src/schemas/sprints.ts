import { z } from 'zod';

export const createSprintSchema = z.object({
  name: z.string().min(1).max(255),
  projectId: z.string().nullish(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  status: z.string().max(30).optional(),
  goal: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSprintSchema = createSprintSchema.partial();
export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
