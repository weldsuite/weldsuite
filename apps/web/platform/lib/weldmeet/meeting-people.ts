/**
 * Who is on a meeting, for the Upcoming / History lists.
 *
 * The organizer comes from `meeting.organizer` (always on list items) and falls
 * back to the organizer attendee row of older payloads. Participants of a
 * meeting that has not run are its organizer plus its attendees; for one that
 * ran they are the people who actually joined (`lastSession.participants`),
 * with the organizer added when they did not.
 */

import type { Meeting } from '@/hooks/queries/use-weldmeet-queries';

export interface MeetingPerson {
  /** Stable key for React lists and de-duplication. */
  key: string;
  userId?: string;
  name: string;
  avatar?: string;
}

function personKey(parts: { userId?: string | null; email?: string | null; name?: string | null }, index: number): string {
  return parts.userId || parts.email?.toLowerCase() || parts.name?.toLowerCase() || `person-${index}`;
}

export function getMeetingOrganizer(meeting: Meeting): MeetingPerson | null {
  if (meeting.organizer) {
    return {
      key: meeting.organizer.userId,
      userId: meeting.organizer.userId,
      name: meeting.organizer.name ?? '',
      avatar: meeting.organizer.avatar ?? undefined,
    };
  }
  const row = (meeting.attendees ?? []).find((a) => a.role === 'organizer');
  if (!row) return null;
  return { key: personKey(row, 0), userId: row.userId || undefined, name: row.name || row.email, avatar: row.avatar };
}

function addUnique(list: MeetingPerson[], person: MeetingPerson): void {
  if (!list.some((p) => p.key === person.key)) list.push(person);
}

/** Organizer first, then the invited attendees. */
export function getInvitedParticipants(meeting: Meeting): MeetingPerson[] {
  const people: MeetingPerson[] = [];
  const organizer = getMeetingOrganizer(meeting);
  if (organizer) addUnique(people, organizer);
  (meeting.attendees ?? []).forEach((a, i) => {
    addUnique(people, {
      key: personKey(a, i),
      userId: a.userId || undefined,
      name: a.name || a.email,
      avatar: a.avatar,
    });
  });
  return people;
}

/** Who joined the last session (plus the organizer); the invited people when nobody did. */
export function getHistoryParticipants(meeting: Meeting): MeetingPerson[] {
  const joined = meeting.lastSession?.participants ?? [];
  if (joined.length === 0) return getInvitedParticipants(meeting);
  const people: MeetingPerson[] = [];
  const organizer = getMeetingOrganizer(meeting);
  if (organizer) addUnique(people, organizer);
  joined.forEach((p, i) => {
    addUnique(people, {
      key: personKey(p, i),
      userId: p.userId,
      name: p.userName ?? '',
      avatar: p.userAvatar ?? undefined,
    });
  });
  return people;
}
