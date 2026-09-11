/**
 * WeldCalendar row + payload types.
 *
 * Mirrors the columns `apps/workers/app-api/src/routes/calendar-events` and
 * `.../calendars` select (`packages/core/db/src/schema/calendar-events.ts`,
 * `calendars.ts`). Timestamps arrive as ISO strings over the wire even though
 * they are `Date` columns server-side.
 *
 * `isOwn` and `permission` on `Calendar` are DERIVED, not columns: the list
 * route joins `calendarShares` and annotates each row, so a calendar shared
 * with you comes back alongside your own with the access level attached.
 */

// ── Envelopes ────────────────────────────────────────────────────────────

export interface DataResponse<T> {
  data: T;
}

export interface ListResponse<T> {
  data: T[];
  pagination: {
    totalCount: number;
    hasMore: boolean;
    cursor: string | null;
  };
}

// ── Unions ───────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'meeting',
  'call',
  'appointment',
  'event',
  'reminder',
  'other',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type EventPriority = (typeof EVENT_PRIORITIES)[number];

/** view = read events · edit = create/modify · manage = edit + share + delete. */
export type CalendarPermission = 'view' | 'edit' | 'manage';

export type TenantKind = 'workspace' | 'personal';

// ── Rows ─────────────────────────────────────────────────────────────────

export interface Calendar {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  ownerId: string;
  isDefault: boolean | null;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
  /** Derived by the route: false for calendars shared with the caller. */
  isOwn: boolean;
  /** Derived by the route: always 'manage' for your own calendars. */
  permission: CalendarPermission;
  tenantKind?: TenantKind;
  workspaceName?: string | null;
  clerkOrgId?: string | null;
}

export interface EventAttendee {
  email: string;
  name?: string;
  status?: string;
  role?: string;
}

export interface EventReminder {
  type: 'email' | 'notification';
  minutes: number;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description: string | null;
  type: EventType;
  startTime: string;
  endTime: string | null;
  allDay: boolean | null;
  timezone: string | null;
  location: string | null;
  isVirtual: boolean | null;
  meetingUrl: string | null;
  status: EventStatus;
  priority: EventPriority | null;
  color: string | null;
  recurrenceRule: string | null;
  recurrenceId: string | null;
  organizerId: string;
  attendees: EventAttendee[] | null;
  reminders: EventReminder[] | null;
  customerId: string | null;
  contactId: string | null;
  /** Set when the event was auto-scheduled from a task or CRM activity. */
  sourceType: 'task' | 'activity' | null;
  sourceId: string | null;
  autoScheduled: boolean | null;
  notes: string | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
  tenantKind?: TenantKind;
  clerkOrgId?: string | null;
}

export interface CalendarShare {
  id: string;
  calendarId: string;
  sharedWithId: string;
  sharedById: string;
  permission: CalendarPermission;
  createdAt: string;
}

// ── Queries ──────────────────────────────────────────────────────────────

export interface ListEventsQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  type?: EventType;
  status?: EventStatus;
  startDate?: string;
  endDate?: string;
  /** Comma-separated calendar ids; the route narrows to what you may read. */
  calendarIds?: string;
}

export interface RangeQuery {
  startDate: string;
  endDate: string;
  calendarIds?: string;
}

// ── Payloads ─────────────────────────────────────────────────────────────

export interface CreateEventInput {
  calendarId: string;
  title: string;
  description?: string;
  type?: EventType;
  /** ISO string. Required — the column is NOT NULL. */
  startTime: string;
  endTime?: string;
  allDay?: boolean;
  timezone?: string;
  location?: string;
  isVirtual?: boolean;
  meetingUrl?: string;
  status?: EventStatus;
  priority?: EventPriority;
  color?: string;
  attendees?: EventAttendee[];
  reminders?: EventReminder[];
  notes?: string;
  tags?: string[];
}

/**
 * `calendarId` is deliberately absent: the route's update schema omits it, so
 * an event cannot be moved between calendars through PATCH. Sending it anyway
 * would be silently stripped server-side.
 */
export type UpdateEventInput = Partial<Omit<CreateEventInput, 'calendarId'>>;

export interface CreateCalendarInput {
  name: string;
  description?: string;
  color?: string;
}

export type UpdateCalendarInput = Partial<CreateCalendarInput>;
