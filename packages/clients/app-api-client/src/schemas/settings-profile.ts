/**
 * `/api/settings/profile` — the caller's own profile (app-api
 * `routes/settings-profile`). Response shapes.
 */

import { z } from 'zod';

/** The composed self-profile `GET` and `PUT` answer with. */
export const selfProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  nickname: z.string(),
  picture: z.string(),
  phone: z.string(),
  company: z.string(),
  jobTitle: z.string(),
  bio: z.string(),
  timezone: z.string(),
});

/** `PUT /avatar`: where the stored image is served. */
export const selfAvatarSchema = z.object({ imageUrl: z.string() });

export type SelfProfile = z.infer<typeof selfProfileSchema>;
export type SelfAvatar = z.infer<typeof selfAvatarSchema>;
