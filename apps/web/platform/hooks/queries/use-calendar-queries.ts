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
  customFields?: Record<string, any>;
  sourceType?: string;
  sourceId?: string;
  autoScheduled?: boolean;
  createdAt?: string;
  updatedAt?: string;
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
  locationType?: 'in-person' | 'phone' | 'video';
  locationValue?: string;
  availability: WeeklyAvailability;
  questions?: BookingQuestion[];
  minNotice?: number;
  maxAdvance?: number;
  confirmationMessage?: string;
  timezone?: string;
  createdAt?: string;
  updatedAt?: string;
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
};

export const calendarKeys = {
  all: ['calendar'] as const,
  events: (filters?: Record<string, any>) => [...calendarKeys.all, 'events', filters] as const,
  eventsRange: (startDate?: string, endDate?: string, calendarIds?: string) => [...calendarKeys.all, 'events-range', startDate, endDate, calendarIds] as const,
  event: (id: string) => [...calendarKeys.all, 'event', id] as const,
  upcoming: (params?: Record<string, any>) => [...calendarKeys.all, 'upcoming', params] as const,
};

const bookingPageKeys = {
  all: ['booking-pages'] as const,
  list: () => [...bookingPageKeys.all, 'list'] as const,
  detail: (id: string) => [...bookingPageKeys.all, 'detail', id] as const,
  slots: (id: string, date: string) => [...bookingPageKeys.all, 'slots', id, date] as const,
};

// ── Helper ──────────────────────────────────────────────────────────────

function buildQueryString(params: Record<string, any>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      if (value instanceof Date) {
        queryParams.set(key, value.toISOString());
      } else {
        queryParams.set(key, String(value));
      }
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// ── Calendar Event Hooks (app-api /api/calendar-events) ─────────────────

function useCalendarEvents(filters?: {
  startDate?: string | Date;
  endDate?: string | Date;
  type?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  search?: string;
  calendarIds?: string;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: calendarKeys.events(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{ data: CalendarEvent[]; pagination?: any }>(`/calendar-events${query}`);
    },
  });
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

function useCalendarEvent(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: calendarKeys.event(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CalendarEvent }>(`/calendar-events/${id}`);
    },
    enabled: !!id,
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
    mutationFn: async (event: Partial<CalendarEvent>) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/calendar-events', event);
    },
    // Optimistic insert: drop the new event into every cached events-range
    // query immediately so it takes the place of the inline-preview card the
    // moment the quick-create popover closes. Without this, the preview
    // disappears, the refetch fires, and the calendar shows a "hole" for
    // ~200–500ms before the real event arrives.
    onMutate: async (event) => {
      await qc.cancelQueries({ queryKey: [...calendarKeys.all, 'events-range'] });
      const optimisticId = `optimistic-${Date.now()}`;
      const optimisticEvent: CalendarEvent = {
        ...(event as CalendarEvent),
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
    mutationFn: async ({ id, data, sendNotification }: { id: string; data: Partial<CalendarEvent>; sendNotification?: boolean }) => {
      const client = await getClient();
      // `sendNotification=true` is what drives the attendee mail server-side —
      // it is the "notify attendees?" dialog's answer.
      const qs = sendNotification ? '?sendNotification=true' : '';
      // app-api patches events; the legacy worker used PUT.
      return client.patch<{ data: any }>(`/calendar-events/${id}${qs}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
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
    }: {
      id: string;
      startTime: string;
      endTime?: string;
      /** When true, sets autoScheduled=false on the event and pins tasks.startDate */
      manual?: boolean;
    }) => {
      const client = await getClient();
      return client.patch<{ data: any }>(`/calendar-events/${id}/reschedule`, {
        startTime,
        endTime,
        ...(manual ? { manual: true } : {}),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
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

function useCancelCalendarEvent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ data: { id: string; status: string } }>(`/calendar-events/${id}/cancel`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
    },
  });
}

// ── Booking Page Hooks (app-api /api/booking-pages) ─────────────────────

export function useBookingPages() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: bookingPageKeys.list(),
    queryFn: async () => {
      const client = await getClient();
      // Callers read `.data`; the extra `pagination` key is harmless.
      return client.get<{ data: BookingPage[] }>('/booking-pages?limit=100');
    },
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

export function useDeleteBookingPage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/booking-pages/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bookingPageKeys.all });
    },
  });
}

/** Publish/unpublish. Expressed as a partial update — /toggle also exists. */
function useToggleBookingPage(currentIsActive?: boolean) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ data: { id: string } }>(`/booking-pages/${id}`, {
        isActive: !currentIsActive,
      });
    },
    onSuccess: () => {
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

export function useUserCalendars() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userCalendarKeys.list(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: UserCalendar[] }>('/calendars');
    },
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

export function useDeleteUserCalendar() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/calendars/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userCalendarKeys.all });
      qc.invalidateQueries({ queryKey: calendarKeys.all });
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
