
import { useQuery } from '@tanstack/react-query';
import {
  timeEntriesApi,
  type ApiTeamTimesheetEntry,
  type ApiTeamTimesheetMember,
  type ApiTeamTimesheetSummary,
} from '@/app/weldflow/lib/api-client';

/**
 * Team timesheet — every project member's logged hours for one project.
 *
 * Backend-gated to project managers/owners (`canManageProject`), so a plain
 * member calling this gets a 403 rather than a widened result. Callers should
 * still hide the entry point behind `useProjectPermissions().isAdmin`; the
 * server check is the boundary, the client check is the affordance.
 */

export type TeamTimesheetMember = ApiTeamTimesheetMember;
export type TeamTimesheetEntry = ApiTeamTimesheetEntry;
export type TeamTimesheetSummary = ApiTeamTimesheetSummary;

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
  return useQuery({
    queryKey: teamTimesheetKeys.summary(projectId, filters),
    queryFn: async () => {
      const res = await timeEntriesApi.teamSummary(projectId, filters);
      if (!res.success) throw new Error(res.error || 'Failed to load the team timesheet');
      return res.data!;
    },
    enabled: !!projectId && enabled,
  });
}
