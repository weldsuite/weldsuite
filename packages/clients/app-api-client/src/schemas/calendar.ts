import { z } from 'zod';

// ============================================================================
// WeldCalendar responses (calendar-api): calendars and their shares, calendar
// events, booking pages and their slots, bookings, working hours. Rows are the
// tables' columns as the routes return them (timestamps as ISO strings).
// ============================================================================

const timestamp = z.string();

/** A `calendars` row. */
export const calendarSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  ownerId: z.string(),
  isDefault: z.boolean().nullable(),
  isActive: z.boolean().nullable(),
});
export type Calendar = z.infer<typeof calendarSchema>;

export const calendarPermissionSchema = z.enum(['view', 'edit', 'manage']);

/** A calendar in the caller's list: their own, or shared with them. */
export const annotatedCalendarSchema = calendarSchema.extend({
  isOwn: z.boolean(),
  permission: calendarPermissionSchema,
});
export type AnnotatedCalendar = z.infer<typeof annotatedCalendarSchema>;

/** A `calendar_shares` row. */
export const calendarShareSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  calendarId: z.string(),
  sharedWithId: z.string(),
  permission: z.string(),
  sharedById: z.string(),
});
export type CalendarShare = z.infer<typeof calendarShareSchema>;

/** `{ id }` of a created calendar, share or booking page. */
export const calendarRefSchema = z.object({ id: z.string() });

/** `PATCH /api/calendars/:id`: the id and the fields that were set. */
export const calendarUpdatedSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
});

/** `POST /api/calendars/:id/share` updating an existing share. */
export const calendarShareResultSchema = z.object({
  id: z.string(),
  permission: calendarPermissionSchema.optional(),
});

/** What deleting a calendar removes. */
export const calendarDeleteImpactSchema = z.object({
  eventCount: z.number().int(),
  eventsWithAttendees: z.number().int(),
});

const attendeeSchema = z
  .object({
    email: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

/** A `calendar_events` row. */
export const calendarEventSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  startTime: timestamp,
  endTime: timestamp.nullable(),
  allDay: z.boolean().nullable(),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  isVirtual: z.boolean().nullable(),
  meetingUrl: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullable(),
  color: z.string().nullable(),
  recurrenceRule: z.string().nullable(),
  recurrenceId: z.string().nullable(),
  calendarId: z.string(),
  organizerId: z.string(),
  attendees: z.array(attendeeSchema).nullable(),
  reminders: z.array(z.object({ type: z.string(), minutes: z.number() }).passthrough()).nullable(),
  customerId: z.string().nullable(),
  contactId: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  autoScheduled: z.boolean().nullable(),
  reason: z.string().nullable(),
  taskPriority: z.string().nullable(),
  notes: z.string().nullable(),
  attachments: z.array(z.string()).nullable(),
  tags: z.array(z.string()).nullable(),
  customFields: z.record(z.unknown()).nullable(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/**
 * A created or updated event: its id, the fields the request set (update and
 * reschedule echo them), and whether a WeldMeet meeting was linked.
 */
export const calendarEventWriteSchema = z
  .object({
    id: z.string(),
    weldMeetingLinked: z.boolean().optional(),
  })
  .passthrough();

/** `PATCH /api/calendar-events/:id/cancel`. */
export const calendarEventCancelledSchema = z.object({
  id: z.string(),
  status: z.literal('cancelled'),
});

/** `POST /api/calendar-events/:id/unpin`. */
export const calendarEventUnpinnedSchema = z.object({
  id: z.string(),
  autoScheduled: z.literal(true),
});

const timeRangeSchema = z.object({ start: z.string(), end: z.string() }).passthrough();

/** A `calendar_booking_pages` row. */
export const bookingPageSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  ownerId: z.string(),
  duration: z.number().int(),
  bufferBefore: z.number().int().nullable(),
  bufferAfter: z.number().int().nullable(),
  color: z.string().nullable(),
  isActive: z.boolean().nullable(),
  locationType: z.string().nullable(),
  locationValue: z.string().nullable(),
  availability: z.record(z.array(timeRangeSchema)),
  questions: z.array(z.record(z.unknown())).nullable(),
  minNotice: z.number().int().nullable(),
  maxAdvance: z.number().int().nullable(),
  dateOverrides: z.array(z.object({ date: z.string(), slots: z.array(timeRangeSchema) }).passthrough()).nullable(),
  maxBookingsPerDay: z.number().int().nullable(),
  confirmationMessage: z.string().nullable(),
  timezone: z.string(),
});
export type BookingPage = z.infer<typeof bookingPageSchema>;

/** What deleting a booking page leaves dangling. */
export const bookingPageDeleteImpactSchema = z.object({
  upcomingBookingCount: z.number().int(),
});

/** `PATCH /api/booking-pages/:id/toggle`. */
export const bookingPageToggledSchema = z.object({
  id: z.string(),
  isActive: z.boolean(),
});

/** One bookable slot of a date. */
export const bookingSlotSchema = z.object({
  start: z.string(),
  end: z.string(),
  available: z.boolean(),
});
export type BookingSlot = z.infer<typeof bookingSlotSchema>;

/** A `calendar_bookings` row. */
export const bookingSchema = z.object({
  id: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
  bookingPageId: z.string(),
  calendarEventId: z.string().nullable(),
  bookerName: z.string(),
  bookerEmail: z.string(),
  startTime: timestamp,
  endTime: timestamp,
  status: z.string(),
  answers: z.record(z.unknown()).nullable(),
  notes: z.string().nullable(),
  guests: z.array(z.object({ email: z.string() }).passthrough()).nullable(),
  timezone: z.string().nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
});
export type Booking = z.infer<typeof bookingSchema>;

const dayHoursSchema = z
  .object({
    isOpen: z.boolean(),
    openTime: z.string().optional(),
    closeTime: z.string().optional(),
    breaks: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
  })
  .passthrough();

/** A member's weekly working hours, by weekday. */
export const workingHoursSchema = z.record(dayHoursSchema);

/** `GET|PUT /api/working-hours`. */
export const myWorkingHoursSchema = z.object({
  workingHours: workingHoursSchema.nullable(),
});

/** One active member in the team overview. */
export const teamWorkingHoursSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  picture: z.string().nullable(),
  workingHours: workingHoursSchema.nullable(),
});

/** `GET /api/working-hours/members/:memberId`. */
export const memberWorkingHoursSchema = z.object({
  memberId: z.string(),
  memberName: z.string().nullable(),
  workingHours: workingHoursSchema.nullable(),
});

/** `PUT /api/working-hours/members/:memberId`. */
export const memberWorkingHoursUpdatedSchema = z.object({
  memberId: z.string(),
  workingHours: workingHoursSchema,
});
