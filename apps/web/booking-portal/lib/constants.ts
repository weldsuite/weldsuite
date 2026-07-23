/**
 * Booking-portal-wide constants. Replaces magic literals scattered through
 * `actions.ts`, `booking-client.tsx`, and the email builders.
 */

export const BOOKING_FROM_ADDRESS = 'noreply@mail.weldsuite.org';

export const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type DayName = (typeof DAY_NAMES)[number];

// Layout — referenced by inline `style` props in the booking client.
export const LAYOUT = {
  SIDEBAR_WIDTH: 280,
  CONTAINER_WIDTH: 1040,
  CONTAINER_MIN_HEIGHT: 535,
  CALENDAR_CELL_HEIGHT: 59,
} as const;

// External calendar deep-links assembled in the confirmation card.
export const EXTERNAL_CALENDAR_BASE = {
  google: 'https://calendar.google.com/calendar/render',
  outlook: 'https://outlook.live.com/calendar/0/deeplink/compose',
  weldcal: 'https://app.weldsuite.com/weldcalendar/new-event',
} as const;
