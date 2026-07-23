import { z } from 'zod';

export const createTimeEntrySchema = z.object({
  taskId: z.string().nullish(),
  projectId: z.string().nullish(),
  userId: z.string().nullish(),
  description: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMinutes: z.number().int().optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.union([z.string(), z.number()]).optional(),
  currency: z.string().max(10).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateTimeEntrySchema = createTimeEntrySchema.partial();
export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntrySchema>;
