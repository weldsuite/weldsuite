import { z } from 'zod';

export const createMeetingSessionSchema = z.object({
  meetingId: z.string().nullish(),
  status: z.string().max(30).optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateMeetingSessionSchema = createMeetingSessionSchema.partial();
export type CreateMeetingSessionInput = z.infer<typeof createMeetingSessionSchema>;
export type UpdateMeetingSessionInput = z.infer<typeof updateMeetingSessionSchema>;
