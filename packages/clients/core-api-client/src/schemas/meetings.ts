import { z } from 'zod';

export const createMeetingSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  scheduledAt: z.string().optional(),
  durationMinutes: z.number().int().optional(),
  hostId: z.string().nullish(),
  participants: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateMeetingSchema = createMeetingSchema.partial();
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
