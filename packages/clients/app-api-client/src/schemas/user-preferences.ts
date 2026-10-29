/**
 * `/api/user-preferences` — the caller's preferences (app-api
 * `routes/user-preferences`). Response shapes.
 */

import { z } from 'zod';

/** `GET /` and `PUT /`: the preferences with their defaults filled in. */
export const userPreferencesSchema = z.object({
  theme: z.string(),
  fontSize: z.number().int(),
  language: z.string(),
  dateFormat: z.string(),
  timeFormat: z.string(),
  timezone: z.string(),
  notifications: z.record(z.unknown()),
  uiPreferences: z.record(z.unknown()),
  workingHours: z.unknown().nullable(),
});

/** `PATCH /theme`. */
export const userThemeSchema = z.object({ theme: z.enum(['light', 'dark', 'system']) });

/** `PATCH /font-size`. */
export const userFontSizeSchema = z.object({ fontSize: z.number().int() });

export type UserPreferences = z.infer<typeof userPreferencesSchema>;
