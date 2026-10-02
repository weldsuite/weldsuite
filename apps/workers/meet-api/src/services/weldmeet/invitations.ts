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
 * Pure functions plus the Resend send, no Hono context.
 */

import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import { buildIcsInvite, sendEmail } from '@weldsuite/transactional-email';

/** Production meeting portal. Used when `MEETING_PORTAL_URL` is not set. */
export const DEFAULT_MEETING_PORTAL_URL = 'https://meet.weldsuite.org';

const FROM = 'WeldMeet <notifications@mail.weldsuite.org>';

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
  organizer: { name: string; email: string };
  joinUrl: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Base64 of a UTF-8 string (Resend takes attachment content as base64). */
function toBase64(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatWhen(start: Date, end: Date | null): string {
  const date = start.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
  if (!end) return date;
  const endTime = end.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
  return `${date} – ${endTime}`;
}

export function buildInvitationEmail(params: InvitationEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const { meeting, organizer, joinUrl } = params;
  const start = toDate(meeting.scheduledStart);
  const end = toDate(meeting.scheduledEnd);
  const when = start ? formatWhen(start, end) : null;
  const description = meeting.description?.trim() || null;

  const subject = `${organizer.name} invited you to "${meeting.title}"`;

  const text = [
    `${organizer.name} invited you to a WeldMeet video meeting: ${meeting.title}`,
    when ? `When: ${when}` : null,
    description,
    '',
    `Join the meeting: ${joinUrl}`,
    'No account needed: open the link in your browser to join.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(meeting.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width: 560px; background-color: #ffffff; border-radius: 12px;">
          <tr>
            <td style="padding: 32px 32px 24px 32px; border-bottom: 1px solid #e5e7eb;">
              <p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">WeldMeet</p>
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #111827;">${escapeHtml(meeting.title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 32px;">
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #374151; line-height: 1.5;"><strong>${escapeHtml(organizer.name)}</strong> invited you to a video meeting.</p>
              ${when ? `<p style="margin: 0 0 16px 0; font-size: 15px; color: #374151; line-height: 1.5;">${escapeHtml(when)}</p>` : ''}
              ${description ? `<p style="margin: 0 0 24px 0; font-size: 14px; color: #6b7280; line-height: 1.6;">${escapeHtml(description)}</p>` : ''}
              <p style="margin: 8px 0 16px 0; text-align: center;">
                <a href="${escapeHtml(joinUrl)}" style="display: inline-block; padding: 12px 32px; background-color: #3b82f6; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; line-height: 1;">Join meeting</a>
              </p>
              <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.5; text-align: center;">No account needed. Or open this link: <a href="${escapeHtml(joinUrl)}" style="color: #3b82f6;">${escapeHtml(joinUrl)}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5; text-align: center;">If you did not expect this invitation, you can safely ignore this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

/** The `.ics` for a scheduled meeting, or null when it has no start time. */
export function buildInvitationIcs(
  params: InvitationEmailParams & { attendee: { email: string; name?: string } },
): string | null {
  const start = toDate(params.meeting.scheduledStart);
  if (!start) return null;
  const end = toDate(params.meeting.scheduledEnd) ?? new Date(start.getTime() + DEFAULT_DURATION_MS);
  return buildIcsInvite({
    uid: `${params.meeting.id}@meet.weldsuite.org`,
    summary: params.meeting.title,
    description: [params.meeting.description?.trim(), `Join: ${params.joinUrl}`]
      .filter(Boolean)
      .join('\n\n'),
    location: params.joinUrl,
    startTime: start,
    endTime: end > start ? end : new Date(start.getTime() + DEFAULT_DURATION_MS),
    // ORGANIZER needs a mailto; fall back to the sender when the organizer
    // has no email on file.
    organizer: {
      email: params.organizer.email || 'notifications@mail.weldsuite.org',
      name: params.organizer.name,
    },
    attendees: [{ email: params.attendee.email, name: params.attendee.name }],
  });
}

/**
 * Email one invitation. Returns whether it was handed to Resend; never throws
 * (a mail failure must not fail the invite, the attendee is already saved).
 */
export async function sendInvitationEmail(
  apiKey: string | undefined,
  params: InvitationEmailParams & { attendee: { email: string; name?: string } },
): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const { subject, html, text } = buildInvitationEmail(params);
    const ics = buildInvitationIcs(params);
    await sendEmail(apiKey, {
      from: FROM,
      to: [params.attendee.email],
      subject,
      html,
      text,
      ...(params.organizer.email ? { reply_to: params.organizer.email } : {}),
      ...(ics
        ? {
            attachments: [
              {
                filename: 'invite.ics',
                content: toBase64(ics),
                content_type: 'text/calendar; method=REQUEST',
              },
            ],
          }
        : {}),
    });
    return true;
  } catch (err) {
    console.error('[meet-api/invitations] invitation email failed:', err);
    return false;
  }
}
