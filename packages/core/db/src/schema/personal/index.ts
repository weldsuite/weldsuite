/**
 * Shared personal Neon database schemas.
 *
 * All personal-app data (WeldMail inbox, WeldCalendar, future personal apps)
 * lives here, keyed by `personalAccountId` (master.personal_accounts.id).
 */

export * from './mail-accounts';
export * from './mail-messages';
export * from './mail-labels';
export * from './mail-drafts';
export * from './mail-attachments';
export * from './device-tokens';
export * from './calendars';
export * from './calendar-events';
export * from './calendar-booking-pages';
export * from './calendar-bookings';
