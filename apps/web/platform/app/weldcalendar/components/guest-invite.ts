import { z } from 'zod';

const emailSchema = z.string().email();

/**
 * The address in free-typed guest text when it can be invited: a valid email
 * (the same rule calendar-api validates attendees with) that is not already on
 * the guest list. Returns the trimmed address, or null.
 */
export function inviteEmailFromQuery(query: string, existingEmails: readonly string[]): string | null {
  const email = query.trim();
  if (!email || !emailSchema.safeParse(email).success) return null;
  const lower = email.toLowerCase();
  if (existingEmails.some((e) => e.trim().toLowerCase() === lower)) return null;
  return email;
}

/** Id of a guest that was invited by typing an address (not a member or contact). */
export function inviteGuestId(email: string): string {
  return `email-${email.trim().toLowerCase()}`;
}
