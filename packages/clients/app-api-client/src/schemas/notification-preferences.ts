/**
 * `/api/notification-preferences` — the caller's notification settings, one
 * row per user (app-api `routes/notification-preferences`). Response shapes.
 */

import { z } from 'zod';

export const moduleChannelPreferencesSchema = z.object({
  enabled: z.boolean(),
  inApp: z.boolean(),
  email: z.boolean(),
  push: z.boolean(),
  desktop: z.boolean(),
});

/** A `notification_preferences` row. */
export const notificationPreferenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  doNotDisturb: z.boolean(),
  soundEnabled: z.boolean(),
  modulePreferences: z.record(moduleChannelPreferencesSchema).nullable(),
  defaultInApp: z.boolean(),
  defaultEmail: z.boolean(),
  defaultPush: z.boolean(),
  defaultDesktop: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `POST /` and `PATCH /:id`: the row's id. */
export const notificationPreferenceRefSchema = z.object({ id: z.string() });

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;
