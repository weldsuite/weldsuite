/**
 * WeldDesk reports on the live inbox (ADR DESK-011):
 * `GET /api/helpdesk-analytics/overview?range=`. The chart data of saved
 * reports goes through `/helpdesk-analytics/charts/batch-data` in the report
 * view itself.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

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
