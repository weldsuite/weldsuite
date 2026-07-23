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

import type { Database } from '../db';
import { schema } from '../db';
import { eq } from 'drizzle-orm';
import type { Env } from '../types';

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

/** The calendar deep-link every mail links back to. */
function eventUrlFor(env: Env): string {
  return `${getPlatformUrl(env.ENVIRONMENT)}/weldcalendar`;
}

// ── Organizer lookup ─────────────────────────────────────────────────────

export interface OrganizerInfo {
  name: string;
  email: string;
}

/** Resolve the organizer's display name + email from the tenant member table. */
export async function getOrganizerInfo(
  db: Database,
  userId: string,
): Promise<OrganizerInfo> {
  const { workspaceMembers } = schema;
  const [organizer] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  return { name: organizer?.name ?? 'Someone', email: organizer?.email ?? '' };
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
}

interface EmailAttachment {
  filename: string;
  content: string;
  content_type?: string;
}

function formatIcsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
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
    url,
  } = params;

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
    `ORGANIZER;CN=${escapeIcsText(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${attendeeEmail}`,
  ];

  if (startTime) lines.push(`DTSTART:${formatIcsDate(startTime)}`);
  if (endTime) lines.push(`DTEND:${formatIcsDate(endTime)}`);
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (url) lines.push(`URL:${url}`);

  lines.push(method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.join('\r\n');
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
  eventUrl: string;
}

export interface CalendarRescheduleParams extends CalendarEmailParams {
  oldStartTime?: string;
  oldEndTime?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
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

function renderTimeSection(startTime?: string, endTime?: string): string {
  if (!startTime) return '';
  return `
    <tr>
      <td style="padding: 0 0 16px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right: 8px; vertical-align: top; color: #6b7280;">&#128197;</td>
            <td style="font-size: 15px; color: #374151; line-height: 1.5;">
              ${formatDateTime(startTime)}${endTime ? ` &ndash; ${formatTime(endTime)}` : ''}
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

function renderButton(label: string, url: string): string {
  return `
    <tr>
      <td style="padding: 8px 0 0 0;" align="center">
        <a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 32px; background-color: #3b82f6; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; line-height: 1;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>`;
}

export function renderCalendarInviteEmail(params: CalendarEmailParams): string {
  const { organizerName, eventTitle, eventDescription, startTime, endTime, location, eventUrl } = params;
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
      ${renderTimeSection(startTime, endTime)}
      ${renderLocationSection(location)}
      ${renderDescriptionSection(eventDescription)}
      ${renderButton('View Event', eventUrl)}
    </table>`;
  return wrapLayout('Event Invitation', body);
}

export function renderCalendarRescheduleEmail(params: CalendarRescheduleParams): string {
  const {
    organizerName, eventTitle, eventDescription, startTime, endTime,
    oldStartTime, oldEndTime, location, eventUrl,
  } = params;

  const oldTimeSection = oldStartTime
    ? `
      <tr>
        <td style="padding: 0 0 8px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-size: 14px; color: #9ca3af; line-height: 1.5; text-decoration: line-through;">
                ${formatDateTime(oldStartTime)}${oldEndTime ? ` &ndash; ${formatTime(oldEndTime)}` : ''}
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
            <strong>${escapeHtml(organizerName)}</strong> has rescheduled an event:
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
      ${renderTimeSection(startTime, endTime)}
      ${renderLocationSection(location)}
      ${renderDescriptionSection(eventDescription)}
      ${renderButton('View Event', eventUrl)}
    </table>`;
  return wrapLayout('Event Rescheduled', body);
}

export function renderCalendarCancelEmail(params: CalendarEmailParams): string {
  const { organizerName, eventTitle, startTime, endTime, location } = params;
  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="padding: 0 0 20px 0;">
          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.6;">
            <strong>${escapeHtml(organizerName)}</strong> has cancelled an event:
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding: 16px 20px; background-color: #f9fafb; border-radius: 8px; border-left: 4px solid #ef4444; margin-bottom: 16px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #111827; text-decoration: line-through;">${escapeHtml(eventTitle)}</h2>
        </td>
      </tr>
      <tr><td style="height: 16px;"></td></tr>
      ${renderTimeSection(startTime, endTime)}
      ${renderLocationSection(location)}
    </table>`;
  return wrapLayout('Event Cancelled', body);
}

// ── Resend transport (inline — see file header) ───────────────────────────

interface ResendPayload {
  from: string;
  to: string[];
  subject?: string;
  html?: string;
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
}

type MailKind = 'invite' | 'reschedule' | 'cancel';

interface SendOptions {
  kind: MailKind;
  event: CalendarMailEvent;
  attendees: AttendeeLike[];
  organizer: OrganizerInfo;
  sequence?: number;
  /** Reschedule mails render the previous slot struck through. */
  oldStartTime?: string | null;
  oldEndTime?: string | null;
}

const SUBJECTS: Record<MailKind, (title: string) => string> = {
  invite: (t) => `Event invitation: ${t}`,
  reschedule: (t) => `Event rescheduled: ${t}`,
  cancel: (t) => `Event cancelled: ${t}`,
};

function templateIdFor(env: Env, kind: MailKind): string | undefined {
  const ids = templateIds(env);
  if (kind === 'invite') return ids.RESEND_MEETING_INVITE_TEMPLATE_ID;
  if (kind === 'reschedule') return ids.RESEND_MEETING_UPDATE_TEMPLATE_ID;
  return ids.RESEND_MEETING_CANCEL_TEMPLATE_ID;
}

function renderHtml(kind: MailKind, opts: SendOptions, url: string): string {
  const { event, organizer } = opts;
  const base: CalendarEmailParams = {
    organizerName: organizer.name,
    eventTitle: event.title,
    eventDescription: event.description ?? undefined,
    startTime: event.startTime ?? undefined,
    endTime: event.endTime ?? undefined,
    location: event.location ?? undefined,
    eventUrl: url,
  };
  if (kind === 'invite') return renderCalendarInviteEmail(base);
  if (kind === 'cancel') return renderCalendarCancelEmail(base);
  return renderCalendarRescheduleEmail({
    ...base,
    oldStartTime: opts.oldStartTime ?? undefined,
    oldEndTime: opts.oldEndTime ?? undefined,
  });
}

function templateVariables(kind: MailKind, opts: SendOptions, url: string): Record<string, string> {
  const { event, organizer } = opts;
  const vars: Record<string, string> = {
    ORGANIZER_NAME: organizer.name,
    MEETING_TITLE: event.title,
    MEETING_DESCRIPTION: event.description ?? '',
    SCHEDULED_START: event.startTime ?? '',
    SCHEDULED_END: event.endTime ?? '',
  };
  // The legacy cancel template did not carry a JOIN_URL.
  if (kind !== 'cancel') vars.JOIN_URL = url;
  if (kind === 'reschedule') {
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

  const url = eventUrlFor(env);
  const { kind, event, organizer } = opts;
  const method: IcsMethod = kind === 'cancel' ? 'CANCEL' : 'REQUEST';
  const templateId = templateIdFor(env, kind);

  for (const attendee of opts.attendees) {
    const email = attendee.email;
    // Skip blank addresses and the organizer's own inbox (legacy parity).
    if (!email) continue;
    if (organizer.email && email.toLowerCase() === organizer.email.toLowerCase()) continue;

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
      sequence: opts.sequence,
      url: kind === 'cancel' ? undefined : url,
    });

    try {
      await postToResend(apiKey, {
        from: FROM,
        to: [email],
        subject: SUBJECTS[kind](event.title),
        ...(templateId
          ? { template: { id: templateId, variables: templateVariables(kind, opts, url) } }
          : { html: renderHtml(kind, opts, url) }),
        attachments: [ics],
      });
    } catch (err) {
      console.error(`[app-api/calendar-mail] ${kind} email failed for ${email}:`, err);
    }
  }
}
