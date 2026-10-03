/**
 * IANA time-zone helpers shared by the calendar event routes and the attendee
 * mails.
 */

import { z } from 'zod';

/** True when `timeZone` is an IANA zone the runtime's Intl can format with. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 50) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The zone when it is valid, else undefined. */
export function validTimeZoneOrUndefined(timeZone: string | null | undefined): string | undefined {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
}

/** Zod field for an event's IANA timezone (max 50 chars, matches the column). */
export const timeZoneSchema = z
  .string()
  .max(50)
  .refine(isValidTimeZone, { message: 'Invalid IANA timezone' });
