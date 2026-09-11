'use server';

import { eq, and, isNull, gte, lte, desc, ne } from 'drizzle-orm';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { buildIcsInvite } from '@weldsuite/transactional-email';
import { personalAccounts } from '@weldsuite/db/schema/master';
import { masterDb } from '@weldsuite/db/lib/master';
import {
  personalCalendarBookingPages,
  personalCalendarBookings,
  personalCalendarEvents,
  personalCalendars,
} from '@weldsuite/db/schema/personal';

import { getPersonalDb } from '@/lib/db';
import { generateId } from '@/lib/id';
import {
  sendBookingCancellationEmail,
  sendBookingConfirmationEmail,
  sendBookingRescheduledEmail,
  sendGuestInviteEmail,
} from '@/lib/booking-emails';
import { BOOKING_FROM_ADDRESS, DAY_NAMES, type DayName } from '@/lib/constants';
import {
  cancelPersonalBookingInputSchema,
  createPersonalBookingInputSchema,
  reschedulePersonalBookingInputSchema,
  weeklyAvailabilitySchema,
  type CancelPersonalBookingInput,
  type CreatePersonalBookingInput,
  type ReschedulePersonalBookingInput,
} from '@/lib/schemas';

export type TimeSlot = {
  start: string;
  end: string;
  available: boolean;
};

export type BookingResult =
  | {
      success: true;
      bookingId: string;
      emailDelivery: 'sent' | 'failed' | 'partial';
    }
  | { success: false; error: string };

const SLOT_TAKEN_ERROR = 'This time slot is no longer available. Please choose another time.';

async function hostNameForAccount(personalAccountId: string): Promise<string> {
  const [row] = await masterDb
    .select({ displayName: personalAccounts.displayName })
    .from(personalAccounts)
    .where(eq(personalAccounts.id, personalAccountId))
    .limit(1);
  return row?.displayName?.trim() || 'WeldCalendar';
}

export async function getPersonalAvailableSlots(
  bookingPageId: string,
  date: string,
  excludeEventId?: string,
): Promise<TimeSlot[]> {
  const db = getPersonalDb();

  const [bookingPage] = await db
    .select()
    .from(personalCalendarBookingPages)
    .where(
      and(
        eq(personalCalendarBookingPages.id, bookingPageId),
        eq(personalCalendarBookingPages.isActive, true),
        isNull(personalCalendarBookingPages.deletedAt),
      ),
    )
    .limit(1);

  if (!bookingPage) return [];

  const tz = bookingPage.timezone || 'UTC';
  const availabilityParse = weeklyAvailabilitySchema.safeParse(bookingPage.availability);
  if (!availabilityParse.success) {
    console.error(
      '[booking-portal] personal availability JSONB failed schema validation',
      bookingPageId,
      availabilityParse.error.flatten(),
    );
    return [];
  }
  const availability = availabilityParse.data;

  const midnightUtc = new Date(`${date}T00:00:00Z`);
  const dayInTz = toZonedTime(midnightUtc, tz);
  const dayName = DAY_NAMES[dayInTz.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6] satisfies DayName;
  const daySlots = availability[dayName] ?? [];
  if (daySlots.length === 0) return [];

  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  const dayEnd = fromZonedTime(`${date}T23:59:59.999`, tz);

  const eventConditions = [
    isNull(personalCalendarEvents.deletedAt),
    eq(personalCalendarEvents.personalAccountId, bookingPage.personalAccountId),
    gte(personalCalendarEvents.startTime, dayStart),
    lte(personalCalendarEvents.startTime, dayEnd),
    eq(personalCalendarEvents.status, 'confirmed'),
  ];
  if (excludeEventId) {
    eventConditions.push(ne(personalCalendarEvents.id, excludeEventId));
  }

  const existingEvents = await db
    .select({ startTime: personalCalendarEvents.startTime, endTime: personalCalendarEvents.endTime })
    .from(personalCalendarEvents)
    .where(and(...eventConditions));

  const duration = bookingPage.duration;
  const bufferBefore = bookingPage.bufferBefore ?? 0;
  const bufferAfter = bookingPage.bufferAfter ?? 0;
  const slots: TimeSlot[] = [];

  for (const range of daySlots) {
    const rangeStart = fromZonedTime(`${date}T${range.start}:00`, tz);
    const rangeEnd = fromZonedTime(`${date}T${range.end}:00`, tz);
    let current = new Date(rangeStart);

    while (current.getTime() + duration * 60000 <= rangeEnd.getTime()) {
      const slotStart = new Date(current);
      const slotEnd = new Date(current.getTime() + duration * 60000);
      const bufferedStart = new Date(slotStart.getTime() - bufferBefore * 60000);
      const bufferedEnd = new Date(slotEnd.getTime() + bufferAfter * 60000);

      const hasConflict = existingEvents.some((evt) => {
        const evtStart = new Date(evt.startTime);
        const evtEnd = evt.endTime
          ? new Date(evt.endTime)
          : new Date(evtStart.getTime() + 30 * 60000);
        return bufferedStart < evtEnd && bufferedEnd > evtStart;
      });

      const now = new Date();
      const minNoticeMs = (bookingPage.minNotice ?? 60) * 60000;
      const tooSoon = slotStart.getTime() - now.getTime() < minNoticeMs;

      slots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        available: !hasConflict && !tooSoon,
      });

      current = new Date(current.getTime() + duration * 60000);
    }
  }

  return slots;
}

export async function createPersonalBooking(input: CreatePersonalBookingInput): Promise<BookingResult> {
  const parsed = createPersonalBookingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Please check your details and try again.' };
  }
  const data = parsed.data;

  try {
    const db = getPersonalDb();
    const [bookingPage] = await db
      .select()
      .from(personalCalendarBookingPages)
      .where(
        and(
          eq(personalCalendarBookingPages.id, data.bookingPageId),
          eq(personalCalendarBookingPages.isActive, true),
          isNull(personalCalendarBookingPages.deletedAt),
        ),
      )
      .limit(1);

    if (!bookingPage) {
      return { success: false, error: 'Booking page not found or inactive' };
    }

    const slotDate = data.startTime.slice(0, 10);
    const tz = bookingPage.timezone || 'UTC';
    const guests = data.guests ?? [];
    const hostName = await hostNameForAccount(bookingPage.personalAccountId);

    const [ownerCalendar] = await db
      .select()
      .from(personalCalendars)
      .where(
        and(
          eq(personalCalendars.personalAccountId, bookingPage.personalAccountId),
          isNull(personalCalendars.deletedAt),
        ),
      )
      .orderBy(desc(personalCalendars.isDefault))
      .limit(1);

    if (!ownerCalendar) {
      return { success: false, error: 'Unable to create booking at this time' };
    }

    const now = new Date();
    const bookingId = generateId('bkg');
    const eventId = generateId('evt');
    const startDate = new Date(data.startTime);
    const endDate = new Date(data.endTime);

    const attendees = [
      { email: data.bookerEmail, name: data.bookerName, status: 'accepted', role: 'attendee' },
      ...guests.map((g) => ({
        email: g.email,
        name: g.name,
        status: 'invited',
        role: 'guest',
      })),
    ];

    const insertResult = await db.transaction(async (tx) => {
      const slots = await getPersonalAvailableSlots(data.bookingPageId, slotDate);
      const matching = slots.find((s) => s.start === data.startTime && s.end === data.endTime);
      if (!matching?.available) {
        return { kind: 'conflict' as const };
      }

      await tx.insert(personalCalendarEvents).values({
        id: eventId,
        personalAccountId: bookingPage.personalAccountId,
        calendarId: ownerCalendar.id,
        title: `Meeting with ${data.bookerName}`,
        description: data.notes || `Booked via ${bookingPage.name}`,
        type: 'meeting',
        startTime: startDate,
        endTime: endDate,
        timezone: tz,
        organizerId: bookingPage.ownerId,
        status: 'confirmed',
        priority: 'normal',
        location: bookingPage.locationValue,
        isVirtual: bookingPage.locationType === 'video',
        meetingUrl: bookingPage.locationType === 'video' ? bookingPage.locationValue : null,
        attendees,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(personalCalendarBookings).values({
        id: bookingId,
        personalAccountId: bookingPage.personalAccountId,
        bookingPageId: data.bookingPageId,
        calendarEventId: eventId,
        bookerName: data.bookerName,
        bookerEmail: data.bookerEmail,
        startTime: startDate,
        endTime: endDate,
        status: 'confirmed',
        answers: data.answers,
        notes: data.notes,
        guests: guests.length > 0 ? guests : null,
        timezone: tz,
        createdAt: now,
        updatedAt: now,
      });

      return { kind: 'ok' as const };
    });

    if (insertResult.kind === 'conflict') {
      return { success: false, error: SLOT_TAKEN_ERROR };
    }

    const ics = buildIcsInvite({
      uid: `${eventId}@weldsuite`,
      method: 'REQUEST',
      summary: `${bookingPage.name} with ${data.bookerName}`,
      description:
        data.notes || bookingPage.confirmationMessage || `Booked via ${bookingPage.name}`,
      location: bookingPage.locationValue,
      startTime: data.startTime,
      endTime: data.endTime,
      organizer: { email: BOOKING_FROM_ADDRESS, name: hostName },
      attendees: [
        { email: data.bookerEmail, name: data.bookerName, role: 'REQ-PARTICIPANT' },
        ...guests.map((g) => ({
          email: g.email,
          name: g.name,
          role: 'OPT-PARTICIPANT' as const,
        })),
      ],
    });

    const emailJobs: Promise<void>[] = [
      sendBookingConfirmationEmail({
        bookerName: data.bookerName,
        bookerEmail: data.bookerEmail,
        bookingPageName: bookingPage.name,
        startTime: data.startTime,
        endTime: data.endTime,
        locationType: bookingPage.locationType,
        locationValue: bookingPage.locationValue,
        workspaceName: hostName,
        confirmationMessage: bookingPage.confirmationMessage,
        timezone: tz,
        ics,
      }),
      ...guests.map((guest) =>
        sendGuestInviteEmail({
          guestEmail: guest.email,
          bookerName: data.bookerName,
          bookingPageName: bookingPage.name,
          startTime: data.startTime,
          endTime: data.endTime,
          locationType: bookingPage.locationType,
          locationValue: bookingPage.locationValue,
          workspaceName: hostName,
          timezone: tz,
          ics,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter((r) => r.status === 'rejected');
    for (const r of failures) {
      console.error('[booking-portal] personal email send failed', bookingId, (r as PromiseRejectedResult).reason);
    }

    const emailDelivery: 'sent' | 'failed' | 'partial' =
      failures.length === 0 ? 'sent' : failures.length === results.length ? 'failed' : 'partial';

    return { success: true, bookingId, emailDelivery };
  } catch (err) {
    console.error('[booking-portal] Failed to create personal booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}

export type CancelResult = { success: true } | { success: false; error: string };

export async function cancelPersonalBooking(input: CancelPersonalBookingInput): Promise<CancelResult> {
  const parsed = cancelPersonalBookingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Unable to cancel this booking.' };
  }
  const data = parsed.data;

  try {
    const db = getPersonalDb();
    const [booking] = await db
      .select()
      .from(personalCalendarBookings)
      .where(and(eq(personalCalendarBookings.id, data.bookingId), isNull(personalCalendarBookings.deletedAt)))
      .limit(1);

    if (!booking) return { success: false, error: 'Booking not found' };
    if (booking.status === 'cancelled') return { success: true };

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(personalCalendarBookings)
        .set({ status: 'cancelled', cancelledAt: now, cancelReason: data.reason, updatedAt: now })
        .where(eq(personalCalendarBookings.id, booking.id));

      if (booking.calendarEventId) {
        await tx
          .update(personalCalendarEvents)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(personalCalendarEvents.id, booking.calendarEventId));
      }
    });

    const [bookingPage] = await db
      .select()
      .from(personalCalendarBookingPages)
      .where(eq(personalCalendarBookingPages.id, booking.bookingPageId))
      .limit(1);

    const hostName = await hostNameForAccount(booking.personalAccountId);
    const tz = booking.timezone || bookingPage?.timezone || 'UTC';
    const startIso = booking.startTime.toISOString();
    const endIso = booking.endTime.toISOString();
    const pageName = bookingPage?.name ?? 'your meeting';
    const guests = booking.guests ?? [];

    const ics = buildIcsInvite({
      uid: `${booking.calendarEventId ?? booking.id}@weldsuite`,
      method: 'CANCEL',
      status: 'CANCELLED',
      sequence: 1,
      summary: `${pageName} with ${booking.bookerName}`,
      description: booking.notes,
      location: bookingPage?.locationValue ?? null,
      startTime: startIso,
      endTime: endIso,
      organizer: { email: BOOKING_FROM_ADDRESS, name: hostName },
      attendees: [
        { email: booking.bookerEmail, name: booking.bookerName, role: 'REQ-PARTICIPANT' },
        ...guests.map((g) => ({ email: g.email, name: g.name, role: 'OPT-PARTICIPANT' as const })),
      ],
    });

    const emailJobs: Promise<void>[] = [
      sendBookingCancellationEmail({
        bookerName: booking.bookerName,
        bookerEmail: booking.bookerEmail,
        bookingPageName: pageName,
        startTime: startIso,
        endTime: endIso,
        locationType: bookingPage?.locationType ?? null,
        locationValue: bookingPage?.locationValue ?? null,
        workspaceName: hostName,
        confirmationMessage: null,
        timezone: tz,
        ics,
      }),
      ...guests.map((guest) =>
        sendBookingCancellationEmail({
          bookerName: guest.name ?? guest.email,
          bookerEmail: guest.email,
          bookingPageName: pageName,
          startTime: startIso,
          endTime: endIso,
          locationType: bookingPage?.locationType ?? null,
          locationValue: bookingPage?.locationValue ?? null,
          workspaceName: hostName,
          confirmationMessage: null,
          timezone: tz,
          ics,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[booking-portal] personal cancellation email failed', booking.id, r.reason);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('[booking-portal] Failed to cancel personal booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}

export async function reschedulePersonalBooking(
  input: ReschedulePersonalBookingInput,
): Promise<BookingResult> {
  const parsed = reschedulePersonalBookingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Please pick a valid time and try again.' };
  }
  const data = parsed.data;

  try {
    const db = getPersonalDb();
    const [booking] = await db
      .select()
      .from(personalCalendarBookings)
      .where(and(eq(personalCalendarBookings.id, data.bookingId), isNull(personalCalendarBookings.deletedAt)))
      .limit(1);

    if (!booking) return { success: false, error: 'Booking not found' };
    if (booking.status === 'cancelled') {
      return { success: false, error: 'This booking has been cancelled and can no longer be rescheduled.' };
    }

    const [bookingPage] = await db
      .select()
      .from(personalCalendarBookingPages)
      .where(
        and(
          eq(personalCalendarBookingPages.id, booking.bookingPageId),
          eq(personalCalendarBookingPages.isActive, true),
          isNull(personalCalendarBookingPages.deletedAt),
        ),
      )
      .limit(1);

    if (!bookingPage) return { success: false, error: 'Booking page not found or inactive' };

    const slotDate = data.startTime.slice(0, 10);
    const tz = bookingPage.timezone || booking.timezone || 'UTC';
    const now = new Date();
    const startDate = new Date(data.startTime);
    const endDate = new Date(data.endTime);
    const guests = booking.guests ?? [];
    const hostName = await hostNameForAccount(booking.personalAccountId);

    const result = await db.transaction(async (tx) => {
      const slots = await getPersonalAvailableSlots(
        booking.bookingPageId,
        slotDate,
        booking.calendarEventId ?? undefined,
      );
      const matching = slots.find((s) => s.start === data.startTime && s.end === data.endTime);
      if (!matching?.available) {
        return { kind: 'conflict' as const };
      }

      if (booking.calendarEventId) {
        await tx
          .update(personalCalendarEvents)
          .set({ startTime: startDate, endTime: endDate, status: 'confirmed', updatedAt: now })
          .where(eq(personalCalendarEvents.id, booking.calendarEventId));
      }

      await tx
        .update(personalCalendarBookings)
        .set({ startTime: startDate, endTime: endDate, status: 'confirmed', updatedAt: now })
        .where(eq(personalCalendarBookings.id, booking.id));

      return { kind: 'ok' as const };
    });

    if (result.kind === 'conflict') {
      return { success: false, error: SLOT_TAKEN_ERROR };
    }

    const ics = buildIcsInvite({
      uid: `${booking.calendarEventId ?? booking.id}@weldsuite`,
      method: 'REQUEST',
      sequence: 1,
      summary: `${bookingPage.name} with ${booking.bookerName}`,
      description: booking.notes || bookingPage.confirmationMessage || `Booked via ${bookingPage.name}`,
      location: bookingPage.locationValue,
      startTime: data.startTime,
      endTime: data.endTime,
      organizer: { email: BOOKING_FROM_ADDRESS, name: hostName },
      attendees: [
        { email: booking.bookerEmail, name: booking.bookerName, role: 'REQ-PARTICIPANT' },
        ...guests.map((g) => ({ email: g.email, name: g.name, role: 'OPT-PARTICIPANT' as const })),
      ],
    });

    const emailJobs: Promise<void>[] = [
      sendBookingRescheduledEmail({
        bookerName: booking.bookerName,
        bookerEmail: booking.bookerEmail,
        bookingPageName: bookingPage.name,
        startTime: data.startTime,
        endTime: data.endTime,
        locationType: bookingPage.locationType,
        locationValue: bookingPage.locationValue,
        workspaceName: hostName,
        confirmationMessage: bookingPage.confirmationMessage,
        timezone: tz,
        ics,
      }),
      ...guests.map((guest) =>
        sendGuestInviteEmail({
          guestEmail: guest.email,
          bookerName: booking.bookerName,
          bookingPageName: bookingPage.name,
          startTime: data.startTime,
          endTime: data.endTime,
          locationType: bookingPage.locationType,
          locationValue: bookingPage.locationValue,
          workspaceName: hostName,
          timezone: tz,
          ics,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter((r) => r.status === 'rejected');
    for (const r of failures) {
      console.error(
        '[booking-portal] personal reschedule email failed',
        booking.id,
        (r as PromiseRejectedResult).reason,
      );
    }

    const emailDelivery: 'sent' | 'failed' | 'partial' =
      failures.length === 0 ? 'sent' : failures.length === results.length ? 'failed' : 'partial';

    return { success: true, bookingId: booking.id, emailDelivery };
  } catch (err) {
    console.error('[booking-portal] Failed to reschedule personal booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
