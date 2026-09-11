/**
 * app-api client for WeldCalendar mobile.
 *
 * Wires the app to the unified app-api (`/api`) — the same backend the
 * platform's WeldCalendar module uses, so an event created here shows up in
 * the web grid without a sync step. A module-level token getter is wired from
 * `app/_layout.tsx` using Clerk credentials (see `setAppApiTokenGetter`); the
 * client re-reads the token on every request, so no rebuild is needed when it
 * refreshes.
 *
 * Route map:
 *
 *   listCalendars/create/update/…   → /api/calendars
 *   ensureDefaultCalendar           → /api/calendars/ensure-default
 *   listEvents                      → /api/calendar-events        (cursor-paginated)
 *   listEventsInRange               → /api/calendar-events/range  (un-paginated)
 *   get/create/update/deleteEvent   → /api/calendar-events[/:id]
 *   cancelEvent                     → /api/calendar-events/:id/cancel
 *
 * `/range` returns a bare `{ data }` — deliberately un-paginated, because the
 * grid and the agenda each need a whole window at once.
 *
 * `/calendar-events/upcoming` is intentionally NOT wrapped: it filters
 * `startTime >= now` and `status = 'confirmed'`, so it drops the meeting you
 * are sitting in and every tentative hold. The agenda uses `/range` from the
 * start of today instead, which also honours the `calendarIds` visibility
 * filter that `/upcoming` does not accept.
 *
 * Responses use the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and the client THROWS on non-2xx
 * (204 → `{}`).
 */

import { createClientApi, buildQueryString } from '@weldsuite/api-client/client';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import type {
  Calendar,
  CalendarEvent,
  CalendarShare,
  CreateCalendarInput,
  CreateEventInput,
  DataResponse,
  ListEventsQuery,
  ListResponse,
  RangeQuery,
  UpdateCalendarInput,
  UpdateEventInput,
} from '@/types/weldcalendar';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

const client = createClientApi({
  baseUrl: APP_API_URL,
  getToken: () => tokenGetter(),
});

const weldcalendar = {
  // ── Calendars ──────────────────────────────────────────────────────────

  /** Own calendars ∪ calendars shared with you, each annotated with access. */
  listCalendars(): Promise<ListResponse<Calendar>> {
    return client.get<ListResponse<Calendar>>('/calendars');
  },

  getCalendar(id: string): Promise<DataResponse<Calendar>> {
    return client.get<DataResponse<Calendar>>(`/calendars/${id}`);
  },

  /**
   * Creates "My Calendar" if the signed-in user has none. 201 on create,
   * 200 when one already existed — both return the calendar.
   */
  ensureDefaultCalendar(): Promise<DataResponse<Calendar>> {
    return client.post<DataResponse<Calendar>>('/calendars/ensure-default', {});
  },

  createCalendar(data: CreateCalendarInput): Promise<DataResponse<Calendar>> {
    return client.post<DataResponse<Calendar>>('/calendars', data);
  },

  updateCalendar(id: string, data: UpdateCalendarInput): Promise<DataResponse<Calendar>> {
    return client.patch<DataResponse<Calendar>>(`/calendars/${id}`, data);
  },

  deleteCalendar(id: string): Promise<void> {
    return client.delete<void>(`/calendars/${id}`);
  },

  listCalendarShares(id: string): Promise<{ data: CalendarShare[] }> {
    return client.get<{ data: CalendarShare[] }>(`/calendars/${id}/shares`);
  },

  // ── Events ─────────────────────────────────────────────────────────────

  listEvents(params: ListEventsQuery = { limit: 50 }): Promise<ListResponse<CalendarEvent>> {
    return client.get<ListResponse<CalendarEvent>>(
      `/calendar-events${buildQueryString(params as Record<string, unknown>)}`,
    );
  },

  /** Everything overlapping the window. Un-paginated — feeds the month grid. */
  listEventsInRange(params: RangeQuery): Promise<{ data: CalendarEvent[] }> {
    return client.get<{ data: CalendarEvent[] }>(
      `/calendar-events/range${buildQueryString({ ...params })}`,
    );
  },

  getEvent(id: string): Promise<DataResponse<CalendarEvent>> {
    return client.get<DataResponse<CalendarEvent>>(`/calendar-events/${id}`);
  },

  /** Attendees are always emailed an invite on create (route behaviour). */
  createEvent(data: CreateEventInput): Promise<DataResponse<CalendarEvent>> {
    return client.post<DataResponse<CalendarEvent>>('/calendar-events', data);
  },

  /**
   * `sendNotification` drives the "notify attendees?" mail — the route only
   * sends a reschedule/update mail when it is true.
   */
  updateEvent(
    id: string,
    data: UpdateEventInput,
    sendNotification = false,
  ): Promise<DataResponse<CalendarEvent>> {
    const query = sendNotification ? '?sendNotification=true' : '';
    return client.patch<DataResponse<CalendarEvent>>(`/calendar-events/${id}${query}`, data);
  },

  /** Soft-delete. Pass `sendNotification` to mail attendees a cancellation. */
  deleteEvent(id: string, sendNotification = false): Promise<void> {
    const query = sendNotification ? '?sendNotification=true' : '';
    return client.delete<void>(`/calendar-events/${id}${query}`);
  },

  /** Keeps the row but flips it to `cancelled`; always mails attendees. */
  cancelEvent(id: string): Promise<DataResponse<CalendarEvent>> {
    return client.patch<DataResponse<CalendarEvent>>(`/calendar-events/${id}/cancel`, {});
  },
};

export const appApi = {
  weldcalendar,
  pushTokens: createPushTokensApi(client),
  notifications: createNotificationsApi(client),
  workspaces: createWorkspacesApi(client),
};

/**
 * Raw client for surfaces without a dedicated wrapper yet. Returns the same
 * `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
