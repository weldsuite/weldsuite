import {
  pgTable,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * meeting_session_waitlist — pending guest join requests for meetings that
 * have `waitingRoom = true`. A row is inserted by the portal's POST
 * /api/meeting/join when the meeting's waitingRoom flag is on; the host
 * decides via the in-meeting Host Controls admit/deny endpoints. The portal
 * polls /api/meeting/[meetingId]/waitlist-status until status flips to
 * `admitted`, at which point it calls /api/meeting/join again to actually
 * mint an RTK token.
 */
export const meetingSessionWaitlist = pgTable('meeting_session_waitlist', {
  id: varchar('id', { length: 30 }).primaryKey(),
  meetingId: varchar('meeting_id', { length: 30 }).notNull(),
  sessionId: varchar('session_id', { length: 30 }),

  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  contactId: varchar('contact_id', { length: 30 }),
  // New — populated when guest is matched/created during admission.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),

  /** 'pending' | 'admitted' | 'denied' */
  status: varchar('status', { length: 20 }).notNull().default('pending'),

  requestedAt: timestamp('requested_at').notNull().defaultNow(),
  decidedAt: timestamp('decided_at'),
  decidedBy: varchar('decided_by', { length: 255 }),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('meeting_waitlist_meeting_idx').on(table.meetingId),
  index('meeting_waitlist_status_idx').on(table.status),
  index('meeting_waitlist_email_idx').on(table.email),
]);

export type MeetingSessionWaitlistEntry = typeof meetingSessionWaitlist.$inferSelect;
export type NewMeetingSessionWaitlistEntry = typeof meetingSessionWaitlist.$inferInsert;
