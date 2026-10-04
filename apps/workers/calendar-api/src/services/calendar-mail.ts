/**
 * Calendar attendee mail — invite / reschedule / cancellation.
 *
 * Ported from the legacy api-worker calendar surface (W5b of the
 * legacy-worker phase-out):
 *   - apps/api-worker/src/routes/calendar/events.ts       (send logic)
 *   - apps/api-worker/src/lib/ics.ts                      (ICS generation)
 *   - apps/api-worker/src/lib/email-templates/calendar-invite.ts (HTML)
 *
 * Pure functions, no Hono context.
 *
 * TRANSPORT: the legacy route used `@weldsuite/transactional-email`
 * (`sendEmail` / `sendTemplateEmail` → Resend). app-api does not depend on
 * that package, so — exactly as `services/internal-email.ts` and
 * `workflows/send-digest.ts` already do — the Resend call is a deliberate
 * minimal inline of it. If the dependency is ever added to app-api's
 * package.json, `postToResend` can be swapped for the package import.
 *
 * Every send is best-effort: a mail failure must never fail the mutation
 * that triggered it (same contract as the legacy route, which wrapped each
 * send in its own try/catch).
 */

import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from '../types';
import { validTimeZoneOrUndefined } from './calendar-timezone';

// ── Env ──────────────────────────────────────────────────────────────────

/**
 * Resend template ids for the calendar mails. These are optional secrets that
 * are not (yet) declared on `Env` — read defensively so this compiles against
 * the current `types.ts` and lights up as soon as the integrator adds them.
 * When unset we fall back to the inline HTML templates below, which is the
 * same branch the legacy route took.
 */
interface CalendarTemplateEnv {
  RESEND_MEETING_INVITE_TEMPLATE_ID?: string;
  RESEND_MEETING_UPDATE_TEMPLATE_ID?: string;
  RESEND_MEETING_CANCEL_TEMPLATE_ID?: string;
}

function templateIds(env: Env): CalendarTemplateEnv {
  return env as Env & CalendarTemplateEnv;
}

/** Optional override of the platform base URL the app links are built from. */
interface AppUrlEnv {
  APP_URL?: string;
}

const FROM = 'WeldCalendar <notifications@mail.weldsuite.org>';

export function getPlatformUrl(environment: string): string {
  const urls: Record<string, string> = {
    development: 'http://localhost:3000',
    test: 'https://app-test.weldsuite.org',
    preview: 'https://app-preview.weldsuite.org',
    production: 'https://app.weldsuite.org',
  };
  return urls[environment] || 'https://app.weldsuite.org';
}

/**
 * The authenticated calendar deep-link. Only workspace members can open it, so
 * it is never put in a mail to an external guest (see `memberEmails`).
 */
function eventUrlFor(env: Env): string {
  const override = (env as Env & AppUrlEnv).APP_URL?.trim().replace(/\/+$/, '');
  return `${override || getPlatformUrl(env.ENVIRONMENT)}/weldcalendar`;
}

// ── Organizer lookup ─────────────────────────────────────────────────────

export interface OrganizerInfo {
  name: string;
  email: string;
  /** The organizer's preferred IANA zone; times render in it when the event has none. */
  timezone?: string;
}

/**
 * Resolve the organizer's display name + email from the tenant member table,
 * plus their preferred timezone (`user_preferences`) when they have one.
 */
export async function getOrganizerInfo(
  db: Database,
  userId: string,
): Promise<OrganizerInfo> {
  const { workspaceMembers, userPreferences } = schema;
  const [organizer] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  let timezone: string | undefined;
  try {
    const [prefs] = await db
      .select({ timezone: userPreferences.timezone })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    timezone = validTimeZoneOrUndefined(prefs?.timezone);
  } catch (err) {
    console.error('[calendar-api/calendar-mail] organizer timezone lookup failed:', err);
  }

  return { name: organizer?.name ?? 'Someone', email: organizer?.email ?? '', timezone };
}

/**
 * The lower-cased subset of `emails` that belong to active internal workspace
 * members. Members can open the authenticated calendar; everyone else is a
 * guest.
 */
export async function getMemberEmails(db: Database, emails: string[]): Promise<Set<string>> {
  const lowered = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (lowered.length === 0) return new Set();
  const { workspaceMembers } = schema;
  try {
    const rows = await db
      .select({ email: workspaceMembers.email })
      .from(workspaceMembers)
      .where(
        and(
          inArray(sql`lower(${workspaceMembers.email})`, lowered),
          isNull(workspaceMembers.deletedAt),
          eq(workspaceMembers.status, 'ACTIVE'),
          // Outside collaborators are scoped to channels; they have no calendar.
          eq(workspaceMembers.memberType, 'INTERNAL'),
        ),
      );
    return new Set(rows.map((r) => (r.email ?? '').toLowerCase()).filter(Boolean));
  } catch (err) {
    console.error('[calendar-api/calendar-mail] member lookup failed:', err);
    return new Set();
  }
}

// ── ICS (RFC 5545) ───────────────────────────────────────────────────────

export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsEventParams {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  startTime?: string;
  endTime?: string;
  organizerName: string;
  organizerEmail: string;
  attendeeEmail: string;
  method?: IcsMethod;
  sequence?: number;
  url?: string;
  /**
   * Video-conference join link. Becomes LOCATION when the event has no physical
   * location (else it is kept out of LOCATION), is always spelled out as
   * "Join: <url>" in DESCRIPTION, and is advertised to Google/Outlook through
   * X-GOOGLE-CONFERENCE. When set it is also the URL unless `url` overrides it.
   * Ignored for CANCEL.
   */
  meetingUrl?: string;
  /** All-day events are written as DATE values (DTEND exclusive) in `timezone`. */
  allDay?: boolean;
  /** IANA zone used to resolve the calendar day of all-day events. */
  timezone?: string;
}

interface EmailAttachment {
  filename: string;
  content: string;
  content_type?: string;
}

/** UTC date-time form, e.g. 20261001T210000Z. */
function formatIcsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The calendar day of `iso` in `timeZone` as [year, month, day]. */
function zonedYmd(iso: string, timeZone: string): [number, number, number] {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  const [y, m, d] = text.split('-').map(Number);
  return [y, m, d];
}

function icsDateOnly(ymd: [number, number, number], plusDays = 0): string {
  const d = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2] + plusDays));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Parameter values containing , ; : must be quoted (and cannot contain quotes). */
function icsParamValue(text: string): string {
  return `"${text.replace(/["\r\n]/g, ' ')}"`;
}

const ICS_MAX_OCTETS = 75;

/** Fold a content line to 75 octets (continuations start with a space). */
function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= ICS_MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = ICS_MAX_OCTETS;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = ICS_MAX_OCTETS - 1; // the leading space of a continuation line
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * A SEQUENCE that increases with every revision sent for a UID: clients ignore
 * a REQUEST/CANCEL whose sequence is not higher than the one they hold, so a
 * constant would make the second reschedule (or a cancel after a reschedule) a
 * no-op in the guest's calendar. Seconds since the epoch is monotonic without
 * having to persist a counter, and fits the 32-bit integer clients expect.
 */
export function nextIcsSequence(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

export function generateIcs(params: IcsEventParams): string {
  const {
    uid,
    title,
    description,
    location,
    startTime,
    endTime,
    organizerName,
    organizerEmail,
    attendeeEmail,
    method = 'REQUEST',
    sequence = 0,
    meetingUrl,
    allDay,
    timezone,
  } = params;
  const joinUrl = method === 'CANCEL' ? undefined : meetingUrl;
  const url = params.url ?? joinUrl;

  const now = formatIcsDate(new Date().toISOString());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WeldSuite//WeldCalendar//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SEQUENCE:${sequence}`,
    `SUMMARY:${escapeIcsText(title)}`,
  ];
  if (organizerEmail) {
    lines.push(`ORGANIZER;CN=${icsParamValue(organizerName)}:mailto:${organizerEmail}`);
  }
  lines.push(
    `ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${attendeeEmail}`,
  );

  if (startTime) {
    if (allDay) {
      const zone = validTimeZoneOrUndefined(timezone) ?? 'UTC';
      lines.push(`DTSTART;VALUE=DATE:${icsDateOnly(zonedYmd(startTime, zone))}`);
      // DTEND of a DATE event is exclusive: the day after the last day.
      lines.push(`DTEND;VALUE=DATE:${icsDateOnly(zonedYmd(endTime ?? startTime, zone), 1)}`);
    } else {
      lines.push(`DTSTART:${formatIcsDate(startTime)}`);
      // Never emit a DTEND that is not after DTSTART (legacy rows may have one).
      if (endTime && new Date(endTime).getTime() > new Date(startTime).getTime()) {
        lines.push(`DTEND:${formatIcsDate(endTime)}`);
      }
    }
  }

  const descriptionParts = [description, joinUrl ? `Join: ${joinUrl}` : undefined].filter(
    (p): p is string => !!p,
  );
  if (descriptionParts.length) lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join('\n\n'))}`);
  const icsLocation = location || joinUrl;
  if (icsLocation) lines.push(`LOCATION:${escapeIcsText(icsLocation)}`);
  if (url) lines.push(`URL:${url}`);
  if (joinUrl) lines.push(`X-GOOGLE-CONFERENCE:${joinUrl}`);

  lines.push(method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

export function icsAttachment(params: IcsEventParams): EmailAttachment {
  return {
    filename: 'invite.ics',
    content: generateIcs(params),
    content_type: `text/calendar; method=${params.method || 'REQUEST'}`,
  };
}

// ── HTML templates ───────────────────────────────────────────────────────

export interface CalendarEmailParams {
  organizerName: string;
  eventTitle: string;
  eventDescription?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  /**
   * Link to the authenticated WeldCalendar app. Only pass it for recipients who
   * are workspace members: guests have no account, so for them the button is
   * left out.
   */
  eventUrl?: string;
  /** Video-conference join link; renders a prominent join button + the plain URL. */
  meetingUrl?: string;
  /** IANA zone the times are shown in (the Worker itself runs in UTC). */
  timezone?: string;
  allDay?: boolean;
}

export interface CalendarRescheduleParams extends CalendarEmailParams {
  oldStartTime?: string;
  oldEndTime?: string;
  /** Not a move, e.g. a join link was added: the copy says "updated". */
  updated?: boolean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Zone name used when an event/organizer has none. */
const FALLBACK_TIME_ZONE = 'UTC';

function zoneOf(timezone?: string): string {
  return validTimeZoneOrUndefined(timezone) ?? FALLBACK_TIME_ZONE;
}

function formatDateTime(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: zoneOf(timezone),
  });
}

function formatTime(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: zoneOf(timezone),
  });
}

function formatDate(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: zoneOf(timezone),
  });
}

function sameDay(a: string, b: string, timezone?: string): boolean {
  const zone = zoneOf(timezone);
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(iso));
  return fmt(a) === fmt(b);
}

/** Plain-text "when" line, shared by the HTML (escaped by the caller) and text bodies. */
export function formatWhen(
  startTime: string,
  endTime: string | undefined,
  timezone?: string,
  allDay?: boolean,
): string {
  if (allDay) {
    const days = endTime && !sameDay(startTime, endTime, timezone)
      ? `${formatDate(startTime, timezone)} – ${formatDate(endTime, timezone)}`
      : formatDate(startTime, timezone);
    return `${days} (all day)`;
  }
  if (!endTime) return formatDateTime(startTime, timezone);
  const end = sameDay(startTime, endTime, timezone)
    ? formatTime(endTime, timezone)
    : formatDateTime(endTime, timezone);
  return `${formatDateTime(startTime, timezone)} – ${end}`;
}

function wrapLayout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width: 560px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 24px 32px; border-bottom: 1px solid #e5e7eb;">
              <p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">WeldCalendar</p>
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #111827;">${escapeHtml(title)}</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 24px 32px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5; text-align: center;">
                If you did not expect this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderTimeSection(
  startTime: string | undefined,
  endTime: string | undefined,
  timezone?: string,
  allDay?: boolean,
): string {
  if (!startTime) return '';
  return `
    <tr>
      <td style="padding: 0 0 16px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right: 8px; vertical-align: top; color: #6b7280;">&#128197;</td>
            <td style="font-size: 15px; color: #374151; line-height: 1.5;">
              ${escapeHtml(formatWhen(startTime, endTime, timezone, allDay))}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderLocationSection(location?: string): string {
  if (!location) return '';
  return `
    <tr>
      <td style="padding: 0 0 16px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right: 8px; vertical-align: top; color: #6b7280;">&#128205;</td>
            <td style="font-size: 15px; color: #374151; line-height: 1.5;">
              ${escapeHtml(location)}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderDescriptionSection(description?: string): string {
  if (!description) return '';
  return `
    <tr>
      <td style="padding: 0 0 24px 0;">
        <p style="margin: 0; font-size: 14px; color: #6b7280; line-height: 1.6;">${escapeHtml(description)}</p>
      </td>
    </tr>`;
}

function renderButton(label: string, url: string, variant: 'primary' | 'secondary' = 'primary'): string {
  const style =
    variant === 'primary'
      ? 'background-color: #3b82f6; color: #ffffff; border: 1px solid #3b82f6;'
      : 'background-color: #ffffff; color: #3b82f6; border: 1px solid #3b82f6;';
  return `
    <tr>
      <td style="padding: 8px 0 0 0;" align="center">
        <a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 32px; ${style} font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; line-height: 1;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>`;
}

/** WeldMeet rooms live on meet(-env).weldsuite.org; anything else is a third-party link. */
function isWeldMeetUrl(url: string): boolean {
  try {
    return /^meet(-[a-z]+)?\.weldsuite\.org$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function joinLabel(meetingUrl: string): string {
  return isWeldMeetUrl(meetingUrl) ? 'Join WeldMeet meeting' : 'Join video meeting';
}

/** Join button + the plain URL (for clients that strip buttons), then the member-only app link. */
function renderActions(meetingUrl: string | undefined, eventUrl: string | undefined): string {
  const parts: string[] = [];
  if (meetingUrl) {
    parts.push(renderButton(joinLabel(meetingUrl), meetingUrl));
    parts.push(`
    <tr>
      <td style="padding: 12px 0 0 0;" align="center">
        <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.5; word-break: break-all;">
          Or copy this link into your browser:<br>
          <a href="${escapeHtml(meetingUrl)}" style="color: #3b82f6;">${escapeHtml(meetingUrl)}</a>
        </p>
      </td>
    </tr>`);
  }
  if (eventUrl) {
    parts.push(
      `<tr><td style="height: 12px;"></td></tr>`,
      renderButton(meetingUrl ? 'View in WeldCalendar' : 'View Event', eventUrl, meetingUrl ? 'secondary' : 'primary'),
    );
  }
  return parts.join('');
}

export function renderCalendarInviteEmail(params: CalendarEmailParams): string {
  const {
    organizerName, eventTitle, eventDescription, startTime, endTime, location, eventUrl,
    meetingUrl, timezone, allDay,
  } = params;
  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="padding: 0 0 20px 0;">
          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.6;">
            <strong>${escapeHtml(organizerName)}</strong> has invited you to an event:
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding: 16px 20px; background-color: #f9fafb; border-radius: 8px; border-left: 4px solid #3b82f6; margin-bottom: 16px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #111827;">${escapeHtml(eventTitle)}</h2>
        </td>
      </tr>
      <tr><td style="height: 16px;"></td></tr>
      ${renderTimeSection(startTime, endTime, timezone, allDay)}
      ${renderLocationSection(location)}
      ${renderDescriptionSection(eventDescription)}
      ${renderActions(meetingUrl, eventUrl)}
    </table>`;
  return wrapLayout('Event Invitation', body);
}

export function renderCalendarRescheduleEmail(params: CalendarRescheduleParams): string {
  const {
    organizerName, eventTitle, eventDescription, startTime, endTime,
    oldStartTime, oldEndTime, location, eventUrl, meetingUrl, timezone, allDay, updated,
  } = params;

  const oldTimeSection = oldStartTime
    ? `
      <tr>
        <td style="padding: 0 0 8px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-size: 14px; color: #9ca3af; line-height: 1.5; text-decoration: line-through;">
                ${escapeHtml(formatWhen(oldStartTime, oldEndTime, timezone, allDay))}
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="padding: 0 0 20px 0;">
          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.6;">
            <strong>${escapeHtml(organizerName)}</strong> has ${updated ? 'updated' : 'rescheduled'} an event:
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding: 16px 20px; background-color: #f9fafb; border-radius: 8px; border-left: 4px solid #f59e0b; margin-bottom: 16px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #111827;">${escapeHtml(eventTitle)}</h2>
        </td>
      </tr>
      <tr><td style="height: 16px;"></td></tr>
      ${oldTimeSection}
      ${renderTimeSection(startTime, endTime, timezone, allDay)}
      ${renderLocationSection(location)}
      ${renderDescriptionSection(eventDescription)}
      ${renderActions(meetingUrl, eventUrl)}
    </table>`;
  return wrapLayout(updated ? 'Event Updated' : 'Event Rescheduled', body);
}

/** A cancelled event has nothing to join, so no meeting link and no app button. */
export function renderCalendarCancelEmail(params: CalendarEmailParams): string {
  return renderEndedEmail('cancelled', params);
}

/**
 * Sent to a guest who was taken off an event that carries on for everyone else:
 * "removed you", not "cancelled", since the event itself still exists.
 */
export function renderCalendarRemovedEmail(params: CalendarEmailParams): string {
  return renderEndedEmail('removed', params);
}

function renderEndedEmail(variant: 'cancelled' | 'removed', params: CalendarEmailParams): string {
  const { organizerName, eventTitle, startTime, endTime, location, timezone, allDay } = params;
  const sentence =
    variant === 'removed'
      ? `<strong>${escapeHtml(organizerName)}</strong> removed you from an event:`
      : `<strong>${escapeHtml(organizerName)}</strong> has cancelled an event:`;
  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="padding: 0 0 20px 0;">
          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.6;">
            ${sentence}
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding: 16px 20px; background-color: #f9fafb; border-radius: 8px; border-left: 4px solid #ef4444; margin-bottom: 16px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #111827; text-decoration: line-through;">${escapeHtml(eventTitle)}</h2>
        </td>
      </tr>
      <tr><td style="height: 16px;"></td></tr>
      ${renderTimeSection(startTime, endTime, timezone, allDay)}
      ${renderLocationSection(location)}
    </table>`;
  return wrapLayout(variant === 'removed' ? 'Removed from event' : 'Event Cancelled', body);
}

/**
 * `cancel`: the event is gone. `removed`: the event goes on but this recipient
 * is no longer on it (the .ics is still a CANCEL so it leaves their calendar).
 */
export type MailKind = 'invite' | 'reschedule' | 'update' | 'cancel' | 'removed';

/** Mails telling the recipient the event is no longer theirs: no join link, no app link. */
const isEndedKind = (kind: MailKind): boolean => kind === 'cancel' || kind === 'removed';

/** Plain-text alternative of the three mails (the join URL is spelled out). */
export function renderCalendarText(kind: MailKind, params: CalendarRescheduleParams): string {
  const { organizerName, eventTitle, eventDescription, startTime, endTime, location, eventUrl, timezone, allDay } = params;
  const verb = {
    invite: 'has invited you to an event',
    reschedule: 'has rescheduled an event',
    update: 'has updated an event',
    cancel: 'has cancelled an event',
    removed: 'removed you from an event',
  }[kind];
  const lines = [`${organizerName} ${verb}:`, '', eventTitle];
  if (kind === 'reschedule' && params.oldStartTime) {
    lines.push(`Was: ${formatWhen(params.oldStartTime, params.oldEndTime, timezone, allDay)}`);
  }
  if (startTime) lines.push(`When: ${formatWhen(startTime, endTime, timezone, allDay)}`);
  if (location) lines.push(`Where: ${location}`);
  if (!isEndedKind(kind) && eventDescription) lines.push('', eventDescription);
  if (!isEndedKind(kind) && params.meetingUrl) {
    lines.push('', `${joinLabel(params.meetingUrl)}: ${params.meetingUrl}`);
  }
  if (!isEndedKind(kind) && eventUrl) lines.push('', `View in WeldCalendar: ${eventUrl}`);
  return lines.join('\n');
}

// ── Resend transport (inline — see file header) ───────────────────────────

interface ResendPayload {
  from: string;
  to: string[];
  subject?: string;
  html?: string;
  text?: string;
  template?: { id: string; variables: Record<string, string> };
  attachments?: EmailAttachment[];
}

async function postToResend(apiKey: string, payload: ResendPayload): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// ── Send helpers ─────────────────────────────────────────────────────────

export interface AttendeeLike {
  email?: string | null;
  name?: string | null;
  status?: string | null;
  role?: string | null;
}

/** The event fields the mails need — accepts a DB row or a request body. */
export interface CalendarMailEvent {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Video-conference join link (WeldMeet or third-party). */
  meetingUrl?: string | null;
  /** The event's IANA zone; falls back to the organizer's, then UTC. */
  timezone?: string | null;
  allDay?: boolean | null;
}

/** Options of `sendCalendarEventEmails`. */
export interface SendOptions {
  kind: MailKind;
  event: CalendarMailEvent;
  attendees: AttendeeLike[];
  organizer: OrganizerInfo;
  /**
   * Floor for the ICS SEQUENCE. Reschedule and cancel mails are always sent
   * with at least `nextIcsSequence()` so they supersede earlier revisions.
   */
  sequence?: number;
  /** Reschedule mails render the previous slot struck through. */
  oldStartTime?: string | null;
  oldEndTime?: string | null;
  /**
   * Lower-cased emails of workspace members (see `getMemberEmails`). Only these
   * recipients get the link into the authenticated calendar; everyone else is
   * an external guest with no account. Omitted means nobody is a member.
   */
  memberEmails?: ReadonlySet<string>;
}

const SUBJECTS: Record<MailKind, (title: string) => string> = {
  invite: (t) => `Event invitation: ${t}`,
  reschedule: (t) => `Event rescheduled: ${t}`,
  update: (t) => `Event updated: ${t}`,
  cancel: (t) => `Event cancelled: ${t}`,
  removed: (t) => `You were removed from: ${t}`,
};

function templateIdFor(env: Env, kind: MailKind): string | undefined {
  const ids = templateIds(env);
  if (kind === 'invite') return ids.RESEND_MEETING_INVITE_TEMPLATE_ID;
  if (kind === 'reschedule' || kind === 'update') return ids.RESEND_MEETING_UPDATE_TEMPLATE_ID;
  // The Resend cancel template says "cancelled"; a removed guest gets the inline copy.
  if (kind === 'removed') return undefined;
  return ids.RESEND_MEETING_CANCEL_TEMPLATE_ID;
}

/** The zone the mail shows times in: the event's, else the organizer's, else UTC. */
export function mailTimeZone(event: CalendarMailEvent, organizer: OrganizerInfo): string {
  return (
    validTimeZoneOrUndefined(event.timezone) ??
    validTimeZoneOrUndefined(organizer.timezone) ??
    FALLBACK_TIME_ZONE
  );
}

function emailParams(opts: SendOptions, eventUrl: string | undefined): CalendarRescheduleParams {
  const { event, organizer } = opts;
  return {
    organizerName: organizer.name,
    eventTitle: event.title,
    eventDescription: event.description ?? undefined,
    startTime: event.startTime ?? undefined,
    endTime: event.endTime ?? undefined,
    location: event.location ?? undefined,
    eventUrl,
    meetingUrl: isEndedKind(opts.kind) ? undefined : event.meetingUrl?.trim() || undefined,
    timezone: mailTimeZone(event, organizer),
    allDay: event.allDay ?? undefined,
    oldStartTime: opts.oldStartTime ?? undefined,
    oldEndTime: opts.oldEndTime ?? undefined,
    updated: opts.kind === 'update',
  };
}

function renderHtml(opts: SendOptions, eventUrl: string | undefined): string {
  const params = emailParams(opts, eventUrl);
  if (opts.kind === 'invite') return renderCalendarInviteEmail(params);
  if (opts.kind === 'cancel') return renderCalendarCancelEmail(params);
  if (opts.kind === 'removed') return renderCalendarRemovedEmail(params);
  return renderCalendarRescheduleEmail(params);
}

function templateVariables(opts: SendOptions, eventUrl: string | undefined): Record<string, string> {
  const { kind, event, organizer } = opts;
  const vars: Record<string, string> = {
    ORGANIZER_NAME: organizer.name,
    MEETING_TITLE: event.title,
    MEETING_DESCRIPTION: event.description ?? '',
    SCHEDULED_START: event.startTime ?? '',
    SCHEDULED_END: event.endTime ?? '',
    TIMEZONE: mailTimeZone(event, organizer),
  };
  // The legacy cancel template did not carry a JOIN_URL. The join link is the
  // meeting when there is one; the app link only reaches workspace members.
  if (!isEndedKind(kind)) vars.JOIN_URL = event.meetingUrl?.trim() || eventUrl || '';
  if (kind === 'reschedule' || kind === 'update') {
    vars.OLD_SCHEDULED_START = opts.oldStartTime ?? '';
    vars.OLD_SCHEDULED_END = opts.oldEndTime ?? '';
  }
  return vars;
}

/**
 * Send one calendar mail per attendee.
 *
 * No-ops when RESEND_API_KEY is unset or there are no attendees — matching
 * the legacy `if (c.env.RESEND_API_KEY && attendees?.length)` guard. The
 * organizer is never mailed their own event. Each send is isolated: one bad
 * address does not stop the rest, and nothing here throws to the caller.
 */
export async function sendCalendarEventEmails(env: Env, opts: SendOptions): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !opts.attendees.length) return;

  const appUrl = eventUrlFor(env);
  const { kind, event, organizer } = opts;
  const method: IcsMethod = isEndedKind(kind) ? 'CANCEL' : 'REQUEST';
  const templateId = templateIdFor(env, kind);
  const meetingUrl = isEndedKind(kind) ? undefined : event.meetingUrl?.trim() || undefined;
  const zone = mailTimeZone(event, organizer);
  const sequence =
    kind === 'invite' ? (opts.sequence ?? 0) : Math.max(opts.sequence ?? 0, nextIcsSequence());

  for (const attendee of opts.attendees) {
    const email = attendee.email;
    // Skip blank addresses and the organizer's own inbox (legacy parity).
    if (!email) continue;
    if (organizer.email && email.toLowerCase() === organizer.email.toLowerCase()) continue;

    // External guests have no account: the authenticated calendar is a dead
    // end for them, so only members get that link.
    const isMember = opts.memberEmails?.has(email.toLowerCase()) ?? false;
    const eventUrl = !isEndedKind(kind) && isMember ? appUrl : undefined;

    try {
      const ics = icsAttachment({
        uid: `${event.id}@weldsuite.org`,
        title: event.title,
        description: event.description ?? undefined,
        location: event.location ?? undefined,
        startTime: event.startTime ?? undefined,
        endTime: event.endTime ?? undefined,
        organizerName: organizer.name,
        organizerEmail: organizer.email,
        attendeeEmail: email,
        method,
        sequence,
        url: meetingUrl ?? eventUrl,
        meetingUrl,
        allDay: event.allDay ?? undefined,
        timezone: zone,
      });

      await postToResend(apiKey, {
        from: FROM,
        to: [email],
        subject: SUBJECTS[kind](event.title),
        ...(templateId
          ? { template: { id: templateId, variables: templateVariables(opts, eventUrl) } }
          : {
              html: renderHtml(opts, eventUrl),
              text: renderCalendarText(kind, emailParams(opts, eventUrl)),
            }),
        attachments: [ics],
      });
    } catch (err) {
      console.error(`[calendar-api/calendar-mail] ${kind} email failed for ${email}:`, err);
    }
  }
}
