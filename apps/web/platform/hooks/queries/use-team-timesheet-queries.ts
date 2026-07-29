
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

/**
 * Team timesheet — every project member's logged hours for one project.
 *
 * Backend-gated to project managers/owners (`canManageProject`), so a plain
 * member calling this gets a 403 rather than a widened result. Callers should
 * still hide the entry point behind `useProjectPermissions().isAdmin`; the
 * server check is the boundary, the client check is the affordance.
 */

export interface TeamTimesheetMember {
  userId: string;
  name: string;
  email: string;
  avatar: string;
  initials: string;
  role: string | null;
  /** False for someone who logged hours then left the project roster. */
  isActiveMember: boolean;
  totalMinutes: number;
  billableMinutes: number;
  nonBillableMinutes: number;
  entryCount: number;
}

export interface TeamTimesheetEntry {
  id: string;
  projectId: string | null;
  taskId: string | null;
  userId: string;
  userName: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  duration: number;
  description: string | null;
  activity: string | null;
  billable: boolean;
  status: string;
  task?: { id: string; title: string };
}

export interface TeamTimesheetSummary {
  projectId: string;
  projectName: string;
  range: { fromDate: string | null; toDate: string | null };
  totals: {
    totalMinutes: number;
    billableMinutes: number;
    nonBillableMinutes: number;
    entryCount: number;
    memberCount: number;
    contributorCount: number;
  };
  members: TeamTimesheetMember[];
  entries: TeamTimesheetEntry[];
  /** True when the entry list was capped; `totals` stay exact regardless. */
  entriesTruncated: boolean;
}

export interface TeamTimesheetFilters {
  fromDate?: string;
  toDate?: string;
  userId?: string;
  taskId?: string;
  billable?: boolean;
}

export const teamTimesheetKeys = {
  all: ['team-timesheet'] as const,
  summary: (projectId: string, filters?: TeamTimesheetFilters) =>
    [...teamTimesheetKeys.all, projectId, filters ?? {}] as const,
};

export function useTeamTimesheet(
  projectId: string,
  filters: TeamTimesheetFilters = {},
  enabled = true,
) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: teamTimesheetKeys.summary(projectId, filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ projectId });
      if (filters.fromDate) params.set('fromDate', filters.fromDate);
      if (filters.toDate) params.set('toDate', filters.toDate);
      if (filters.userId) params.set('userId', filters.userId);
      if (filters.taskId) params.set('taskId', filters.taskId);
      if (filters.billable !== undefined) params.set('billable', String(filters.billable));
      const res = await client.get<{ data: TeamTimesheetSummary }>(
        `/time-entries/team-summary?${params}`,
      );
      return res.data;
    },
    enabled: !!projectId && enabled,
  });
}
