/**
 * Maps live-call participants to the records they belong to (team member,
 * CRM person, legacy contact) using the persisted session participants.
 *
 * The call UI only knows RealtimeKit identifiers (`p.id`, `p.userId`,
 * `p.customParticipantId`); the links live on the session rows the API writes.
 * Pure, so it can be rebuilt whenever a fresher session is fetched and unit
 * tested without React.
 */

export interface ParticipantLink {
  workspaceMemberId?: string;
  personId?: string;
  contactId?: string;
}

/** The subset of a persisted session participant this module reads. */
export interface SessionParticipantInput {
  userId?: string;
  customParticipantId?: string;
  cfSessionId?: string;
  workspaceMemberId?: string;
  personId?: string;
  contactId?: string;
}

export interface ParticipantLookup {
  /** Identifier -> record links, for participants that have at least one. */
  links: Map<string, ParticipantLink>;
  /** Identifier -> lower-cased email, for portal guests (`userId` = `guest:<email>`). */
  guestEmails: Map<string, string>;
}

const GUEST_USER_ID_PREFIX = 'guest:';

/** The email behind a portal guest's `guest:<email>` user id, or undefined. */
export function guestEmailFromUserId(userId: string | undefined): string | undefined {
  if (!userId?.startsWith(GUEST_USER_ID_PREFIX)) return undefined;
  const email = userId.slice(GUEST_USER_ID_PREFIX.length).trim().toLowerCase();
  return email.includes('@') ? email : undefined;
}

/**
 * Indexes every identifier we know for a persisted participant.
 *
 * Platform-side joins set `userId === customParticipantId === Clerk userId`, so
 * one key would do. Meeting-portal guests use a colour-seed UUID as
 * `customParticipantId` but `guest:<email>` as `userId`, so the map needs both,
 * plus `cfSessionId`, which always matches the RTK-assigned `p.id`. The first
 * row to claim an identifier wins. `contactId` is kept for historical rows;
 * new writes target `personId`.
 *
 * Rows without any link are still scanned for a guest email: a guest the
 * resolver could not link yet has no personId, but its email is exactly what
 * lets the UI find (or create) the right person.
 */
export function buildParticipantLookup(
  participants: ReadonlyArray<SessionParticipantInput> | null | undefined,
): ParticipantLookup {
  const links = new Map<string, ParticipantLink>();
  const guestEmails = new Map<string, string>();

  for (const sp of participants ?? []) {
    const keys = [sp?.userId, sp?.customParticipantId, sp?.cfSessionId].filter(
      (key): key is string => !!key,
    );

    const link: ParticipantLink = {
      workspaceMemberId: sp?.workspaceMemberId,
      personId: sp?.personId,
      contactId: sp?.contactId,
    };
    if (link.workspaceMemberId || link.personId || link.contactId) {
      for (const key of keys) {
        if (!links.has(key)) links.set(key, link);
      }
    }

    const email = guestEmailFromUserId(sp?.userId);
    if (email) {
      for (const key of keys) {
        if (!guestEmails.has(key)) guestEmails.set(key, email);
      }
    }
  }

  return { links, guestEmails };
}

/** First link found for any of the candidate identifiers, in the order given. */
export function findParticipantLink(
  lookup: ParticipantLookup,
  candidates: ReadonlyArray<string | undefined>,
): ParticipantLink | undefined {
  for (const key of candidates) {
    if (!key) continue;
    const hit = lookup.links.get(key);
    if (hit) return hit;
  }
  return undefined;
}

/** First guest email found for any of the candidate identifiers. */
export function findGuestEmail(
  lookup: ParticipantLookup,
  candidates: ReadonlyArray<string | undefined>,
): string | undefined {
  for (const key of candidates) {
    if (!key) continue;
    const hit = lookup.guestEmails.get(key);
    if (hit) return hit;
  }
  return undefined;
}
