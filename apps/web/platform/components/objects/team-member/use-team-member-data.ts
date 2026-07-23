import { useQuery } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { MemberProfile } from '@weldsuite/core-api-client/schemas/member-profile';

/**
 * React-Query keys for the app-api team-members domain. Shared with
 * mutations so write paths invalidate cleanly.
 */
const teamMembersKeys = {
  all: ['app-api', 'team-members'] as const,
  profile: (userId: string) => [...teamMembersKeys.all, 'profile', userId] as const,
  note: (userId: string) => [...teamMembersKeys.all, 'note', userId] as const,
};

/**
 * Fetch a single team member's profile (workspace_members + user_preferences
 * timezone/workingHours) from the new app-api.
 */
export function useTeamMemberProfile(userId: string | null | undefined) {
  const api = useAppApi();
  return useQuery({
    queryKey: teamMembersKeys.profile(userId ?? ''),
    queryFn: async () => {
      const res = await api.teamMembers.getProfile(userId!);
      return res.data as MemberProfile;
    },
    enabled: !!userId,
    staleTime: 30_000,
  });
}
