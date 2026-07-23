import { z } from 'zod';

export const createNotificationPreferenceSchema = z.object({
  userId: z.string(),
  channel: z.string().max(50),
  notificationType: z.string().max(100).optional(),
  isEnabled: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateNotificationPreferenceSchema = createNotificationPreferenceSchema.partial();
export type CreateNotificationPreferenceInput = z.infer<typeof createNotificationPreferenceSchema>;
export type UpdateNotificationPreferenceInput = z.infer<typeof updateNotificationPreferenceSchema>;
