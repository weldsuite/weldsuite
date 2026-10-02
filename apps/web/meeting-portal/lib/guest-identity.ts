/**
 * Remembered guest identity (name + email) for the landing form.
 *
 * Stored in localStorage so a guest who reloads, rejoins or opens another
 * meeting link does not have to retype their details. Only name and email are
 * kept; nothing session-related (tokens, ids) ever goes in here. Every access
 * is wrapped because storage can be unavailable (SSR, private windows, blocked
 * site data) and the form must still work without it.
 */

import { guestJoinFormSchema, type GuestJoinFormInput } from './schemas';

export const GUEST_IDENTITY_STORAGE_KEY = 'weldmeet:guest-identity';

/** The saved identity, or null when absent, malformed or storage is unavailable. */
export function readGuestIdentity(): GuestJoinFormInput | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(GUEST_IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = guestJoinFormSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeGuestIdentity(identity: GuestJoinFormInput): void {
  if (typeof window === 'undefined') return;
  try {
    const value: GuestJoinFormInput = { name: identity.name, email: identity.email };
    window.localStorage.setItem(GUEST_IDENTITY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: the guest just retypes next time */
  }
}

export function clearGuestIdentity(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(GUEST_IDENTITY_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
