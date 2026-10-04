/**
 * Booking-portal transactional emails (confirmation + guest invite).
 *
 * Wraps `@weldsuite/transactional-email` with booking-specific HTML/text/subject.
 * Throws on send failure — callers decide whether the booking still succeeds.
 */

import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { sendEmail, type EmailAttachment } from '@weldsuite/transactional-email';

import { BOOKING_FROM_ADDRESS } from './constants';
import { isHttpUrl, joinUrlOf, type LocationFields } from './location';

interface BookingEmailParams {
  bookerName: string;
  bookerEmail: string;
  bookingPageName: string;
  startTime: string;
  endTime: string;
  locationType: string | null;
  locationValue: string | null;
  /** The WeldMeet join link of the booking; wins over `locationValue` for video. */
  meetingUrl?: string | null;
  workspaceName: string;
  confirmationMessage: string | null;
  timezone?: string | null;
  ics?: string;
  /** The member who owns the booking page. Shown instead of the bare workspace name. */
  hostName?: string | null;
  /** Replies from the guest go to the host. */
  hostEmail?: string | null;
  /** Signed links into the portal's reschedule / cancel flow. */
  rescheduleUrl?: string | null;
  cancelUrl?: string | null;
}

interface GuestInviteParams {
  guestEmail: string;
  bookerName: string;
  bookingPageName: string;
  startTime: string;
  endTime: string;
  locationType: string | null;
  locationValue: string | null;
  meetingUrl?: string | null;
  workspaceName: string;
  timezone?: string | null;
  ics?: string;
  hostName?: string | null;
  hostEmail?: string | null;
}

class MissingResendApiKeyError extends Error {
  constructor() {
    super('RESEND_API_KEY not configured');
    this.name = 'MissingResendApiKeyError';
  }
}

function getApiKey(): string {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new MissingResendApiKeyError();
  return apiKey;
}

function icsAttachment(ics: string, method: 'REQUEST' | 'CANCEL' = 'REQUEST'): EmailAttachment {
  return {
    filename: 'invite.ics',
    content: Buffer.from(ics, 'utf-8').toString('base64'),
    content_type: `text/calendar; method=${method}; charset=UTF-8; name=invite.ics`,
  };
}

function formatDateTime(startIso: string, endIso: string, tz?: string | null) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (tz) {
    return {
      dateStr: formatInTimeZone(start, tz, 'EEEE, MMMM d, yyyy'),
      timeStr: `${formatInTimeZone(start, tz, 'h:mm a')} – ${formatInTimeZone(end, tz, 'h:mm a zzz')}`,
    };
  }
  return {
    dateStr: format(start, 'EEEE, MMMM d, yyyy'),
    timeStr: `${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}`,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "Jane Doe (Acme)" when the host is a person, otherwise just the workspace name. */
function hostLabel(hostName: string | null | undefined, workspaceName: string): string {
  const host = hostName?.trim();
  return host && host !== workspaceName ? `${host} (${workspaceName})` : workspaceName;
}

function hostLabelHtml(hostName: string | null | undefined, workspaceName: string): string {
  const host = hostName?.trim();
  if (!host || host === workspaceName) return `<strong>${escapeHtml(workspaceName)}</strong>`;
  return `<strong>${escapeHtml(host)}</strong> (${escapeHtml(workspaceName)})`;
}

/** RFC 5322 display name: quoted, with characters that would break the header removed. */
function fromHeader(hostName: string | null | undefined, workspaceName: string): string {
  const host = hostName?.trim();
  const label = host && host !== workspaceName ? `${host} via ${workspaceName}` : workspaceName;
  return `"${label.replace(/["\\<>\r\n]/g, '')}" <${BOOKING_FROM_ADDRESS}>`;
}

function replyToField(email: string | null | undefined): { reply_to: string } | Record<string, never> {
  const trimmed = email?.trim();
  return trimmed ? { reply_to: trimmed } : {};
}

function hostLineHtml(hostName: string | null | undefined, workspaceName: string): string {
  return `<p style="margin:0 0 4px"><strong>Host:</strong> ${escapeHtml(hostLabel(hostName, workspaceName))}</p>`;
}

/** Footer of the confirmation / reschedule mail: signed links, or a contact fallback. */
function manageFooterHtml(params: BookingEmailParams, fallbackIntro: string): string {
  const style = 'margin:0;color:#6b7280;font-size:13px';
  if (params.rescheduleUrl && params.cancelUrl) {
    const link = 'color:#111827;font-weight:600';
    return `<p style="${style}">${escapeHtml(fallbackIntro)} <a href="${escapeHtml(params.rescheduleUrl)}" style="${link}">Reschedule</a> or <a href="${escapeHtml(params.cancelUrl)}" style="${link}">Cancel</a> this meeting, or reply to this email to reach ${escapeHtml(params.hostName?.trim() || params.workspaceName)}.</p>`;
  }
  return `<p style="${style}">${escapeHtml(fallbackIntro)} Reply to this email or contact ${escapeHtml(params.hostName?.trim() || params.workspaceName)} directly.</p>`;
}

function manageFooterText(params: BookingEmailParams, fallbackIntro: string): string[] {
  const who = params.hostName?.trim() || params.workspaceName;
  if (params.rescheduleUrl && params.cancelUrl) {
    return [
      fallbackIntro,
      `Reschedule: ${params.rescheduleUrl}`,
      `Cancel: ${params.cancelUrl}`,
      `Or reply to this email to reach ${who}.`,
    ];
  }
  return [`${fallbackIntro} Reply to this email or contact ${who} directly.`];
}

function locationHtml(fields: LocationFields): string {
  const row = (label: string, inner: string) =>
    `<p style="margin:0 0 4px"><strong>${label}:</strong> ${inner}</p>`;

  if (fields.locationType === 'video') {
    const joinUrl = joinUrlOf(fields);
    if (!joinUrl) return row('Location', 'Video call');
    if (!isHttpUrl(joinUrl)) return row('Location', escapeHtml(joinUrl));
    const href = escapeHtml(joinUrl);
    return [
      row('Location', `<a href="${href}">Join video call</a>`),
      `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;word-break:break-all">${href}</p>`,
    ].join('\n        ');
  }
  const value = fields.locationValue?.trim();
  if (!value) return '';
  if (fields.locationType === 'phone') return row('Phone', escapeHtml(value));
  if (fields.locationType === 'in-person') return row('Location', escapeHtml(value));
  return '';
}

function locationText(fields: LocationFields): string {
  if (fields.locationType === 'video') {
    const joinUrl = joinUrlOf(fields);
    return joinUrl ? `Join video call: ${joinUrl}` : 'Location: Video call';
  }
  const value = fields.locationValue?.trim();
  if (!value) return '';
  if (fields.locationType === 'phone') return `Phone: ${value}`;
  return `Location: ${value}`;
}

export async function sendBookingConfirmationEmail(params: BookingEmailParams): Promise<void> {
  const apiKey = getApiKey();
  const { dateStr, timeStr } = formatDateTime(params.startTime, params.endTime, params.timezone);
  const customMessage = params.confirmationMessage
    ? `<p style="margin:16px 0;color:#374151">${escapeHtml(params.confirmationMessage)}</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f9fafb">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#111827;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600">Booking Confirmed</h1>
    </div>
    <div style="padding:32px">
      <p style="margin:0 0 16px;color:#374151">Hi ${escapeHtml(params.bookerName)},</p>
      <p style="margin:0 0 24px;color:#374151">Your meeting has been confirmed with ${hostLabelHtml(params.hostName, params.workspaceName)}.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(params.bookingPageName)}</p>
        ${hostLineHtml(params.hostName, params.workspaceName)}
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
        ${locationHtml(params)}
      </div>

      ${customMessage}

      ${manageFooterHtml(params, 'If you need to make changes, you can')}
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `Booking Confirmed`,
    ``,
    `Hi ${params.bookerName},`,
    ``,
    `Your meeting has been confirmed with ${hostLabel(params.hostName, params.workspaceName)}.`,
    ``,
    `${params.bookingPageName}`,
    `Host: ${hostLabel(params.hostName, params.workspaceName)}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    locationText(params),
    params.confirmationMessage ? `\n${params.confirmationMessage}` : '',
    ``,
    ...manageFooterText(params, 'If you need to make changes:'),
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: fromHeader(params.hostName, params.workspaceName),
    to: [params.bookerEmail],
    ...replyToField(params.hostEmail),
    subject: `Booking Confirmed: ${params.bookingPageName} — ${dateStr}`,
    html,
    text,
    ...(params.ics ? { attachments: [icsAttachment(params.ics)] } : {}),
  });
}

export async function sendBookingRescheduledEmail(params: BookingEmailParams): Promise<void> {
  const apiKey = getApiKey();
  const { dateStr, timeStr } = formatDateTime(params.startTime, params.endTime, params.timezone);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f9fafb">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#111827;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600">Booking Rescheduled</h1>
    </div>
    <div style="padding:32px">
      <p style="margin:0 0 16px;color:#374151">Hi ${escapeHtml(params.bookerName)},</p>
      <p style="margin:0 0 24px;color:#374151">Your meeting with ${hostLabelHtml(params.hostName, params.workspaceName)} has been moved to a new time.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(params.bookingPageName)}</p>
        ${hostLineHtml(params.hostName, params.workspaceName)}
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
        ${locationHtml(params)}
      </div>

      ${manageFooterHtml(params, 'The updated invitation is attached. If you need to make further changes, you can')}
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `Booking Rescheduled`,
    ``,
    `Hi ${params.bookerName},`,
    ``,
    `Your meeting with ${hostLabel(params.hostName, params.workspaceName)} has been moved to a new time.`,
    ``,
    `${params.bookingPageName}`,
    `Host: ${hostLabel(params.hostName, params.workspaceName)}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    locationText(params),
    ``,
    ...manageFooterText(params, 'The updated invitation is attached. If you need to make further changes:'),
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: fromHeader(params.hostName, params.workspaceName),
    to: [params.bookerEmail],
    ...replyToField(params.hostEmail),
    subject: `Booking Rescheduled: ${params.bookingPageName} — ${dateStr}`,
    html,
    text,
    ...(params.ics ? { attachments: [icsAttachment(params.ics)] } : {}),
  });
}

export async function sendBookingCancellationEmail(params: BookingEmailParams): Promise<void> {
  const apiKey = getApiKey();
  const { dateStr, timeStr } = formatDateTime(params.startTime, params.endTime, params.timezone);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f9fafb">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#111827;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600">Booking Cancelled</h1>
    </div>
    <div style="padding:32px">
      <p style="margin:0 0 16px;color:#374151">Hi ${escapeHtml(params.bookerName)},</p>
      <p style="margin:0 0 24px;color:#374151">Your meeting with ${hostLabelHtml(params.hostName, params.workspaceName)} has been cancelled.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827;text-decoration:line-through">${escapeHtml(params.bookingPageName)}</p>
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
      </div>

      <p style="margin:0;color:#6b7280;font-size:13px">If this was a mistake or you'd like to rebook, reply to this email or contact ${escapeHtml(params.hostName?.trim() || params.workspaceName)} directly.</p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `Booking Cancelled`,
    ``,
    `Hi ${params.bookerName},`,
    ``,
    `Your meeting with ${hostLabel(params.hostName, params.workspaceName)} has been cancelled.`,
    ``,
    `${params.bookingPageName}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    ``,
    `If this was a mistake or you'd like to rebook, reply to this email or contact ${params.hostName?.trim() || params.workspaceName} directly.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: fromHeader(params.hostName, params.workspaceName),
    to: [params.bookerEmail],
    ...replyToField(params.hostEmail),
    subject: `Booking Cancelled: ${params.bookingPageName} — ${dateStr}`,
    html,
    text,
    ...(params.ics ? { attachments: [icsAttachment(params.ics, 'CANCEL')] } : {}),
  });
}

export async function sendGuestInviteEmail(params: GuestInviteParams): Promise<void> {
  const apiKey = getApiKey();
  const { dateStr, timeStr } = formatDateTime(params.startTime, params.endTime, params.timezone);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#f9fafb">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#111827;padding:24px 32px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:600">You're Invited</h1>
    </div>
    <div style="padding:32px">
      <p style="margin:0 0 16px;color:#374151">Hi,</p>
      <p style="margin:0 0 24px;color:#374151"><strong>${escapeHtml(params.bookerName)}</strong> has added you as a guest to a meeting with ${hostLabelHtml(params.hostName, params.workspaceName)}.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(params.bookingPageName)}</p>
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
        ${locationHtml(params)}
      </div>

      <p style="margin:0;color:#6b7280;font-size:13px">This is an automated invitation. If you have questions, contact ${escapeHtml(params.bookerName)} or ${escapeHtml(params.hostName?.trim() || params.workspaceName)} directly.</p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `You're Invited`,
    ``,
    `${params.bookerName} has added you as a guest to a meeting with ${hostLabel(params.hostName, params.workspaceName)}.`,
    ``,
    `${params.bookingPageName}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    locationText(params),
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: fromHeader(params.hostName, params.workspaceName),
    to: [params.guestEmail],
    ...replyToField(params.hostEmail),
    subject: `Invitation: ${params.bookingPageName} — ${dateStr}`,
    html,
    text,
    ...(params.ics ? { attachments: [icsAttachment(params.ics)] } : {}),
  });
}
