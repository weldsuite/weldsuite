/**
 * WeldMeet — meeting invitations (TASK-717).
 *
 * "Add people" on a meeting adds the invitee to `meetings.attendees`
 * (role `attendee`, status `pending`) and emails them the public join link
 * (`<meeting portal>/<workspaceId>/<joinCode>`), with an `.ics` attached when
 * the meeting has a scheduled time. Invitees can be workspace members, CRM
 * people, or any email address: the participant resolver links each one to a
 * member or to a (found or auto-created) Person.
 *
 * The invitation mail (`sendInvitationEmail`) renders through
 * `@weldsuite/emails` (the `meet.invitation` template) and sends via
 * `workerTransport(env)`. Everything else here is pure functions, no Hono
 * context.
 */

import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import { icsAttachment, sendSystemEmail } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { Env } from '../../types';

/** Production meeting portal. Used when `MEETING_PORTAL_URL` is not set. */
export const DEFAULT_MEETING_PORTAL_URL = 'https://meet.weldsuite.org';

/** Length of the `.ics` event when the meeting has a start but no end. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

export interface InviteeInput {
  email: string;
  name?: string;
}

/** An invitee after the participant resolver ran. */
export interface ResolvedInvitee {
  email: string;
  name: string;
  /** Clerk user id when the invitee is a workspace member, else ''. */
  userId: string;
  avatar?: string;
  workspaceMemberId?: string;
  personId?: string;
}

/**
 * Trim, lowercase and de-duplicate invitees by email. The first occurrence of
 * an address wins (and keeps its name).
 */
export function normalizeInvitees(invitees: InviteeInput[]): InviteeInput[] {
  const seen = new Set<string>();
  const out: InviteeInput[] = [];
  for (const invitee of invitees) {
    const email = invitee.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = invitee.name?.trim();
    out.push(name ? { email, name } : { email });
  }
  return out;
}

/**
 * Turn attendees sent on meeting create ({ email, name? } or the full stored
 * shape) into full `MeetingAttendee` rows. Emails are trimmed, lowercased and
 * de-duplicated (first wins); fields the caller did send (userId, role, RSVP
 * status, member/person links) are kept. No resolver, no emails: this only
 * shapes data.
 */
export function toMeetingAttendees(
  input: Array<{ email: string; name?: string } & Partial<MeetingAttendee>>,
): MeetingAttendee[] {
  const seen = new Set<string>();
  const out: MeetingAttendee[] = [];
  for (const raw of input) {
    const email = raw.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      ...raw,
      userId: raw.userId ?? '',
      email,
      name: raw.name?.trim() || email,
      status: raw.status ?? 'pending',
      role: raw.role ?? 'attendee',
    });
  }
  return out;
}

export interface MergeResult {
  attendees: MeetingAttendee[];
  /** Attendees that were added by this call. */
  added: MeetingAttendee[];
  /** Emails that were already on the meeting and were left as they were. */
  alreadyInvited: string[];
}

/**
 * Append invitees that are not on the meeting yet. Existing attendees are
 * matched by email (case-insensitive) or, for members, by user id, and are
 * never modified: re-inviting someone must not reset their RSVP or role.
 * A walk-in guest (joined through the link without an invitation) who is now
 * invited explicitly is promoted to an invited attendee.
 */
export function mergeInvitees(
  existing: MeetingAttendee[],
  invitees: ResolvedInvitee[],
): MergeResult {
  const attendees = existing.map((a) => ({ ...a }));
  const added: MeetingAttendee[] = [];
  const alreadyInvited: string[] = [];

  for (const invitee of invitees) {
    const match = attendees.find(
      (a) =>
        (a.email && a.email.toLowerCase() === invitee.email) ||
        (invitee.userId !== '' && a.userId === invitee.userId),
    );
    if (match) {
      if (match.source === 'walk_in') {
        delete match.source;
        added.push(match);
      } else {
        alreadyInvited.push(invitee.email);
      }
      continue;
    }

    const attendee: MeetingAttendee = {
      userId: invitee.userId,
      email: invitee.email,
      name: invitee.name,
      status: 'pending',
      role: 'attendee',
    };
    if (invitee.avatar) attendee.avatar = invitee.avatar;
    if (invitee.workspaceMemberId) attendee.workspaceMemberId = invitee.workspaceMemberId;
    if (invitee.personId) attendee.personId = invitee.personId;
    attendees.push(attendee);
    added.push(attendee);
  }

  return { attendees, added, alreadyInvited };
}

export function getMeetingPortalUrl(configured: string | undefined): string {
  return (configured?.trim() || DEFAULT_MEETING_PORTAL_URL).replace(/\/+$/, '');
}

/** The public guest link — same shape as the platform's `buildMeetingShareUrl`. */
export function buildMeetingJoinUrl(
  portalUrl: string,
  workspaceId: string,
  joinCode: string,
): string {
  return `${portalUrl}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(joinCode)}`;
}

// ── Email ────────────────────────────────────────────────────────────────

export interface InvitationMeeting {
  id: string;
  title: string;
  description?: string | null;
  scheduledStart?: Date | string | null;
  scheduledEnd?: Date | string | null;
}

export interface InvitationEmailParams {
  meeting: InvitationMeeting;
  organizer: { name: string; email: string; timezone?: string };
  joinUrl: string;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Email one invitation through `@weldsuite/emails` (the `meet.invitation`
 * template), with an `.ics` attached when the meeting has a scheduled time
 * (default 1h duration when it has no end). Returns whether it was handed to
 * the transport; never throws (a mail failure must not fail the invite, the
 * attendee is already saved).
 */
export async function sendInvitationEmail(
  env: Env,
  params: InvitationEmailParams & { attendee: { email: string; name?: string } },
): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) return false;

  const { meeting, organizer, joinUrl, attendee } = params;
  const start = toDate(meeting.scheduledStart);
  const end = toDate(meeting.scheduledEnd);
  // ORGANIZER needs a mailto; fall back to the sender when the organizer has
  // no email on file.
  const organizerEmail = organizer.email || 'notifications@mail.weldsuite.org';

  try {
    await sendSystemEmail(transport, {
      template: 'meet.invitation',
      props: {
        organizerName: organizer.name,
        title: meeting.title,
        description: meeting.description ?? undefined,
        startTime: start ? start.toISOString() : undefined,
        endTime: end ? end.toISOString() : undefined,
        timezone: organizer.timezone,
        joinUrl,
      },
      to: attendee.email,
      replyTo: organizer.email || undefined,
      attachments: start
        ? [
            icsAttachment({
              uid: `${meeting.id}@meet.weldsuite.org`,
              product: 'WeldMeet',
              title: meeting.title,
              description: meeting.description ?? undefined,
              start,
              end: end && end > start ? end : new Date(start.getTime() + DEFAULT_DURATION_MS),
              organizer: { email: organizerEmail, name: organizer.name },
              attendees: [{ email: attendee.email, name: attendee.name }],
              meetingUrl: joinUrl,
            }),
          ]
        : [],
    });
    return true;
  } catch (err) {
    console.error('[meet-api/invitations] invitation email failed:', err);
    return false;
  }
}
