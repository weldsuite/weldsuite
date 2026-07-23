import { z } from 'zod';

export const createMeetingMessageSchema = z.object({
  sessionId: z.string().nullish(),
  meetingId: z.string().nullish(),
  authorId: z.string().nullish(),
  body: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateMeetingMessageSchema = createMeetingMessageSchema.partial();
export type CreateMeetingMessageInput = z.infer<typeof createMeetingMessageSchema>;
export type UpdateMeetingMessageInput = z.infer<typeof updateMeetingMessageSchema>;
