/**
 * WeldDesk reports on the live inbox (ADR DESK-011):
 * `GET /api/helpdesk-analytics/overview?range=`. The chart data of saved
 * reports goes through `/helpdesk-analytics/charts/batch-data` in the report
 * view itself.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { helpdeskWorkerApi } from '@/lib/api/domains/welddesk';
import { saveResponseAsFile } from '@/lib/download-response';
import type {
  CreateHelpdeskReportScheduleInput,
  UpdateHelpdeskReportScheduleInput,
} from '@weldsuite/core-api-client/schemas/helpdesk-analytics';

/** The ranges the overview offers (desk-api accepts more; the builder uses those). */
export const DESK_OVERVIEW_RANGES = [
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_month',
  'this_quarter',
  'this_year',
] as const;

export type DeskOverviewRange = (typeof DESK_OVERVIEW_RANGES)[number];

export interface DeskReportPair<T> {
  value: T;
  previous: T;
}

export interface DeskReportPerson {
  id: string | null;
  name: string;
  created: number;
  resolved: number;
  /** Seconds. */
  firstResponseAvg: number | null;
  /** Seconds. */
  resolutionAvg: number | null;
  ratings: number;
  /** Percent of ratings that were 4 or 5. */
  csat: number | null;
}

export interface DeskReportsOverview {
  range: { key: string; start: string; end: string; bucket: 'day' | 'week' | 'month' };
  kpis: {
    created: DeskReportPair<number>;
    resolved: DeskReportPair<number>;
    firstResponseAvg: DeskReportPair<number | null>;
    firstResponseMedian: DeskReportPair<number | null>;
    resolutionAvg: DeskReportPair<number | null>;
    resolutionMedian: DeskReportPair<number | null>;
    slaCompliance: DeskReportPair<number | null>;
    csat: DeskReportPair<number | null>;
  };
  backlog: { open: number; unassigned: number; waiting: number };
  counts: {
    firstResponses: number;
    resolutions: number;
    slaMet: number;
    slaBreached: number;
    ratings: number;
    ratingAverage: number | null;
  };
  series: Array<{
    label: string;
    created: number;
    resolved: number;
    firstResponseAvg: number | null;
    resolutionAvg: number | null;
  }>;
  byChannel: Array<{ key: string; count: number }>;
  byPriority: Array<{ key: string; count: number }>;
  agents: DeskReportPerson[];
  teams: DeskReportPerson[];
}

export const deskReportKeys = {
  all: ['helpdesk', 'reports'] as const,
  overview: (range: string) => [...deskReportKeys.all, 'overview', range] as const,
};

export function useDeskReportsOverview(range: DeskOverviewRange) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskReportKeys.overview(range),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskReportsOverview }>(
        `/helpdesk-analytics/overview?range=${encodeURIComponent(range)}`,
      );
      return res.data;
    },
    // Live data, but a team lead doesn't need it to the second.
    staleTime: 60_000,
  });
}

// ── Phone report (TASK-1229) ────────────────────────────────────────────────

export const deskPhoneReportKeys = {
  report: (range: string) => [...deskReportKeys.all, 'phone', range] as const,
};

/** Call KPIs for a period (settings:read). */
export function useDeskPhoneReport(range: DeskOverviewRange) {
  return useQuery({
    queryKey: deskPhoneReportKeys.report(range),
    queryFn: () => helpdeskWorkerApi.getPhoneReport(range),
    staleTime: 60_000,
  });
}

// ── Wallboard (TASK-1230) ───────────────────────────────────────────────────

/** How often the wallboard refetches on its own. */
export const DESK_WALLBOARD_REFRESH_MS = 15_000;

export const deskWallboardKeys = {
  board: (teamId: string | null) => [...deskReportKeys.all, 'wallboard', teamId ?? 'all'] as const,
};

/**
 * The live queue (conversations:read). Refetches every 15 seconds while the
 * tab is visible and pauses while it is hidden (react-query's default for a
 * background tab, kept explicit here). Unlike the other polls in the platform
 * it ignores the idle rule: a wallboard on a TV is a window nobody touches,
 * and it has to keep refreshing. A failed refresh keeps the last numbers
 * (data stays set, isError is true).
 */
export function useDeskWallboard(teamId: string | null) {
  return useQuery({
    queryKey: deskWallboardKeys.board(teamId),
    queryFn: () => helpdeskWorkerApi.getWallboard(teamId ?? undefined),
    refetchInterval: DESK_WALLBOARD_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    retry: 1,
  });
}

// ── CSV export and scheduled report emails (TASK-1228) ──────────────────────

const today = () => new Date().toISOString().slice(0, 10);

/** Download the overview of `range` as CSV. The file name comes from the response, else this fallback. */
export function useExportDeskOverviewCsv() {
  return useMutation({
    mutationFn: async (range: string) =>
      saveResponseAsFile(await helpdeskWorkerApi.exportOverviewCsv(range), `welddesk-overview-${range}-${today()}.csv`),
  });
}

/** Download every chart of a saved report as CSV. */
export function useExportDeskReportCsv() {
  return useMutation({
    mutationFn: async (reportId: string) =>
      saveResponseAsFile(await helpdeskWorkerApi.exportReportCsv(reportId), `welddesk-report-${today()}.csv`),
  });
}

export const deskReportScheduleKeys = {
  all: [...deskReportKeys.all, 'schedules'] as const,
};

/** The schedules, newest first (settings:read). */
export function useDeskReportSchedules() {
  return useQuery({
    queryKey: deskReportScheduleKeys.all,
    queryFn: () => helpdeskWorkerApi.listReportSchedules(),
    staleTime: 30_000,
  });
}

function useScheduleMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: deskReportScheduleKeys.all }),
  });
}

export function useCreateDeskReportSchedule() {
  return useScheduleMutation((input: CreateHelpdeskReportScheduleInput) => helpdeskWorkerApi.createReportSchedule(input));
}

export function useUpdateDeskReportSchedule() {
  return useScheduleMutation(({ id, input }: { id: string; input: UpdateHelpdeskReportScheduleInput }) =>
    helpdeskWorkerApi.updateReportSchedule(id, input),
  );
}

export function useDeleteDeskReportSchedule() {
  return useScheduleMutation((id: string) => helpdeskWorkerApi.deleteReportSchedule(id));
}

/** Send now: resolves with `{ status, error? }`; a failed send is still a resolved call. */
export function useSendDeskReportSchedule() {
  return useScheduleMutation((id: string) => helpdeskWorkerApi.sendReportSchedule(id));
}
