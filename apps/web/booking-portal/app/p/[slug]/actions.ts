'use server';

import { eq, and, isNull, desc, sql } from 'drizzle-orm';
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
import { BOOKING_FROM_ADDRESS } from '@/lib/constants';
import { isCalendarDate } from '@/lib/day-slots';
import {
  isPersonalSlotAvailable,
  loadPersonalDaySlots,
  type PersonalQueryDb,
} from '@/lib/personal-slots';
import {
  cancelPersonalBookingInputSchema,
  createPersonalBookingInputSchema,
  reschedulePersonalBookingInputSchema,
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
      /** The page's own video link, when it has one. Personal pages cannot create WeldMeet meetings. */
      meetingUrl: string | null;
    }
  | { success: false; error: string };

const SLOT_TAKEN_ERROR = 'This time slot is no longer available. Please choose another time.';

function resolveEmailDelivery(
  failureCount: number,
  totalCount: number,
): 'sent' | 'failed' | 'partial' {
  if (failureCount === 0) return 'sent';
  if (failureCount === totalCount) return 'failed';
  return 'partial';
}

async function hostNameForAccount(personalAccountId: string): Promise<string> {
  const [row] = await masterDb
    .select({ displayName: personalAccounts.displayName })
    .from(personalAccounts)
    .where(eq(personalAccounts.id, personalAccountId))
    .limit(1);
  return row?.displayName?.trim() || 'WeldCalendar';
}

/** The page's own link for a video booking, or null. */
function customVideoLink(page: { locationType: string | null; locationValue: string | null }): string | null {
  return page.locationType === 'video' ? page.locationValue?.trim() || null : null;
}

/** Serialises bookings of one page for the length of the transaction. */
async function lockBookingPage(tx: PersonalQueryDb, bookingPageId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bookingPageId}))`);
}

export async function getPersonalAvailableSlots(
  bookingPageId: string,
  date: string,
  // When rescheduling: the booking being moved, so its own slot counts as free.
  bookingId?: string,
): Promise<TimeSlot[]> {
  if (!isCalendarDate(date)) return [];
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

  let excludeEventId: string | null = null;
  if (bookingId) {
    const [booking] = await db
      .select({ calendarEventId: personalCalendarBookings.calendarEventId })
      .from(personalCalendarBookings)
      .where(
        and(
          eq(personalCalendarBookings.id, bookingId),
          eq(personalCalendarBookings.bookingPageId, bookingPage.id),
          isNull(personalCalendarBookings.deletedAt),
        ),
      )
      .limit(1);
    excludeEventId = booking?.calendarEventId ?? null;
  }

  return loadPersonalDaySlots(db, bookingPage, date, excludeEventId);
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
      await lockBookingPage(tx, bookingPage.id);
      if (!(await isPersonalSlotAvailable(tx, bookingPage, data.startTime, data.endTime))) {
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

    const emailDelivery = resolveEmailDelivery(failures.length, results.length);

    return { success: true, bookingId, emailDelivery, meetingUrl: customVideoLink(bookingPage) };
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

    const tz = bookingPage.timezone || booking.timezone || 'UTC';
    const now = new Date();
    const startDate = new Date(data.startTime);
    const endDate = new Date(data.endTime);
    const guests = booking.guests ?? [];
    const hostName = await hostNameForAccount(booking.personalAccountId);

    const result = await db.transaction(async (tx) => {
      await lockBookingPage(tx, bookingPage.id);
      const free = await isPersonalSlotAvailable(
        tx,
        bookingPage,
        data.startTime,
        data.endTime,
        booking.calendarEventId,
      );
      if (!free) return { kind: 'conflict' as const };

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

    const emailDelivery = resolveEmailDelivery(failures.length, results.length);

    return { success: true, bookingId: booking.id, emailDelivery, meetingUrl: customVideoLink(bookingPage) };
  } catch (err) {
    console.error('[booking-portal] Failed to reschedule personal booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
