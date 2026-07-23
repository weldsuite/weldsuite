import { z } from 'zod';

export const createCalendarSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  color: z.string().max(50).optional(),
  ownerId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCalendarSchema = createCalendarSchema.partial();
export type CreateCalendarInput = z.infer<typeof createCalendarSchema>;
export type UpdateCalendarInput = z.infer<typeof updateCalendarSchema>;
