/**
 * Validation + normalisation for the self-profile form (Settings › Profile).
 *
 * The same rules are enforced server-side in
 * `apps/workers/app-api/src/routes/settings-profile/index.ts`; keep the two in
 * sync (the worker cannot import from the platform).
 */

export const PROFILE_NAME_MAX = 200;

/** Fewest / most digits a phone number may carry (E.164 allows 15). */
export const PHONE_MIN_DIGITS = 6;
export const PHONE_MAX_DIGITS = 15;

const PHONE_ALLOWED = /^\+?[\d\s\-().]+$/;

export type ProfileFieldError = 'nameRequired' | 'nameTooLong' | 'phoneInvalid';

/** Trim and collapse inner whitespace, so "+31  6 1234" and " +31 6 1234 " compare equal. */
export function normalizePhone(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Empty is allowed (the phone is optional); otherwise digits, spaces, + (leading), -, (), . */
export function isValidPhone(value: string): boolean {
  const phone = normalizePhone(value);
  if (phone === '') return true;
  if (!PHONE_ALLOWED.test(phone)) return false;
  const digits = phone.replace(/\D/g, '').length;
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

export function validateProfileName(value: string): ProfileFieldError | null {
  const name = value.trim();
  if (name === '') return 'nameRequired';
  if (name.length > PROFILE_NAME_MAX) return 'nameTooLong';
  return null;
}

export function validateProfilePhone(value: string): ProfileFieldError | null {
  return isValidPhone(value) ? null : 'phoneInvalid';
}

export interface ProfileFormErrors {
  name: ProfileFieldError | null;
  phone: ProfileFieldError | null;
}

export function validateProfile(data: { name: string; phone: string }): ProfileFormErrors {
  return { name: validateProfileName(data.name), phone: validateProfilePhone(data.phone) };
}

export function hasProfileErrors(errors: ProfileFormErrors): boolean {
  return errors.name !== null || errors.phone !== null;
}

/**
 * The timezone to show for a profile.
 *
 * The API stores 'UTC' as the column default, so a profile that was never
 * edited reads back as 'UTC' even when the person is in Europe/Amsterdam. Treat
 * an empty value or the untouched 'UTC' default as "not set" and fall back to
 * the browser's zone. Any other stored zone is an explicit choice and is kept.
 */
export function resolveProfileTimezone(
  stored: string | null | undefined,
  browserTimezone: string,
): { timezone: string; prefilled: boolean } {
  const value = (stored ?? '').trim();
  if (value !== '' && value !== 'UTC') return { timezone: value, prefilled: false };
  if (browserTimezone && browserTimezone !== 'UTC') {
    return { timezone: browserTimezone, prefilled: true };
  }
  return { timezone: value || 'UTC', prefilled: false };
}
