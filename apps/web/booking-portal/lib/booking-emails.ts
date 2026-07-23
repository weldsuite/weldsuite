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

interface BookingEmailParams {
  bookerName: string;
  bookerEmail: string;
  bookingPageName: string;
  startTime: string;
  endTime: string;
  locationType: string | null;
  locationValue: string | null;
  workspaceName: string;
  confirmationMessage: string | null;
  timezone?: string | null;
  ics?: string;
}

interface GuestInviteParams {
  guestEmail: string;
  bookerName: string;
  bookingPageName: string;
  startTime: string;
  endTime: string;
  locationType: string | null;
  locationValue: string | null;
  workspaceName: string;
  timezone?: string | null;
  ics?: string;
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

function locationHtml(locationType: string | null, locationValue: string | null): string {
  if (!locationValue) return '';
  if (locationType === 'video') {
    return `<p style="margin:0 0 4px"><strong>Location:</strong> <a href="${escapeHtml(locationValue)}">Join Video Call</a></p>`;
  }
  if (locationType === 'phone') {
    return `<p style="margin:0 0 4px"><strong>Phone:</strong> ${escapeHtml(locationValue)}</p>`;
  }
  if (locationType === 'in-person') {
    return `<p style="margin:0 0 4px"><strong>Location:</strong> ${escapeHtml(locationValue)}</p>`;
  }
  return '';
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
      <p style="margin:0 0 24px;color:#374151">Your meeting has been confirmed with <strong>${escapeHtml(params.workspaceName)}</strong>.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(params.bookingPageName)}</p>
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
        ${locationHtml(params.locationType, params.locationValue)}
      </div>

      ${customMessage}

      <p style="margin:0;color:#6b7280;font-size:13px">If you need to make changes, please contact ${escapeHtml(params.workspaceName)} directly.</p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `Booking Confirmed`,
    ``,
    `Hi ${params.bookerName},`,
    ``,
    `Your meeting has been confirmed with ${params.workspaceName}.`,
    ``,
    `${params.bookingPageName}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    params.locationValue ? `Location: ${params.locationValue}` : '',
    params.confirmationMessage ? `\n${params.confirmationMessage}` : '',
    ``,
    `If you need to make changes, please contact ${params.workspaceName} directly.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: `${params.workspaceName} <${BOOKING_FROM_ADDRESS}>`,
    to: [params.bookerEmail],
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
      <p style="margin:0 0 24px;color:#374151">Your meeting with <strong>${escapeHtml(params.workspaceName)}</strong> has been moved to a new time.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(params.bookingPageName)}</p>
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
        ${locationHtml(params.locationType, params.locationValue)}
      </div>

      <p style="margin:0;color:#6b7280;font-size:13px">The updated invitation is attached. If you need to make further changes, please contact ${escapeHtml(params.workspaceName)} directly.</p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `Booking Rescheduled`,
    ``,
    `Hi ${params.bookerName},`,
    ``,
    `Your meeting with ${params.workspaceName} has been moved to a new time.`,
    ``,
    `${params.bookingPageName}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    params.locationValue ? `Location: ${params.locationValue}` : '',
    ``,
    `If you need to make further changes, please contact ${params.workspaceName} directly.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: `${params.workspaceName} <${BOOKING_FROM_ADDRESS}>`,
    to: [params.bookerEmail],
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
      <p style="margin:0 0 24px;color:#374151">Your meeting with <strong>${escapeHtml(params.workspaceName)}</strong> has been cancelled.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827;text-decoration:line-through">${escapeHtml(params.bookingPageName)}</p>
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
      </div>

      <p style="margin:0;color:#6b7280;font-size:13px">If this was a mistake or you'd like to rebook, please contact ${escapeHtml(params.workspaceName)} directly.</p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `Booking Cancelled`,
    ``,
    `Hi ${params.bookerName},`,
    ``,
    `Your meeting with ${params.workspaceName} has been cancelled.`,
    ``,
    `${params.bookingPageName}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    ``,
    `If this was a mistake or you'd like to rebook, please contact ${params.workspaceName} directly.`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: `${params.workspaceName} <${BOOKING_FROM_ADDRESS}>`,
    to: [params.bookerEmail],
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
      <p style="margin:0 0 24px;color:#374151"><strong>${escapeHtml(params.bookerName)}</strong> has added you as a guest to a meeting with <strong>${escapeHtml(params.workspaceName)}</strong>.</p>

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px">
        <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(params.bookingPageName)}</p>
        <p style="margin:0 0 4px"><strong>Date:</strong> ${dateStr}</p>
        <p style="margin:0 0 4px"><strong>Time:</strong> ${timeStr}</p>
        ${locationHtml(params.locationType, params.locationValue)}
      </div>

      <p style="margin:0;color:#6b7280;font-size:13px">This is an automated invitation. If you have questions, contact ${escapeHtml(params.bookerName)} or ${escapeHtml(params.workspaceName)} directly.</p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = [
    `You're Invited`,
    ``,
    `${params.bookerName} has added you as a guest to a meeting with ${params.workspaceName}.`,
    ``,
    `${params.bookingPageName}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    params.locationValue ? `Location: ${params.locationValue}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail(apiKey, {
    from: `${params.workspaceName} <${BOOKING_FROM_ADDRESS}>`,
    to: [params.guestEmail],
    subject: `Invitation: ${params.bookingPageName} — ${dateStr}`,
    html,
    text,
    ...(params.ics ? { attachments: [icsAttachment(params.ics)] } : {}),
  });
}
