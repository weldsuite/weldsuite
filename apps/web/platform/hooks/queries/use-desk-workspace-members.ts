/**
 * Cached workspace-members lookup for WeldDesk inbox pickers (assignee
 * popover, @mention autocomplete). On app-api, mirrors the pattern in
 * apps/web/platform/components/objects/task/use-task-data.ts
 * (`useWorkspaceMembersForTaskPanel`) rather than the uncached inline
 * `useQuery` in components/team/member-select.tsx — the inbox renders one
 * of these per conversation-pane mount, so a shared `staleTime` matters.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';

export const deskWorkspaceMembersKeys = {
  all: ['desk', 'workspace-members'] as const,
};

export interface DeskWorkspaceMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  picture: string | null;
  role: string;
  status: string;
}

export function useDeskWorkspaceMembers() {
  const api = useAppApi();
  return useQuery({
    queryKey: deskWorkspaceMembersKeys.all,
    queryFn: async () => {
      const res = await api.teamMembers.list();
      return res.data ?? [];
    },
    staleTime: 60_000,
    select: (data): DeskWorkspaceMember[] =>
      data.map((m) => ({
        id: m.userId,
        userId: m.userId,
        name: m.name?.trim() || m.email || m.userId,
        email: m.email ?? '',
        picture: m.picture,
        role: m.role,
        status: m.status,
      })),
  });
}
