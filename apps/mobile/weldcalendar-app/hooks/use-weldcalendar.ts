import { useOrganization } from '@clerk/expo';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createMergedCalendar,
  createMergedEvent,
  deleteMergedEvent,
  ensureMergedDefaults,
  getMergedEvent,
  listMergedCalendars,
  listMergedEventsInRange,
  updateMergedEvent,
  type TenantKind,
} from '@/services/calendar-tenant';
import type {
  CreateCalendarInput,
  CreateEventInput,
  RangeQuery,
  UpdateEventInput,
} from '@/types/weldcalendar';

export const qk = {
  all: ['weldcalendar'] as const,
  calendars: () => ['weldcalendar', 'calendars'] as const,
  eventsInRange: (params: RangeQuery) => ['weldcalendar', 'events-range', params] as const,
  event: (id: string) => ['weldcalendar', 'event', id] as const,
};

// ── Calendars ──────────────────────────────────────────────────────────────

export function useCalendars() {
  const { organization } = useOrganization();
  return useQuery({
    queryKey: [...qk.calendars(), organization?.id ?? 'personal'],
    queryFn: () =>
      listMergedCalendars({
        clerkOrgId: organization?.id ?? null,
        workspaceName: organization?.name ?? null,
      }),
  });
}

export function useCreateCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      tenantKind,
      ...data
    }: CreateCalendarInput & { tenantKind?: TenantKind }) =>
      createMergedCalendar(data, tenantKind ?? 'personal'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.calendars() });
    },
  });
}

/**
 * Creates the signed-in user's personal "My Calendar" and, when an org is
 * active, the workspace default as well.
 *
 * A workspace member who has never opened WeldCalendar on the web has zero
 * workspace calendars, and a calendar-only consumer has zero personal ones —
 * so the Calendars tab calls this rather than showing an empty state the user
 * cannot act on.
 */
export function useEnsureDefaultCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ensureMergedDefaults(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.calendars() });
    },
  });
}

// ── Events ─────────────────────────────────────────────────────────────────

/**
 * Events starting inside a window. `enabled` lets a screen hold the request
 * until it knows which calendars are visible, so the grid never flashes the
 * unfiltered set first. Personal and workspace ranges are fetched in parallel
 * and merged client-side.
 */
export function useEventsInRange(params: RangeQuery, enabled = true) {
  const { organization } = useOrganization();
  return useQuery({
    queryKey: [...qk.eventsInRange(params), organization?.id ?? 'personal'],
    queryFn: () =>
      listMergedEventsInRange(params, { clerkOrgId: organization?.id ?? null }),
    enabled: enabled && !!params.startDate && !!params.endDate,
  });
}

export function useEvent(eventId: string) {
  const { organization } = useOrganization();
  return useQuery({
    queryKey: qk.event(eventId),
    queryFn: () => getMergedEvent(eventId, { clerkOrgId: organization?.id ?? null }),
    enabled: !!eventId,
  });
}

export function useCreateEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateEventInput) => createMergedEvent(data),
    onSuccess: () => {
      // Every range window is now stale — a new event can land in any of them.
      queryClient.invalidateQueries({ queryKey: qk.all });
    },
  });
}

export function useUpdateEvent(eventId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      sendNotification,
    }: {
      data: UpdateEventInput;
      sendNotification?: boolean;
    }) => updateMergedEvent(eventId, data, sendNotification),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.all });
    },
  });
}

export function useDeleteEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sendNotification }: { id: string; sendNotification?: boolean }) =>
      deleteMergedEvent(id, sendNotification),
    onSuccess: (_result, variables) => {
      queryClient.removeQueries({ queryKey: qk.event(variables.id) });
      queryClient.invalidateQueries({ queryKey: qk.all });
    },
  });
}
