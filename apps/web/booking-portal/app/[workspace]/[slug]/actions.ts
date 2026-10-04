'use server';

import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { buildIcsInvite } from '@weldsuite/transactional-email';
import {
  cancelBookingMeeting,
  createBookingMeeting,
  rescheduleBookingMeeting,
} from '@weldsuite/meet-domain/booking-meeting';
import {
  calendarBookingPages,
  calendarBookings,
  calendarEvents,
  calendars,
} from '@weldsuite/db/schema';

import { getTenantDbBySlug } from '@/lib/db';
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
  isTenantSlotAvailable,
  loadDaySlots,
  type SlotExclusions,
  type TenantQueryDb,
} from '@/lib/booking-slots';
import { calendarLocationOf, needsWeldMeetMeeting } from '@/lib/location';
import {
  buildManageUrls,
  createManageToken,
  formatAnswerLines,
  getHostInfo,
  isValidManageToken,
  parseQuestions,
  resolveAnswers,
} from '@/lib/booking-server';
import {
  cancelBookingInputSchema,
  createBookingInputSchema,
  rescheduleBookingInputSchema,
  type CancelBookingInput,
  type CreateBookingInput,
  type RescheduleBookingInput,
} from '@/lib/schemas';

// ── Types ──────────────────────────────────────────────────────────────

function summarizeEmailDelivery(failed: number, total: number): 'sent' | 'failed' | 'partial' {
  if (failed === 0) return 'sent';
  return failed === total ? 'failed' : 'partial';
}

export type TimeSlot = {
  start: string;
  end: string;
  available: boolean;
};

export type BookingResult =
  | {
      success: true;
      bookingId: string;
      /** Signed token that authorises cancelling / rescheduling this booking. */
      manageToken: string;
      emailDelivery: 'sent' | 'failed' | 'partial';
      /** Join link of the meeting (WeldMeet or the page's own link); null for in person / phone. */
      meetingUrl: string | null;
    }
  | { success: false; error: string };

const SLOT_TAKEN_ERROR = 'This time slot is no longer available. Please choose another time.';

/** The page's own link for a video booking (a legacy manual link), or null. */
function customVideoLink(page: { locationType: string | null; locationValue: string | null }): string | null {
  return page.locationType === 'video' ? page.locationValue?.trim() || null : null;
}

/**
 * Serialises bookings of one page for the length of the transaction, so two
 * people booking the same slot at once cannot both pass the availability check.
 */
async function lockBookingPage(tx: TenantQueryDb, bookingPageId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bookingPageId}))`);
}

/** The join link stored on a booking's calendar event, if any. */
async function eventMeetingUrl(db: TenantQueryDb, eventId: string | null): Promise<string | null> {
  if (!eventId) return null;
  const [row] = await db
    .select({ meetingUrl: calendarEvents.meetingUrl })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);
  return row?.meetingUrl?.trim() || null;
}

/**
 * While a booking is being rescheduled, its own event and booking must not
 * count against the slots it is moving to. Only honoured with the signed token
 * from the booking's link.
 */
async function managedExclusions(
  db: TenantQueryDb,
  bookingPageId: string,
  manage: { bookingId: string; token: string } | undefined,
): Promise<SlotExclusions> {
  if (!manage || !(await isValidManageToken(manage.bookingId, manage.token))) return {};
  const [booking] = await db
    .select({ id: calendarBookings.id, calendarEventId: calendarBookings.calendarEventId })
    .from(calendarBookings)
    .where(
      and(
        eq(calendarBookings.id, manage.bookingId),
        eq(calendarBookings.bookingPageId, bookingPageId),
        isNull(calendarBookings.deletedAt),
      ),
    )
    .limit(1);
  return booking ? { excludeEventId: booking.calendarEventId, excludeBookingId: booking.id } : {};
}

// ── Get available slots for a date ─────────────────────────────────────

export async function getAvailableSlots(
  workspaceSlug: string,
  bookingPageId: string,
  date: string,
  // When rescheduling: the booking being moved. Its own slot then counts as
  // free (verified with the booking's signed token).
  manage?: { bookingId: string; token: string },
): Promise<TimeSlot[]> {
  if (!isCalendarDate(date)) return [];

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

  const exclude = await managedExclusions(db, bookingPage.id, manage);
  return loadDaySlots(db, bookingPage, date, exclude);
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

    const tz = bookingPage.timezone || 'UTC';
    const guests = data.guests ?? [];

    // Custom form fields: only the page's own questions, required ones enforced.
    const questions = parseQuestions(bookingPage.questions);
    const answerResult = resolveAnswers(questions, data.answers);
    if (!answerResult.ok) {
      return { success: false, error: 'Please answer all required questions and try again.' };
    }
    const answers = answerResult.answers;

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
    // Signed before anything is written so a missing secret cannot leave a
    // booking the guest can never manage.
    const manageToken = await createManageToken(bookingId);
    const startDate = new Date(data.startTime);
    const endDate = new Date(data.endTime);
    const baseDescription = [
      data.notes || `Booked via ${bookingPage.name}`,
      ...formatAnswerLines(questions, answers),
    ];

    const attendees = [
      { email: data.bookerEmail, name: data.bookerName, status: 'accepted', role: 'attendee' },
      ...guests.map((g) => ({
        email: g.email,
        name: g.name,
        status: 'invited',
        role: 'guest',
      })),
    ];

    // A video page without a link of its own meets in WeldMeet: every booking
    // gets its own meeting, created with the event.
    const wantsMeeting = needsWeldMeetMeeting(bookingPage.locationType, bookingPage.locationValue);
    const eventTitle = `Meeting with ${data.bookerName}`;

    // Re-verify the slot under the same rules as the picker *inside* a
    // transaction, behind a per-page lock, so two concurrent bookers can't both
    // win. Event, booking and meeting are written together or not at all.
    const insertResult = await db.transaction(async (tx) => {
      await lockBookingPage(tx, bookingPage.id);

      if (!(await isTenantSlotAvailable(tx, bookingPage, data.startTime, data.endTime))) {
        return { kind: 'conflict' as const };
      }

      const meeting = wantsMeeting
        ? await createBookingMeeting(tx, {
            id: generateId('mtg'),
            title: eventTitle,
            eventId,
            hostUserId: bookingPage.ownerId,
            // The meeting portal resolves the tenant by Clerk organization id.
            workspaceId: tenant.workspace.clerkOrgId ?? tenant.workspace.id,
            portalUrl: process.env.MEETING_PORTAL_URL,
            start: startDate,
            end: endDate,
            attendees: [
              { email: data.bookerEmail, name: data.bookerName, status: 'accepted' },
              ...guests.map((g) => ({ email: g.email, name: g.name })),
            ],
          })
        : null;
      const meetingUrl = meeting?.joinUrl ?? customVideoLink(bookingPage);

      await tx.insert(calendarEvents).values({
        id: eventId,
        calendarId: ownerCalendar.id,
        title: eventTitle,
        description: [
          ...baseDescription,
          ...(meeting ? [`Join: ${meeting.joinUrl}`] : []),
        ].join('\n'),
        type: 'meeting',
        startTime: startDate,
        endTime: endDate,
        timezone: tz,
        organizerId: bookingPage.ownerId,
        status: 'confirmed',
        priority: 'normal',
        location: meeting ? 'WeldMeet' : bookingPage.locationValue,
        isVirtual: bookingPage.locationType === 'video',
        meetingUrl,
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
        answers,
        notes: data.notes,
        guests: guests.length > 0 ? guests : null,
        timezone: tz,
        createdAt: now,
        updatedAt: now,
      });

      return { kind: 'ok' as const, meetingUrl };
    });

    if (insertResult.kind === 'conflict') {
      return { success: false, error: SLOT_TAKEN_ERROR };
    }
    const { meetingUrl } = insertResult;

    // The host is the member who owns the page. Their email is the ICS RSVP
    // target and the reply-to of every mail; their name is what guests see.
    const host = await getHostInfo(db, bookingPage.ownerId, tenant.workspace.name);
    const manageUrls = await buildManageUrls({
      workspaceSlug: data.workspaceSlug,
      pageSlug: bookingPage.slug,
      bookingId,
      token: manageToken,
    });

    const organizerEmail = host.email ?? BOOKING_FROM_ADDRESS;
    const organizerName = host.name;

    const ics = buildIcsInvite({
      uid: `${eventId}@weldsuite`,
      method: 'REQUEST',
      summary: `${bookingPage.name} with ${data.bookerName}`,
      description: [
        data.notes || bookingPage.confirmationMessage || `Booked via ${bookingPage.name}`,
        ...formatAnswerLines(questions, answers),
        ...(meetingUrl ? [`Join: ${meetingUrl}`] : []),
      ].join('\n'),
      location: calendarLocationOf({
        locationType: bookingPage.locationType,
        locationValue: bookingPage.locationValue,
        meetingUrl,
      }),
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
        meetingUrl,
        workspaceName: tenant.workspace.name,
        confirmationMessage: bookingPage.confirmationMessage,
        timezone: tz,
        ics,
        hostName: host.name,
        hostEmail: host.email,
        rescheduleUrl: manageUrls?.rescheduleUrl,
        cancelUrl: manageUrls?.cancelUrl,
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
          meetingUrl,
          workspaceName: tenant.workspace.name,
          timezone: tz,
          ics,
          hostName: host.name,
          hostEmail: host.email,
        }),
      ),
    ];

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter((r) => r.status === 'rejected');
    for (const r of failures) {
      console.error('[booking-portal] email send failed', bookingId, (r as PromiseRejectedResult).reason);
    }

    const emailDelivery = summarizeEmailDelivery(failures.length, results.length);

    return { success: true, bookingId, manageToken, emailDelivery, meetingUrl };
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

  if (!(await isValidManageToken(data.bookingId, data.token))) {
    return { success: false, error: 'This link is no longer valid.' };
  }

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
    const meetingUrl = await eventMeetingUrl(db, booking.calendarEventId);

    await db.transaction(async (tx) => {
      await tx
        .update(calendarBookings)
        .set({ status: 'cancelled', cancelledAt: now, cancelReason: data.reason, updatedAt: now })
        .where(eq(calendarBookings.id, booking.id));

      // Cancelling (not soft-deleting) the event frees the slot: only
      // confirmed and tentative events block a slot.
      if (booking.calendarEventId) {
        await tx
          .update(calendarEvents)
          .set({ status: 'cancelled', updatedAt: now })
          .where(eq(calendarEvents.id, booking.calendarEventId));

        // The WeldMeet meeting of the booking is cancelled with it, like
        // calendar-api does when a linked event is cancelled.
        await cancelBookingMeeting(tx, booking.calendarEventId);
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

    const host = await getHostInfo(db, bookingPage?.ownerId ?? '', tenant.workspace.name);

    const ics = buildIcsInvite({
      uid: `${booking.calendarEventId ?? booking.id}@weldsuite`,
      method: 'CANCEL',
      status: 'CANCELLED',
      sequence: 1,
      summary: `${pageName} with ${booking.bookerName}`,
      description: booking.notes,
      location: calendarLocationOf({
        locationType: bookingPage?.locationType ?? null,
        locationValue: bookingPage?.locationValue ?? null,
        meetingUrl,
      }),
      startTime: startIso,
      endTime: endIso,
      organizer: { email: host.email ?? BOOKING_FROM_ADDRESS, name: host.name },
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
        meetingUrl,
        workspaceName: tenant.workspace.name,
        confirmationMessage: null,
        timezone: tz,
        ics,
        hostName: host.name,
        hostEmail: host.email,
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
          meetingUrl,
          workspaceName: tenant.workspace.name,
          confirmationMessage: null,
          timezone: tz,
          ics,
          hostName: host.name,
          hostEmail: host.email,
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

  if (!(await isValidManageToken(data.bookingId, data.token))) {
    return { success: false, error: 'This link is no longer valid.' };
  }

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

    const tz = bookingPage.timezone || booking.timezone || 'UTC';
    const now = new Date();
    const startDate = new Date(data.startTime);
    const endDate = new Date(data.endTime);
    const guests = booking.guests ?? [];

    // Re-verify the new slot under the same rules, excluding this booking's own
    // event and booking so a move is not blocked by itself. The meeting moves
    // with the event.
    const result = await db.transaction(async (tx) => {
      await lockBookingPage(tx, bookingPage.id);

      const free = await isTenantSlotAvailable(tx, bookingPage, data.startTime, data.endTime, {
        excludeEventId: booking.calendarEventId,
        excludeBookingId: booking.id,
      });
      if (!free) return { kind: 'conflict' as const };

      if (booking.calendarEventId) {
        await tx
          .update(calendarEvents)
          .set({ startTime: startDate, endTime: endDate, status: 'confirmed', updatedAt: now })
          .where(eq(calendarEvents.id, booking.calendarEventId));

        await rescheduleBookingMeeting(tx, {
          eventId: booking.calendarEventId,
          start: startDate,
          end: endDate,
        });
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

    const meetingUrl =
      (await eventMeetingUrl(db, booking.calendarEventId)) ?? customVideoLink(bookingPage);
    const host = await getHostInfo(db, bookingPage.ownerId, tenant.workspace.name);
    const manageToken = data.token;
    const manageUrls = await buildManageUrls({
      workspaceSlug: data.workspaceSlug,
      pageSlug: bookingPage.slug,
      bookingId: booking.id,
      token: manageToken,
    });

    const ics = buildIcsInvite({
      uid: `${booking.calendarEventId ?? booking.id}@weldsuite`,
      method: 'REQUEST',
      sequence: 1,
      summary: `${bookingPage.name} with ${booking.bookerName}`,
      description: [
        booking.notes || bookingPage.confirmationMessage || `Booked via ${bookingPage.name}`,
        ...(meetingUrl ? [`Join: ${meetingUrl}`] : []),
      ].join('\n'),
      location: calendarLocationOf({
        locationType: bookingPage.locationType,
        locationValue: bookingPage.locationValue,
        meetingUrl,
      }),
      startTime: data.startTime,
      endTime: data.endTime,
      organizer: { email: host.email ?? BOOKING_FROM_ADDRESS, name: host.name },
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
        meetingUrl,
        workspaceName: tenant.workspace.name,
        confirmationMessage: bookingPage.confirmationMessage,
        timezone: tz,
        ics,
        hostName: host.name,
        hostEmail: host.email,
        rescheduleUrl: manageUrls?.rescheduleUrl,
        cancelUrl: manageUrls?.cancelUrl,
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
          meetingUrl,
          workspaceName: tenant.workspace.name,
          timezone: tz,
          ics,
          hostName: host.name,
          hostEmail: host.email,
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

    const emailDelivery = summarizeEmailDelivery(failures.length, results.length);

    return { success: true, bookingId: booking.id, manageToken, emailDelivery, meetingUrl };
  } catch (err) {
    console.error('[booking-portal] Failed to reschedule booking:', err);
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
