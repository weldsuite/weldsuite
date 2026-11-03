/**
 * personal-api (consumer WeldMail and WeldCalendar on a personal account).
 * The Rust server serves it under `/personal-api` (`createPersonalTestApp`'s
 * `rustBasePath`), so the schemas are keyed by the prefixed route and never
 * meet app-api's or calendar-api's routes of the same path. Spread into
 * ROUTES by conformance-schemas.ts.
 */
import {
  personalAccountSchema,
  personalBookingPageSchema,
  personalBookingPageToggledSchema,
  personalBookingSchema,
  personalCalendarEventSchema,
  personalCalendarEventUpdatedSchema,
  personalCalendarSchema,
  personalCancelledSchema,
  personalHealthSchema,
  personalIdSchema,
  personalMailAccountSchema,
  personalMailAttachmentSchema,
  personalMailDraftSchema,
  personalMailLabelSchema,
  personalMailMessageSchema,
  personalMailSubscriptionSchema,
  personalMeSchema,
  personalPushTokenRegisteredSchema,
  personalPushTokenUnregisteredSchema,
  personalScanResultSchema,
  personalSentMessageSchema,
  personalTimeSlotSchema,
  personalUnreadCountSchema,
  personalUnsubscribeResultSchema,
} from '@weldsuite/app-api-client/schemas/personal-responses';
import type { RouteSchema } from './conformance-schemas';

const P = '/personal-api';

export const PERSONAL_ROUTES: RouteSchema[] = [
  { method: 'GET', route: `${P}/health`, envelope: 'body', data: personalHealthSchema },
  { method: 'POST', route: `${P}/api/onboard`, envelope: 'single', data: personalAccountSchema },
  { method: 'GET', route: `${P}/api/me`, envelope: 'single', data: personalMeSchema },
  { method: 'POST', route: `${P}/api/push-tokens`, envelope: 'single', data: personalPushTokenRegisteredSchema },
  { method: 'DELETE', route: `${P}/api/push-tokens`, envelope: 'single', data: personalPushTokenUnregisteredSchema },
  // calendars
  { method: 'GET', route: `${P}/api/calendars`, envelope: 'list', data: personalCalendarSchema },
  { method: 'POST', route: `${P}/api/calendars`, envelope: 'single', data: personalIdSchema },
  { method: 'POST', route: `${P}/api/calendars/ensure-default`, envelope: 'single', data: personalCalendarSchema },
  { method: 'GET', route: `${P}/api/calendars/:id`, envelope: 'single', data: personalCalendarSchema },
  { method: 'PATCH', route: `${P}/api/calendars/:id`, envelope: 'single', data: personalIdSchema },
  // calendar events
  { method: 'GET', route: `${P}/api/calendar-events`, envelope: 'list', data: personalCalendarEventSchema },
  { method: 'POST', route: `${P}/api/calendar-events`, envelope: 'single', data: personalIdSchema },
  { method: 'GET', route: `${P}/api/calendar-events/range`, envelope: 'array', data: personalCalendarEventSchema },
  { method: 'GET', route: `${P}/api/calendar-events/:id`, envelope: 'single', data: personalCalendarEventSchema },
  { method: 'PATCH', route: `${P}/api/calendar-events/:id`, envelope: 'single', data: personalCalendarEventUpdatedSchema },
  { method: 'PATCH', route: `${P}/api/calendar-events/:id/cancel`, envelope: 'single', data: personalCancelledSchema },
  // booking pages and bookings
  { method: 'GET', route: `${P}/api/booking-pages`, envelope: 'list', data: personalBookingPageSchema },
  { method: 'POST', route: `${P}/api/booking-pages`, envelope: 'single', data: personalIdSchema },
  { method: 'GET', route: `${P}/api/booking-pages/:id/available-slots`, envelope: 'array', data: personalTimeSlotSchema },
  { method: 'PATCH', route: `${P}/api/booking-pages/:id/toggle`, envelope: 'single', data: personalBookingPageToggledSchema },
  { method: 'GET', route: `${P}/api/booking-pages/:id`, envelope: 'single', data: personalBookingPageSchema },
  { method: 'PATCH', route: `${P}/api/booking-pages/:id`, envelope: 'single', data: personalIdSchema },
  { method: 'GET', route: `${P}/api/bookings`, envelope: 'list', data: personalBookingSchema },
  { method: 'GET', route: `${P}/api/bookings/:id`, envelope: 'single', data: personalBookingSchema },
  { method: 'PATCH', route: `${P}/api/bookings/:id/cancel`, envelope: 'single', data: personalCancelledSchema },
  // mailboxes
  { method: 'GET', route: `${P}/api/mail/accounts`, envelope: 'array', data: personalMailAccountSchema },
  { method: 'GET', route: `${P}/api/mail/accounts/:id`, envelope: 'single', data: personalMailAccountSchema },
  { method: 'GET', route: `${P}/api/mail/labels`, envelope: 'array', data: personalMailLabelSchema },
  { method: 'GET', route: `${P}/api/mail/drafts`, envelope: 'list', data: personalMailDraftSchema },
  { method: 'POST', route: `${P}/api/mail/drafts`, envelope: 'single', data: personalMailDraftSchema },
  { method: 'PATCH', route: `${P}/api/mail/drafts/:id`, envelope: 'single', data: personalMailDraftSchema },
  // messages
  { method: 'GET', route: `${P}/api/mail/messages`, envelope: 'list', data: personalMailMessageSchema },
  { method: 'GET', route: `${P}/api/mail/messages/unread-count`, envelope: 'single', data: personalUnreadCountSchema },
  { method: 'POST', route: `${P}/api/mail/messages/send`, envelope: 'single', data: personalSentMessageSchema },
  { method: 'POST', route: `${P}/api/mail/messages/:id/reply`, envelope: 'single', data: personalSentMessageSchema },
  { method: 'POST', route: `${P}/api/mail/messages/:id/forward`, envelope: 'single', data: personalSentMessageSchema },
  { method: 'GET', route: `${P}/api/mail/messages/:id/attachments`, envelope: 'array', data: personalMailAttachmentSchema },
  { method: 'GET', route: `${P}/api/mail/messages/:id`, envelope: 'single', data: personalMailMessageSchema },
  { method: 'PATCH', route: `${P}/api/mail/messages/:id`, envelope: 'single', data: personalMailMessageSchema },
  // subscriptions
  { method: 'GET', route: `${P}/api/mail/subscriptions`, envelope: 'array', data: personalMailSubscriptionSchema },
  { method: 'POST', route: `${P}/api/mail/subscriptions/scan`, envelope: 'single', data: personalScanResultSchema },
  { method: 'POST', route: `${P}/api/mail/subscriptions/:id/unsubscribe`, envelope: 'single', data: personalUnsubscribeResultSchema },
];
