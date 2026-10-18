/**
 * Request validation for PUT /api/settings/profile.
 *
 * The platform enforces the same rules in the form
 * (apps/web/platform/lib/profile-validation.ts); keep the two in sync.
 */

import { z } from 'zod';

export const PROFILE_NAME_MAX = 200;
const PHONE_MIN_DIGITS = 6;
const PHONE_MAX_DIGITS = 15;
const PHONE_ALLOWED = /^\+?[\d\s\-().]+$/;

/** Trim and collapse inner whitespace. */
export function normalizePhone(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Empty is allowed; otherwise digits, spaces, a leading +, -, (), . with 6-15 digits. */
export function isValidPhone(value: string): boolean {
  const phone = normalizePhone(value);
  if (phone === '') return true;
  if (!PHONE_ALLOWED.test(phone)) return false;
  const digits = phone.replace(/\D/g, '').length;
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

/**
 * Mirrors legacy `updateProfileSchema` (Zod v3), plus `timezone`.
 *
 * `timezone` is accepted and written to the EXISTING `user_preferences.timezone`
 * column (`varchar(100)`, notNull, default 'UTC'); the `.max(100)` cap matches
 * that column so an oversized value 400s instead of overflowing the write.
 *
 * `name` is required when present (a blank name used to be saved as empty);
 * omitting it still leaves the stored name untouched. `phone` may be empty
 * (clears it) but otherwise must look like a phone number, and is stored
 * normalised.
 */
export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(PROFILE_NAME_MAX, `Name must be ${PROFILE_NAME_MAX} characters or fewer`)
    .optional(),
  nickname: z.string().optional(),
  phone: z
    .string()
    .refine(isValidPhone, 'Enter a valid phone number')
    .transform(normalizePhone)
    .optional(),
  jobTitle: z.string().optional(),
  bio: z.string().optional(),
  timezone: z.string().min(1).max(100).optional(),
});
