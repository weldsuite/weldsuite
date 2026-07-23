'use server';

import { eq, and, isNull, gte, lte, desc, ne } from 'drizzle-orm';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { buildIcsInvite } from '@weldsuite/transactional-email';
import {
  calendarBookingPages,
  calendarBookings,
  calendarEvents,
  calendars,
  workspaceMembers,
} from '@weldsuite/db/schema';

import { getTenantDbBySlug } from '@/lib/db';
import { generateId } from '@/lib/id';
import {
  sendBookingCancellationEmail,
  sendBookingConfirmationEmail,
  sendBookingRescheduledEmail,
  sendGuestInviteEmail,
} from '@/lib/booking-emails';
import { BOOKING_FROM_ADDRESS, DAY_NAMES, type DayName } from '@/lib/constants';
import {
  cancelBookingInputSchema,
  createBookingInputSchema,
  rescheduleBookingInputSchema,
  weeklyAvailabilitySchema,
  type CancelBookingInput,
  type CreateBookingInput,
  type RescheduleBookingInput,
} from '@/lib/schemas';

// ── Types ──────────────────────────────────────────────────────────────

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

// ── Get available slots for a date ─────────────────────────────────────

export async function getAvailableSlots(
  workspaceSlug: string,
  bookingPageId: string,
  date: string,
  // When rescheduling, exclude the booking's own event so its current slot
  // doesn't count as a conflict against the new time it's moving to.
  excludeEventId?: string,
): Promise<TimeSlot[]> {
  const tenant = await getTenantDbBySlug(workspaceSlug);
  if (!tenant) return [];
  const { db } = tenant;

  const [bookingPage] = await db
    .select()
    .from(calendarBookingPages)
    .where(
      and(
        eq(calendarBookingPages.id, bookingPageId),
        eq(calendarBookingPages.isActive, true),
        isNull(calendarBookingPages.deletedAt),
      ),
    )
    .limit(1);

  if (!bookingPage) return [];

  const tz = bookingPage.timezone || 'UTC';

  const availabilityParse = weeklyAvailabilitySchema.safeParse(bookingPage.availability);
  if (!availabilityParse.success) {
    console.error(
      '[booking-portal] availability JSONB failed schema validation',
      bookingPageId,
      availabilityParse.error.flatten(),
    );
    return [];
  }
  const availability = availabilityParse.data;

  // Resolve the weekday **in the owner's timezone**, not server-local.
  const midnightUtc = new Date(`${date}T00:00:00Z`);
  const dayInTz = toZonedTime(midnightUtc, tz);
  const dayName = DAY_NAMES[dayInTz.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6] satisfies DayName;
  const daySlots = availability[dayName] ?? [];

  if (daySlots.length === 0) return [];

  // Day window, in the owner's tz.
  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  const dayEnd = fromZonedTime(`${date}T23:59:59.999`, tz);

  const eventConditions = [
    isNull(calendarEvents.deletedAt),
    eq(calendarEvents.organizerId, bookingPage.ownerId),
    gte(calendarEvents.startTime, dayStart),
    lte(calendarEvents.startTime, dayEnd),
    eq(calendarEvents.status, 'confirmed'),
  ];
  if (excludeEventId) {
    eventConditions.push(ne(calendarEvents.id, excludeEventId));
  }

  const existingEvents = await db
    .select({ startTime: calendarEvents.startTime, endTime: calendarEvents.endTime })
    .from(calendarEvents)
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

// ── Create a booking ───────────────────────────────────────────────────

export async function createBooking(input: CreateBookingInput): Promise<BookingResult> {
  const parsed = createBookingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Please check your details and try again.' };
  }
  const data = parsed.data;

  try {
    const tenant = await getTenantDbBySlug(data.workspaceSlug);
    if (!tenant) return { success: false, error: 'Organization not found' };
    const { db } = tenant;

    const [bookingPage] = await db
      .select()
      .from(calendarBookingPages)
      .where(
        and(
          eq(calendarBookingPages.id, data.bookingPageId),
          eq(calendarBookingPages.isActive, true),
          isNull(calendarBookingPages.deletedAt),
        ),
      )
      .limit(1);

    if (!bookingPage) {
      return { success: false, error: 'Booking page not found or inactive' };
    }

    const slotDate = data.startTime.slice(0, 10); // 'yyyy-MM-dd' from ISO 8601
    const tz = bookingPage.timezone || 'UTC';
    const guests = data.guests ?? [];

    // Find owner's default calendar — outside the tx so a missing calendar
    // doesn't poison the connection.
    const [ownerCalendar] = await db
      .select()
      .from(calendars)
      .where(and(eq(calendars.ownerId, bookingPage.ownerId), isNull(calendars.deletedAt)))
      .orderBy(desc(calendars.isDefault))
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

    // Re-verify the slot is still free *inside* a transaction so two concurrent
    // bookers can't both win. The conflict check uses the same buffer logic
    // as `getAvailableSlots` but only against the single requested slot.
    const insertResult = await db.transaction(async (tx) => {
      const slots = await getAvailableSlots(data.workspaceSlug, data.bookingPageId, slotDate);
      const matching = slots.find((s) => s.start === data.startTime && s.end === data.endTime);
      if (!matching?.available) {
        return { kind: 'conflict' as const };
      }

      await tx.insert(calendarEvents).values({
        id: eventId,
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

      await tx.insert(calendarBookings).values({
        id: bookingId,
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

    // Look up organizer email/name so the ICS has a real RSVP target
    const [organizer] = await db
      .select({ email: workspaceMembers.email, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, bookingPage.ownerId))
      .limit(1);

    const organizerEmail = organizer?.email ?? BOOKING_FROM_ADDRESS;
    const organizerName = organizer?.name ?? tenant.workspace.name;

    const ics = buildIcsInvite({
      uid: `${eventId}@weldsuite`,
      method: 'REQUEST',
      summary: `${bookingPage.name} with ${data.bookerName}`,
      description:
        data.notes || bookingPage.confirmationMessage || `Booked via ${bookingPage.name}`,
      location: bookingPage.locationValue,
      startTime: data.startTime,
      endTime: data.endTime,
      organizer: { email: organizerEmail, name: organizerName },
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
        workspaceName: tenant.workspace.name,
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
          workspaceName: tenant.workspace.name,
          timezone: tz,
          ics,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter((r) => r.status === 'rejected');
    for (const r of failures) {
      console.error('[booking-portal] email send failed', bookingId, (r as PromiseRejectedResult).reason);
    }

    const emailDelivery: 'sent' | 'failed' | 'partial' =
      failures.length === 0
        ? 'sent'
        : failures.length === results.length
          ? 'failed'
          : 'partial';

    return { success: true, bookingId, emailDelivery };
  } catch (err) {
    console.error('[booking-portal] Failed to create booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}

// ── Cancel a booking ───────────────────────────────────────────────────

export type CancelResult = { success: true } | { success: false; error: string };

export async function cancelBooking(input: CancelBookingInput): Promise<CancelResult> {
  const parsed = cancelBookingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Unable to cancel this booking.' };
  }
  const data = parsed.data;

  try {
    const tenant = await getTenantDbBySlug(data.workspaceSlug);
    if (!tenant) return { success: false, error: 'Organization not found' };
    const { db } = tenant;

    const [booking] = await db
      .select()
      .from(calendarBookings)
      .where(and(eq(calendarBookings.id, data.bookingId), isNull(calendarBookings.deletedAt)))
      .limit(1);

    if (!booking) return { success: false, error: 'Booking not found' };
    // Idempotent — a double-click shouldn't surface an error.
    if (booking.status === 'cancelled') return { success: true };

    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(calendarBookings)
        .set({ status: 'cancelled', cancelledAt: now, cancelReason: data.reason, updatedAt: now })
        .where(eq(calendarBookings.id, booking.id));

      // Cancelling (not soft-deleting) the event frees the slot: getAvailableSlots
      // only counts events with status 'confirmed'.
      if (booking.calendarEventId) {
        await tx
          .update(calendarEvents)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(calendarEvents.id, booking.calendarEventId));
      }
    });

    // Best-effort cancellation notices — never fail the cancel over an email.
    const [bookingPage] = await db
      .select()
      .from(calendarBookingPages)
      .where(eq(calendarBookingPages.id, booking.bookingPageId))
      .limit(1);

    const tz = booking.timezone || bookingPage?.timezone || 'UTC';
    const startIso = booking.startTime.toISOString();
    const endIso = booking.endTime.toISOString();
    const pageName = bookingPage?.name ?? 'your meeting';
    const guests = booking.guests ?? [];

    const [organizer] = await db
      .select({ email: workspaceMembers.email, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, bookingPage?.ownerId ?? ''))
      .limit(1);

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
      organizer: {
        email: organizer?.email ?? BOOKING_FROM_ADDRESS,
        name: organizer?.name ?? tenant.workspace.name,
      },
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
        workspaceName: tenant.workspace.name,
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
          workspaceName: tenant.workspace.name,
          confirmationMessage: null,
          timezone: tz,
          ics,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[booking-portal] cancellation email failed', booking.id, r.reason);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('[booking-portal] Failed to cancel booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}

// ── Reschedule a booking ───────────────────────────────────────────────

export async function rescheduleBooking(
  input: RescheduleBookingInput,
): Promise<BookingResult> {
  const parsed = rescheduleBookingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Please pick a valid time and try again.' };
  }
  const data = parsed.data;

  try {
    const tenant = await getTenantDbBySlug(data.workspaceSlug);
    if (!tenant) return { success: false, error: 'Organization not found' };
    const { db } = tenant;

    const [booking] = await db
      .select()
      .from(calendarBookings)
      .where(and(eq(calendarBookings.id, data.bookingId), isNull(calendarBookings.deletedAt)))
      .limit(1);

    if (!booking) return { success: false, error: 'Booking not found' };
    if (booking.status === 'cancelled') {
      return { success: false, error: 'This booking has been cancelled and can no longer be rescheduled.' };
    }

    const [bookingPage] = await db
      .select()
      .from(calendarBookingPages)
      .where(
        and(
          eq(calendarBookingPages.id, booking.bookingPageId),
          eq(calendarBookingPages.isActive, true),
          isNull(calendarBookingPages.deletedAt),
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

    // Re-verify the new slot is free inside a transaction, excluding this
    // booking's own event so an adjacent move isn't blocked by itself.
    const result = await db.transaction(async (tx) => {
      const slots = await getAvailableSlots(
        data.workspaceSlug,
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
          .update(calendarEvents)
          .set({ startTime: startDate, endTime: endDate, status: 'confirmed', updatedAt: now })
          .where(eq(calendarEvents.id, booking.calendarEventId));
      }

      await tx
        .update(calendarBookings)
        .set({ startTime: startDate, endTime: endDate, status: 'confirmed', updatedAt: now })
        .where(eq(calendarBookings.id, booking.id));

      return { kind: 'ok' as const };
    });

    if (result.kind === 'conflict') {
      return { success: false, error: SLOT_TAKEN_ERROR };
    }

    const [organizer] = await db
      .select({ email: workspaceMembers.email, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, bookingPage.ownerId))
      .limit(1);

    const ics = buildIcsInvite({
      uid: `${booking.calendarEventId ?? booking.id}@weldsuite`,
      method: 'REQUEST',
      sequence: 1,
      summary: `${bookingPage.name} with ${booking.bookerName}`,
      description: booking.notes || bookingPage.confirmationMessage || `Booked via ${bookingPage.name}`,
      location: bookingPage.locationValue,
      startTime: data.startTime,
      endTime: data.endTime,
      organizer: {
        email: organizer?.email ?? BOOKING_FROM_ADDRESS,
        name: organizer?.name ?? tenant.workspace.name,
      },
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
        workspaceName: tenant.workspace.name,
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
          workspaceName: tenant.workspace.name,
          timezone: tz,
          ics,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter((r) => r.status === 'rejected');
    for (const r of failures) {
      console.error(
        '[booking-portal] reschedule email failed',
        booking.id,
        (r as PromiseRejectedResult).reason,
      );
    }

    const emailDelivery: 'sent' | 'failed' | 'partial' =
      failures.length === 0 ? 'sent' : failures.length === results.length ? 'failed' : 'partial';

    return { success: true, bookingId: booking.id, emailDelivery };
  } catch (err) {
    console.error('[booking-portal] Failed to reschedule booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
