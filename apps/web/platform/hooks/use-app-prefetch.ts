import { useCallback, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { crmTasksKeys } from '@/hooks/use-crm-tasks';
import { mailKeys } from '@/hooks/queries/use-mail-queries';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { weldmeetKeys } from '@/hooks/queries/use-weldmeet-queries';
import {
  calendarKeys,
  userCalendarKeys,
  type CalendarEvent,
  type UserCalendar,
} from '@/hooks/queries/use-calendar-queries';
import { getCalendarDateRange, type CalendarView } from '@/app/weldcalendar/lib/date-range';
import { getActiveCalendarIds } from '@/app/weldcalendar/components/calendar-sidebar-section';

// Warm the TanStack Query cache for an app's landing query the moment the
// user hovers its sidebar icon. By the time they click, the data is already
// in the cache and the page paints on the first frame.
//
// We only wire up the apps whose landing query is a single straightforward
// REST call. Apps with infinite queries, typed-API-domain clients, or
// data-less landing pages are skipped intentionally — the global persister
// already covers warm reloads for them, and route-bundle preload on hover
// handles the cold-load JS-parse hit.
//
// Each prefetcher mirrors its hook's queryKey + queryFn exactly. If a hook
// changes its key or URL, update the matching entry here.

const HOVER_DEBOUNCE_MS = 120;
// Don't re-fire if we prefetched the same app in the last minute. This is
// short enough that real updates still come through on click (the actual
// useQuery refetches per its own staleTime), but long enough to absorb
// hover-jitter as the user moves across icons.
const PREFETCH_STALE_TIME_MS = 60 * 1000;

interface PrefetchContext {
  queryClient: QueryClient;
  appClient: () => Promise<{ get: <T>(url: string) => Promise<T> }>;
  userId: string | undefined;
}

type Prefetcher = (ctx: PrefetchContext) => Promise<unknown> | void;

const PREFETCHERS: Record<string, Prefetcher> = {
  weldcrm: ({ queryClient, appClient, userId }) => {
    if (!userId) return;
    return queryClient.prefetchQuery({
      queryKey: [...crmTasksKeys.list(), userId],
      // Must match useCrmTasks' queryFn exactly — it returns a hydrated array,
      // not the raw `{ data }` envelope. Caching the envelope here breaks
      // consumers that iterate the result as an array.
      queryFn: async () => {
        const client = await appClient();
        const params = new URLSearchParams({ assigneeId: userId, crmLinked: 'true' });
        const res = await client.get<{ data: any[] }>(`/tasks?${params.toString()}`);
        return (res.data ?? []).map((task: any) => ({
          ...task,
          dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
          createdAt: new Date(task.createdAt),
          completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
        }));
      },
      staleTime: PREFETCH_STALE_TIME_MS,
    });
  },

  weldmail: ({ queryClient, appClient }) =>
    queryClient.prefetchQuery({
      queryKey: mailKeys.accounts(),
      queryFn: async () => {
        const client = await appClient();
        return client.get<{ data: any[] }>('/mail-accounts');
      },
      staleTime: PREFETCH_STALE_TIME_MS,
    }),

  weldchat: ({ queryClient, appClient }) =>
    queryClient.prefetchQuery({
      queryKey: weldchatKeys.channels(),
      queryFn: async () => {
        const client = await appClient();
        return client.get<any>('/channels');
      },
      staleTime: PREFETCH_STALE_TIME_MS,
    }),

  weldmeet: ({ queryClient, appClient }) => {
    const params = { days: 7, limit: 3 };
    return queryClient.prefetchQuery({
      queryKey: weldmeetKeys.upcoming(params),
      queryFn: async () => {
        const client = await appClient();
        const qs = `?days=${params.days}&limit=${params.limit}`;
        const res = await client.get<{ data: any[] }>(`/meetings/upcoming${qs}`);
        return (res as any).data ?? [];
      },
      staleTime: PREFETCH_STALE_TIME_MS,
    });
  },

  weldcalendar: async ({ queryClient, appClient }) => {
    // Two queries fire on the calendar landing page: user-calendars (the
    // sidebar list + color map) and events-range (the actual events for the
    // current view's date range). Prefetch both so the page paints with
    // events on the first frame.
    //
    // The events-range query key includes `calendarIds` (comma-joined,
    // derived from getActiveCalendarIds at render time). If the calendars
    // list isn't cached yet, we can't know which ids the calendar will
    // ultimately filter by — so we fetch the calendars first and use the
    // result to build the same key the page will use.
    const calendarsQueryKey = userCalendarKeys.list();
    await queryClient.prefetchQuery({
      queryKey: calendarsQueryKey,
      queryFn: async () => {
        const client = await appClient();
        return client.get<{ data: UserCalendar[] }>('/calendars');
      },
      staleTime: PREFETCH_STALE_TIME_MS,
    });

    const cachedCalendars = queryClient.getQueryData<{ data: UserCalendar[] }>(calendarsQueryKey);
    const activeIds = cachedCalendars?.data ? getActiveCalendarIds(cachedCalendars.data) : [];
    const calendarIdsParam = activeIds.length > 0 ? activeIds.join(',') : undefined;

    // Match CalendarView's defaults: currentDate is `new Date()` at mount;
    // currentView reads `weldcalendar:view` from localStorage and falls back
    // to 'month'.
    let view: CalendarView = 'month';
    try {
      const stored = window.localStorage.getItem('weldcalendar:view');
      if (stored && ['month', 'week', '4day', 'day', 'year', 'schedule'].includes(stored)) {
        view = stored as CalendarView;
      }
    } catch {
      // fall back to month
    }
    const { start, end } = getCalendarDateRange(new Date(), view);

    return queryClient.prefetchQuery({
      queryKey: calendarKeys.eventsRange(start, end, calendarIdsParam),
      queryFn: async () => {
        const client = await appClient();
        let url = `/calendar-events/range?startDate=${start}&endDate=${end}`;
        if (calendarIdsParam) url += `&calendarIds=${calendarIdsParam}`;
        return client.get<{ data: CalendarEvent[] }>(url);
      },
      staleTime: PREFETCH_STALE_TIME_MS,
    });
  },
};

/**
 * Returns a debounced `prefetch(appCode)` to call from a sidebar icon's
 * `onMouseEnter`. Safe to call for any appCode — unknown apps no-op.
 */
export function useAppPrefetch() {
  const queryClient = useQueryClient();
  const { getClient: appClient } = useAppApiClient();
  const { user } = useUser();
  const userId = user?.id;

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastFired = useRef<Record<string, number>>({});

  const prefetch = useCallback((appCode: string) => {
    const fn = PREFETCHERS[appCode];
    if (!fn) return;

    const existing = timers.current[appCode];
    if (existing) clearTimeout(existing);

    timers.current[appCode] = setTimeout(() => {
      const now = Date.now();
      if (now - (lastFired.current[appCode] ?? 0) < PREFETCH_STALE_TIME_MS) return;
      lastFired.current[appCode] = now;
      try {
        fn({ queryClient, appClient, userId });
      } catch {
        // Prefetch failures are non-fatal — the real hook will fetch on click.
      }
    }, HOVER_DEBOUNCE_MS);
  }, [queryClient, appClient, userId]);

  const cancel = useCallback((appCode: string) => {
    const t = timers.current[appCode];
    if (t) {
      clearTimeout(t);
      delete timers.current[appCode];
    }
  }, []);

  return { prefetch, cancel };
}
