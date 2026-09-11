/**
 * Tenant-aware calendar helpers.
 *
 * Workspace calendars live on app-api (org-scoped JWT). Personal calendars
 * live on personal-api (user-scoped; org claim is ignored). The UI treats
 * both as one list; this module picks the right client.
 */

import type { Calendar as PersonalCalendar, CalendarEvent as PersonalEvent } from '@weldsuite/personal-api-client';
import { appApi } from '@/services/app-api';
import { personalApi } from '@/services/personal-api';
import type {
  Calendar,
  CalendarEvent,
  CreateCalendarInput,
  CreateEventInput,
  ListResponse,
  RangeQuery,
  UpdateEventInput,
} from '@/types/weldcalendar';

export type TenantKind = 'workspace' | 'personal';

const personalCalendarIds = new Set<string>();
const personalEventIds = new Set<string>();

export function rememberPersonalCalendars(ids: string[]): void {
  personalCalendarIds.clear();
  for (const id of ids) personalCalendarIds.add(id);
}

export function rememberPersonalEvents(ids: string[]): void {
  for (const id of ids) personalEventIds.add(id);
}

export function isPersonalCalendarId(id?: string | null): boolean {
  return !!id && personalCalendarIds.has(id);
}

export function isPersonalEventId(id?: string | null): boolean {
  return !!id && personalEventIds.has(id);
}

function asIso(value: string | Date | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizePersonalCalendar(row: PersonalCalendar): Calendar {
  rememberPersonalCalendars([row.id]);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    color: row.color ?? null,
    ownerId: row.ownerId,
    isDefault: row.isDefault ?? false,
    isActive: row.isActive ?? true,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
    isOwn: true,
    permission: 'manage',
    tenantKind: 'personal',
    workspaceName: 'Personal',
  };
}

function normalizePersonalEvent(row: PersonalEvent): CalendarEvent {
  rememberPersonalEvents([row.id]);
  return {
    id: row.id,
    calendarId: row.calendarId,
    title: row.title,
    description: row.description ?? null,
    type: (row.type as CalendarEvent['type']) || 'event',
    startTime: asIso(row.startTime),
    endTime: row.endTime ? asIso(row.endTime) : null,
    allDay: row.allDay ?? false,
    timezone: row.timezone ?? null,
    location: row.location ?? null,
    isVirtual: row.isVirtual ?? false,
    meetingUrl: row.meetingUrl ?? null,
    status: (row.status as CalendarEvent['status']) || 'confirmed',
    priority: (row.priority as CalendarEvent['priority']) ?? 'normal',
    color: row.color ?? null,
    recurrenceRule: row.recurrenceRule ?? null,
    recurrenceId: row.recurrenceId ?? null,
    organizerId: row.organizerId,
    attendees: row.attendees ?? null,
    reminders: row.reminders ?? null,
    customerId: null,
    contactId: null,
    sourceType: null,
    sourceId: null,
    autoScheduled: null,
    notes: row.notes ?? null,
    tags: row.tags ?? null,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
    tenantKind: 'personal',
  };
}

function splitCalendarIds(requested?: string): { personal: string; workspace: string } {
  if (!requested) {
    return { personal: '', workspace: '' };
  }
  const ids = requested.split(',').map((s) => s.trim()).filter(Boolean);
  const personal = ids.filter((id) => personalCalendarIds.has(id));
  const workspace = ids.filter((id) => !personalCalendarIds.has(id));
  return { personal: personal.join(','), workspace: workspace.join(',') };
}

export async function listMergedCalendars(opts?: {
  clerkOrgId?: string | null;
  workspaceName?: string | null;
}): Promise<ListResponse<Calendar>> {
  const personalPromise = personalApi.calendars
    .list()
    .then((res) => res.data.map(normalizePersonalCalendar))
    .catch(() => [] as Calendar[]);

  const workspacePromise = appApi.weldcalendar
    .listCalendars()
    .then((res) =>
      res.data.map((cal) => ({
        ...cal,
        tenantKind: 'workspace' as const,
        clerkOrgId: opts?.clerkOrgId ?? null,
        workspaceName: opts?.workspaceName ?? null,
      })),
    )
    .catch(() => [] as Calendar[]);

  const [personal, workspace] = await Promise.all([personalPromise, workspacePromise]);
  rememberPersonalCalendars(personal.map((c) => c.id));
  const data = [...personal, ...workspace];
  return {
    data,
    pagination: { totalCount: data.length, hasMore: false, cursor: null },
  };
}

export async function listMergedEventsInRange(
  params: RangeQuery,
  opts?: { clerkOrgId?: string | null },
): Promise<{ data: CalendarEvent[] }> {
  const split = splitCalendarIds(params.calendarIds);
  const wantPersonal = !params.calendarIds || !!split.personal;
  const wantWorkspace = !params.calendarIds || !!split.workspace;

  const personalPromise = wantPersonal
    ? personalApi.calendarEvents
        .range({
          startDate: params.startDate,
          endDate: params.endDate,
          calendarIds: split.personal || undefined,
        })
        .then((res) => res.data.map(normalizePersonalEvent))
        .catch(() => [] as CalendarEvent[])
    : Promise.resolve([] as CalendarEvent[]);

  const workspacePromise = wantWorkspace
    ? appApi.weldcalendar
        .listEventsInRange({
          startDate: params.startDate,
          endDate: params.endDate,
          calendarIds: split.workspace || undefined,
        })
        .then((res) =>
          res.data.map((event) => ({
            ...event,
            tenantKind: 'workspace' as const,
            clerkOrgId: opts?.clerkOrgId ?? null,
          })),
        )
        .catch(() => [] as CalendarEvent[])
    : Promise.resolve([] as CalendarEvent[]);

  const [personal, workspace] = await Promise.all([personalPromise, workspacePromise]);
  const data = [...personal, ...workspace].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );
  return { data };
}

export async function getMergedEvent(
  id: string,
  opts?: { clerkOrgId?: string | null },
): Promise<{ data: CalendarEvent }> {
  if (isPersonalEventId(id)) {
    const { data } = await personalApi.calendarEvents.get(id);
    return { data: normalizePersonalEvent(data) };
  }
  try {
    const { data } = await appApi.weldcalendar.getEvent(id);
    return { data: { ...data, tenantKind: 'workspace', clerkOrgId: opts?.clerkOrgId ?? null } };
  } catch {
    const { data } = await personalApi.calendarEvents.get(id);
    return { data: normalizePersonalEvent(data) };
  }
}

export async function createMergedEvent(input: CreateEventInput): Promise<{ data: { id: string } }> {
  if (isPersonalCalendarId(input.calendarId)) {
    return personalApi.calendarEvents.create(input);
  }
  const created = await appApi.weldcalendar.createEvent(input);
  return { data: { id: created.data.id } };
}

export async function updateMergedEvent(
  id: string,
  data: UpdateEventInput,
  sendNotification?: boolean,
): Promise<{ data: unknown }> {
  if (isPersonalEventId(id)) {
    return personalApi.calendarEvents.update(id, data);
  }
  return appApi.weldcalendar.updateEvent(id, data, sendNotification);
}

export async function deleteMergedEvent(id: string, sendNotification?: boolean): Promise<void> {
  if (isPersonalEventId(id)) {
    await personalApi.calendarEvents.delete(id);
    return;
  }
  await appApi.weldcalendar.deleteEvent(id, sendNotification);
}

export async function createMergedCalendar(
  data: CreateCalendarInput,
  tenantKind: TenantKind = 'personal',
): Promise<{ data: { id: string } }> {
  if (tenantKind === 'workspace') {
    const created = await appApi.weldcalendar.createCalendar(data);
    return { data: { id: created.data.id } };
  }
  return personalApi.calendars.create(data);
}

export async function ensureMergedDefaults(): Promise<void> {
  await personalApi.calendars.ensureDefault();
  await appApi.weldcalendar.ensureDefaultCalendar().catch(() => {});
}
