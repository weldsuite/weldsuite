/**
 * WeldCalendar hooks — fully on app-api.
 *
 * W5b: the behaviour that used to keep these on api-worker (attendee mail,
 * date-windowed reads, the calendar share model, auto-schedule pinning and
 * server-side slot computation) now lives in app-api, so every hook here
 * targets it:
 *
 *   /api/calendars          — list is share-aware (own + shared-with-me, each
 *                             annotated `isOwn` + `permission`), plus
 *                             /ensure-default, /:id/shares, /:id/share
 *   /api/calendar-events    — /range, /upcoming, date filters on the list,
 *                             Resend invite/reschedule/cancel mail driven by
 *                             `?sendNotification=true`, /reschedule + /unpin
 *   /api/booking-pages      — CRUD + /:id/available-slots
 *
 * Envelope note: app-api returns `{ data }` (and `{ data, pagination }` for
 * lists) where api-worker returned `{ success, data }`. Consumers only ever
 * read `.data`, so the shapes below drop the `success` key rather than
 * pretending it is still there.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { weldmeetKeys } from '@/hooks/queries/use-weldmeet-queries';
import { asText } from '@weldsuite/text';

// ── Calendar (per-user calendar container) ──────────────────────────────

export interface UserCalendar {
  id: string;
  name: string;
  description?: string;
  color?: string;
  ownerId: string;
  isDefault?: boolean;
  isActive?: boolean;
  isOwn: boolean;
  permission: 'view' | 'edit' | 'manage';
  createdAt?: string;
  updatedAt?: string;
}

export interface CalendarShareRecord {
  id: string;
  calendarId: string;
  sharedWithId: string;
  permission: 'view' | 'edit' | 'manage';
  sharedById: string;
  createdAt?: string;
}

export interface CalendarEvent {
  id?: string;
  calendarId?: string;
  type: 'meeting' | 'call' | 'appointment' | 'event' | 'reminder' | 'other';
  title: string;
  description?: string;
  startTime: string | Date;
  endTime?: string | Date;
  allDay?: boolean;
  timezone?: string;
  location?: string;
  isVirtual?: boolean;
  meetingUrl?: string;
  status?: string;
  priority?: string;
  color?: string;
  recurrenceRule?: string;
  recurrenceId?: string;
  organizerId?: string;
  attendees?: { email: string; name?: string; status?: string; role?: string }[];
  reminders?: { type: 'email' | 'notification'; minutes: number }[];
  customerId?: string;
  contactId?: string;
  notes?: string;
  attachments?: string[];
  tags?: string[];
  customFields?: Record<string, unknown>;
  sourceType?: string;
  sourceId?: string;
  autoScheduled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Request body for creating / updating an event. `weldMeetingId` is not part of
 * the event itself: calendar-api uses it to link that WeldMeet meeting to the
 * event atomically, so it must never end up in a cached `CalendarEvent`.
 *
 * `location` also accepts `null`: on PATCH it is what clears the stored value
 * (an omitted / undefined field is left untouched).
 */
export type CalendarEventInput = Omit<Partial<CalendarEvent>, 'location'> & {
  weldMeetingId?: string;
  location?: string | null;
};

/**
 * `weldMeetingLinked` is only present when a `weldMeetingId` was sent;
 * `false` means the event saved but the meeting could not be linked to it.
 */
export interface CalendarEventSaveResult {
  id?: string;
  weldMeetingLinked?: boolean;
}

export interface BookingPage {
  id?: string;
  name: string;
  slug: string;
  description?: string;
  ownerId?: string;
  duration: number;
  bufferBefore?: number;
  bufferAfter?: number;
  color?: string;
  isActive?: boolean;
  /** `null` clears the stored value on update (PATCH skips `undefined`). */
  locationType?: 'in-person' | 'phone' | 'video' | null;
  locationValue?: string | null;
  availability: WeeklyAvailability;
  questions?: BookingQuestion[];
  /** Minutes of notice a guest needs before a slot (API default 60). */
  minNotice?: number;
  /** How many days ahead guests can book (API default 60). */
  maxAdvance?: number;
  /** Per-date availability that replaces the weekly hours for that date. */
  dateOverrides?: BookingDateOverride[] | null;
  /** Cap on bookings per day; `null` or 0 = unlimited. */
  maxBookingsPerDay?: number | null;
  confirmationMessage?: string;
  timezone?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** One date whose availability replaces the weekly hours. Empty `slots` = unavailable. */
export interface BookingDateOverride {
  /** YYYY-MM-DD in the page timezone. */
  date: string;
  slots: TimeRange[];
}

export interface WeeklyAvailability {
  monday: TimeRange[];
  tuesday: TimeRange[];
  wednesday: TimeRange[];
  thursday: TimeRange[];
  friday: TimeRange[];
  saturday: TimeRange[];
  sunday: TimeRange[];
}

export interface TimeRange {
  start: string; // "09:00"
  end: string;   // "17:00"
}

export interface BookingQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  required: boolean;
  options?: string[];
}

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface Booking {
  id?: string;
  bookingPageId: string;
  calendarEventId?: string;
  bookerName: string;
  bookerEmail: string;
  startTime: string;
  endTime: string;
  status?: string;
  answers?: Record<string, unknown>;
  notes?: string;
  createdAt?: string;
}

// ── Query Key Factories ─────────────────────────────────────────────────

export const userCalendarKeys = {
  all: ['user-calendars'] as const,
  list: () => [...userCalendarKeys.all, 'list'] as const,
  detail: (id: string) => [...userCalendarKeys.all, 'detail', id] as const,
  shares: (id: string) => [...userCalendarKeys.all, 'shares', id] as const,
  deleteImpact: (id: string) => [...userCalendarKeys.all, 'delete-impact', id] as const,
};

export const calendarKeys = {
  all: ['calendar'] as const,
  events: (filters?: Record<string, unknown>) => [...calendarKeys.all, 'events', filters] as const,
  eventsRange: (startDate?: string, endDate?: string, calendarIds?: string) => [...calendarKeys.all, 'events-range', startDate, endDate, calendarIds] as const,
  event: (id: string) => [...calendarKeys.all, 'event', id] as const,
  upcoming: (params?: Record<string, unknown>) => [...calendarKeys.all, 'upcoming', params] as const,
  search: (term: string, calendarIds?: string) => [...calendarKeys.all, 'search', term, calendarIds] as const,
};

const bookingPageKeys = {
  all: ['booking-pages'] as const,
  list: () => [...bookingPageKeys.all, 'list'] as const,
  detail: (id: string) => [...bookingPageKeys.all, 'detail', id] as const,
  slots: (id: string, date: string) => [...bookingPageKeys.all, 'slots', id, date] as const,
  deleteImpact: (id: string) => [...bookingPageKeys.all, 'delete-impact', id] as const,
};

// ── Helper ──────────────────────────────────────────────────────────────

function buildQueryString(params: Record<string, unknown>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      if (value instanceof Date) {
        queryParams.set(key, value.toISOString());
      } else {
        queryParams.set(key, asText(value));
      }
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}
export function useCalendarEventsRange(startDate?: string, endDate?: string, calendarIds?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: calendarKeys.eventsRange(startDate, endDate, calendarIds),
    queryFn: async () => {
      const client = await getClient();
      let url = `/calendar-events/range?startDate=${startDate}&endDate=${endDate}`;
      if (calendarIds) url += `&calendarIds=${calendarIds}`;
      return client.get<{ data: CalendarEvent[] }>(url);
    },
    enabled: !!startDate && !!endDate,
  });
}
/**
 * Server-side events search (title / description) across ALL dates, newest
 * first. The range query only knows the visible window, so the toolbar search
 * uses this to find events outside it.
 */
export function useSearchCalendarEvents(term: string, calendarIds?: string, limit = 50) {
  const { getClient } = useAppApiClient();
  const trimmed = term.trim();
  return useQuery({
    queryKey: calendarKeys.search(trimmed, calendarIds),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString({ search: trimmed, limit, calendarIds });
      return client.get<{ data: CalendarEvent[] }>(`/calendar-events${query}`);
    },
    enabled: trimmed.length >= 2,
    staleTime: 15_000,
  });
}

export function useUpcomingCalendarEvents(params?: { days?: number; limit?: number }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: calendarKeys.upcoming(params),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(params || {});
      return client.get<{ data: CalendarEvent[] }>(`/calendar-events/upcoming${query}`);
    },
  });
}

export function useCreateCalendarEvent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (event: CalendarEventInput) => {
      const client = await getClient();
      return client.post<{ data: CalendarEventSaveResult & { id: string } }>('/calendar-events', event);
    },
    // Optimistic insert: drop the new event into every cached events-range
    // query immediately so it takes the place of the inline-preview card the
    // moment the quick-create popover closes. Without this, the preview
    // disappears, the refetch fires, and the calendar shows a "hole" for
    // ~200–500ms before the real event arrives.
    onMutate: async (event) => {
      await qc.cancelQueries({ queryKey: [...calendarKeys.all, 'events-range'] });
      const optimisticId = `optimistic-${Date.now()}`;
      // `weldMeetingId` is request-only, keep it out of the cached event.
      const eventFields: CalendarEventInput = { ...event };
      delete eventFields.weldMeetingId;
      const optimisticEvent: CalendarEvent = {
        ...(eventFields as CalendarEvent),
        id: optimisticId,
        startTime: event.startTime as string,
        endTime: event.endTime as string | undefined,
      };
      const previous = qc.getQueriesData<{ data: CalendarEvent[] }>({
        queryKey: [...calendarKeys.all, 'events-range'],
      });
      qc.setQueriesData<{ data: CalendarEvent[] }>(
        { queryKey: [...calendarKeys.all, 'events-range'] },
        (old) => {
          if (!old?.data) return old;
          return { ...old, data: [...old.data, optimisticEvent] };
        },
      );
      return { previous, optimisticId };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      for (const [key, data] of context.previous) {
        qc.setQueryData(key, data);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
    },
  });
}

export function useUpdateCalendarEvent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data, sendNotification }: { id: string; data: CalendarEventInput; sendNotification?: boolean }) => {
      const client = await getClient();
      // `sendNotification=true` is what drives the attendee mail server-side —
      // it is the "notify attendees?" dialog's answer.
      const qs = sendNotification ? '?sendNotification=true' : '';
      // app-api patches events; the legacy worker used PUT.
      return client.patch<{ data: CalendarEventSaveResult }>(`/calendar-events/${id}${qs}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
      // The server syncs / cancels the linked WeldMeet meeting on update.
      qc.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useDeleteCalendarEvent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sendNotification }: { id: string; sendNotification?: boolean }) => {
      const client = await getClient();
      const qs = sendNotification ? '?sendNotification=true' : '';
      return client.delete<Record<string, never>>(`/calendar-events/${id}${qs}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
      // The server cancels the linked WeldMeet meeting on delete.
      qc.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useRescheduleCalendarEvent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      startTime,
      endTime,
      manual,
      notifyAttendees,
    }: {
      id: string;
      startTime: string;
      endTime?: string;
      /** When true, sets autoScheduled=false on the event and pins tasks.startDate */
      manual?: boolean;
      /**
       * Whether calendar-api emails the attendees about the move. Left out it
       * means "yes" (the server default); pass false for a silent move.
       */
      notifyAttendees?: boolean;
    }) => {
      const client = await getClient();
      return client.patch<{ data: unknown }>(`/calendar-events/${id}/reschedule`, {
        startTime,
        endTime,
        ...(manual ? { manual: true } : {}),
        ...(notifyAttendees === undefined ? {} : { notifyAttendees }),
      });
    },
    onMutate: async ({ id, startTime, endTime, manual }) => {
      // Cancel in-flight fetches so they don't overwrite optimistic update
      await qc.cancelQueries({ queryKey: calendarKeys.all });

      // Optimistically patch every cached events-range query
      qc.setQueriesData<{ data: CalendarEvent[] }>(
        { queryKey: [...calendarKeys.all, 'events-range'] },
        (old) => {
          if (!old?.data) return old;
          return {
            ...old,
            data: old.data.map((evt) =>
              evt.id === id
                ? {
                    ...evt,
                    startTime,
                    ...(endTime ? { endTime } : {}),
                    // Optimistically reflect the pin state so the icon updates immediately
                    ...(manual ? { autoScheduled: false } : {}),
                  }
                : evt,
            ),
          };
        },
      );
    },
    // A failed move must not leave the optimistic position on the grid.
    onError: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
      // The server moves the linked WeldMeet meeting along with the event.
      qc.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useUnpinCalendarEvent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: { id: string; autoScheduled: boolean } }>(`/calendar-events/${id}/unpin`, {});
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: calendarKeys.all });
      // Optimistically flip autoScheduled back to true
      qc.setQueriesData<{ data: CalendarEvent[] }>(
        { queryKey: [...calendarKeys.all, 'events-range'] },
        (old) => {
          if (!old?.data) return old;
          return {
            ...old,
            data: old.data.map((evt) =>
              evt.id === id ? { ...evt, autoScheduled: true } : evt,
            ),
          };
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
    },
  });
}
// ── Booking Page Hooks (app-api /api/booking-pages) ─────────────────────

export function useBookingPages(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: bookingPageKeys.list(),
    queryFn: async () => {
      const client = await getClient();
      // Callers read `.data`; the extra `pagination` key is harmless.
      return client.get<{ data: BookingPage[] }>('/booking-pages?limit=100');
    },
    enabled,
  });
}

export function useBookingPage(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: bookingPageKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: BookingPage }>(`/booking-pages/${id}`);
    },
    enabled: !!id,
  });
}

export function useCreateBookingPage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<BookingPage>) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/booking-pages', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bookingPageKeys.all });
    },
  });
}

export function useUpdateBookingPage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<BookingPage> }) => {
      const client = await getClient();
      // app-api patches booking pages; the legacy worker used PUT.
      return client.patch<{ data: { id: string } }>(`/booking-pages/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bookingPageKeys.all });
    },
  });
}

/** How many upcoming bookings a booking page still has, shown before it is deleted. */
export function useBookingPageDeleteImpact(id: string | null) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: bookingPageKeys.deleteImpact(id ?? ''),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: { upcomingBookingCount: number } }>(`/booking-pages/${id}/delete-impact`);
    },
    enabled: !!id,
    // Bookings come in while the dialog is closed; always re-count when it opens.
    staleTime: 0,
    meta: { persist: false },
  });
}

/** Flips a booking page between active and inactive (the public link stops working while inactive). */
export function useToggleBookingPage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ data: { id: string; isActive: boolean } }>(`/booking-pages/${id}/toggle`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bookingPageKeys.all });
    },
  });
}

export function useDeleteBookingPage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/booking-pages/${id}`);
    },
    onSuccess: (_result, id) => {
      // The page is gone: drop its cached detail so an open view does not refetch a 404.
      qc.removeQueries({ queryKey: bookingPageKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bookingPageKeys.all });
    },
  });
}
export function useAvailableSlots(bookingPageId: string, date: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: bookingPageKeys.slots(bookingPageId, date),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: TimeSlot[] }>(`/booking-pages/${bookingPageId}/available-slots?date=${date}`);
    },
    enabled: !!bookingPageId && !!date,
    // Slot availability changes minute-by-minute as other people book; never
    // persist it across reloads — always fetch fresh.
    meta: { persist: false },
  });
}

// ── Booking Hooks ───────────────────────────────────────────────────────
//
// Removed in W5b. `useBookings` / `useCreateBooking` / `useCancelBooking` were
// module-private, unexported and unreferenced — the last three api-worker call
// sites in this file and pure dead weight. app-api's `/api/bookings` exists but
// its POST only inserts the booking row; the legacy handler also created the
// linked `calendarEvents` row, which is what makes a booking appear on the
// calendar. Whoever revives public booking must port that linkage into
// app-api's bookings route first — reinstating these hooks against the current
// route would compile and silently drop bookings off the calendar.

// ── User Calendar Hooks (app-api /api/calendars) ────────────────────────
//
// The list is share-aware server-side: it returns the caller's own calendars
// plus any shared with them, each annotated with `isOwn` + `permission`. The
// sidebar, event dialog and calendar view all gate on those two fields.

export function useUserCalendars(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userCalendarKeys.list(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: UserCalendar[] }>('/calendars');
    },
    enabled,
  });
}

export function useEnsureDefaultCalendar() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: UserCalendar }>('/calendars/ensure-default', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userCalendarKeys.all });
    },
  });
}

export function useCreateUserCalendar() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; description?: string; color?: string }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/calendars', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userCalendarKeys.all });
    },
  });
}

export function useUpdateUserCalendar() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; description?: string; color?: string } }) => {
      const client = await getClient();
      // app-api patches calendars; the legacy worker used PUT.
      return client.patch<{ data: { id: string } }>(`/calendars/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userCalendarKeys.all });
    },
  });
}

/** What deleting a calendar removes — feeds the delete confirmation dialog. */
export interface CalendarDeleteImpact {
  /** Every event in the calendar; all are deleted with it. */
  eventCount: number;
  /** Upcoming events with attendees, who can be mailed a cancellation. */
  eventsWithAttendees: number;
}

export function useCalendarDeleteImpact(calendarId: string | null) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userCalendarKeys.deleteImpact(calendarId ?? ''),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CalendarDeleteImpact }>(`/calendars/${calendarId}/delete-impact`);
    },
    enabled: !!calendarId,
    // Always re-count when the dialog opens: events may have changed since.
    staleTime: 0,
    meta: { persist: false },
  });
}

export function useDeleteUserCalendar() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, sendNotification }: { id: string; sendNotification?: boolean }) => {
      const client = await getClient();
      // Same flag as an event delete: mails a cancellation to the attendees of
      // the calendar's upcoming events. Its events are deleted either way.
      const qs = sendNotification ? '?sendNotification=true' : '';
      return client.delete<Record<string, never>>(`/calendars/${id}${qs}`);
    },
    onSuccess: () => {
      // Not the delete impact: re-counting a calendar that is gone only 404s.
      qc.invalidateQueries({
        queryKey: userCalendarKeys.all,
        predicate: (q) => q.queryKey[1] !== 'delete-impact',
      });
      qc.invalidateQueries({ queryKey: calendarKeys.all });
      // The server cancels the WeldMeet meetings linked to the deleted events.
      qc.invalidateQueries({ queryKey: weldmeetKeys.all });
    },
  });
}

export function useCalendarShares(calendarId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userCalendarKeys.shares(calendarId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CalendarShareRecord[] }>(`/calendars/${calendarId}/shares`);
    },
    enabled: !!calendarId,
  });
}

export function useShareCalendar() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ calendarId, sharedWithId, permission }: { calendarId: string; sharedWithId: string; permission: 'view' | 'edit' | 'manage' }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>(`/calendars/${calendarId}/share`, { sharedWithId, permission });
    },
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: userCalendarKeys.shares(variables.calendarId) });
    },
  });
}

export function useRemoveCalendarShare() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ calendarId, shareId }: { calendarId: string; shareId: string }) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/calendars/${calendarId}/share/${shareId}`);
    },
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: userCalendarKeys.shares(variables.calendarId) });
      qc.invalidateQueries({ queryKey: userCalendarKeys.all });
    },
  });
}
