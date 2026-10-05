/**
 * Booking-portal transactional emails (confirmation, reschedule, cancellation,
 * guest invite).
 *
 * Thin wrapper over `@weldsuite/emails`'s shared `booking` template: builds the
 * recipient-facing props, resolves a transport from env vars (Cloudflare Email
 * Service, falling back to Resend during the migration), and attaches the
 * caller's pre-built `.ics` event. The caller always carries the workspace's
 * own brand — this mail goes to people outside the workspace.
 *
 * Throws on send failure — callers decide whether the booking still succeeds.
 */

import {
  sendSystemEmail,
  icsAttachment,
  type BookingLocation,
  type EmailBrand,
  type EmailLocale,
  type IcsEvent,
} from '@weldsuite/emails';
import { transportFromEnv } from '@weldsuite/emails/transports/env';

import { joinUrlOf, type LocationFields } from './location';

export class MissingEmailTransportError extends Error {
  constructor() {
    super(
      'No email transport configured: set CF_ACCOUNT_ID + CF_EMAIL_SEND_TOKEN (Cloudflare Email Service), or RESEND_API_KEY as a fallback.',
    );
    this.name = 'MissingEmailTransportError';
  }
}

function requireTransport() {
  const transport = transportFromEnv(process.env);
  if (!transport) throw new MissingEmailTransportError();
  return transport;
}

/**
 * "Jane Doe via Acme" when the host is a person, otherwise just the workspace
 * name — the From display name. (The template shows "Jane Doe (Acme)" inline;
 * this is deliberately different, matching the mailbox convention instead.)
 */
function fromDisplayName(hostName: string | null | undefined, workspaceName: string): string {
  const host = hostName?.trim();
  return host && host !== workspaceName ? `${host} via ${workspaceName}` : workspaceName;
}

/** Maps the portal's raw location columns onto the template's `BookingLocation` union. */
function templateLocation(fields: LocationFields): BookingLocation | null {
  if (fields.locationType === 'video') {
    return { type: 'video', joinUrl: joinUrlOf(fields) };
  }
  const value = fields.locationValue?.trim();
  if (!value) return null;
  if (fields.locationType === 'phone') return { type: 'phone', value };
  if (fields.locationType === 'in-person') return { type: 'in-person', value };
  return null;
}

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
  /** The invite/cancellation event to attach as `invite.ics`; omitted when there's nothing to send. */
  icsEvent?: IcsEvent | null;
  /** The member who owns the booking page. Shown instead of the bare workspace name. */
  hostName?: string | null;
  /** Replies from the guest go to the host. */
  hostEmail?: string | null;
  /** Signed links into the portal's reschedule / cancel flow. */
  rescheduleUrl?: string | null;
  cancelUrl?: string | null;
  /** The workspace's own brand (logo, accent color) — external recipients never see the WeldSuite brand. */
  brand: EmailBrand;
  /** Recipient's language. Defaults to English. */
  locale?: EmailLocale;
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
  icsEvent?: IcsEvent | null;
  hostName?: string | null;
  hostEmail?: string | null;
  brand: EmailBrand;
  locale?: EmailLocale;
}

export async function sendBookingConfirmationEmail(params: BookingEmailParams): Promise<void> {
  const transport = requireTransport();
  await sendSystemEmail(transport, {
    template: 'booking',
    props: {
      kind: 'confirmed',
      bookerName: params.bookerName,
      bookingPageName: params.bookingPageName,
      workspaceName: params.workspaceName,
      hostName: params.hostName,
      startTime: params.startTime,
      endTime: params.endTime,
      timezone: params.timezone,
      location: templateLocation(params),
      confirmationMessage: params.confirmationMessage,
      rescheduleUrl: params.rescheduleUrl,
      cancelUrl: params.cancelUrl,
    },
    to: params.bookerEmail,
    locale: params.locale ?? 'en',
    brand: params.brand,
    fromName: fromDisplayName(params.hostName, params.workspaceName),
    ...(params.hostEmail?.trim() ? { replyTo: params.hostEmail.trim() } : {}),
    ...(params.icsEvent ? { attachments: [icsAttachment(params.icsEvent)] } : {}),
  });
}

export async function sendBookingRescheduledEmail(params: BookingEmailParams): Promise<void> {
  const transport = requireTransport();
  await sendSystemEmail(transport, {
    template: 'booking',
    props: {
      kind: 'rescheduled',
      bookerName: params.bookerName,
      bookingPageName: params.bookingPageName,
      workspaceName: params.workspaceName,
      hostName: params.hostName,
      startTime: params.startTime,
      endTime: params.endTime,
      timezone: params.timezone,
      location: templateLocation(params),
      rescheduleUrl: params.rescheduleUrl,
      cancelUrl: params.cancelUrl,
    },
    to: params.bookerEmail,
    locale: params.locale ?? 'en',
    brand: params.brand,
    fromName: fromDisplayName(params.hostName, params.workspaceName),
    ...(params.hostEmail?.trim() ? { replyTo: params.hostEmail.trim() } : {}),
    ...(params.icsEvent ? { attachments: [icsAttachment(params.icsEvent)] } : {}),
  });
}

export async function sendBookingCancellationEmail(params: BookingEmailParams): Promise<void> {
  const transport = requireTransport();
  await sendSystemEmail(transport, {
    template: 'booking',
    props: {
      kind: 'cancelled',
      bookerName: params.bookerName,
      bookingPageName: params.bookingPageName,
      workspaceName: params.workspaceName,
      hostName: params.hostName,
      startTime: params.startTime,
      endTime: params.endTime,
      timezone: params.timezone,
    },
    to: params.bookerEmail,
    locale: params.locale ?? 'en',
    brand: params.brand,
    fromName: fromDisplayName(params.hostName, params.workspaceName),
    ...(params.hostEmail?.trim() ? { replyTo: params.hostEmail.trim() } : {}),
    ...(params.icsEvent ? { attachments: [icsAttachment(params.icsEvent)] } : {}),
  });
}

export async function sendGuestInviteEmail(params: GuestInviteParams): Promise<void> {
  const transport = requireTransport();
  await sendSystemEmail(transport, {
    template: 'booking',
    props: {
      kind: 'guest',
      bookerName: params.bookerName,
      bookingPageName: params.bookingPageName,
      workspaceName: params.workspaceName,
      hostName: params.hostName,
      startTime: params.startTime,
      endTime: params.endTime,
      timezone: params.timezone,
      location: templateLocation(params),
    },
    to: params.guestEmail,
    locale: params.locale ?? 'en',
    brand: params.brand,
    fromName: fromDisplayName(params.hostName, params.workspaceName),
    ...(params.hostEmail?.trim() ? { replyTo: params.hostEmail.trim() } : {}),
    ...(params.icsEvent ? { attachments: [icsAttachment(params.icsEvent)] } : {}),
  });
}
