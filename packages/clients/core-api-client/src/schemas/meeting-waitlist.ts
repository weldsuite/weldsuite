import { z } from 'zod';

export const createMeetingWaitlistEntrySchema = z.object({
  sessionId: z.string(),
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateMeetingWaitlistEntrySchema = createMeetingWaitlistEntrySchema.partial();
export type CreateMeetingWaitlistEntryInput = z.infer<typeof createMeetingWaitlistEntrySchema>;
export type UpdateMeetingWaitlistEntryInput = z.infer<typeof updateMeetingWaitlistEntrySchema>;
