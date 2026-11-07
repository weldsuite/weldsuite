import { useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';

export interface MergeMember {
  userId: string;
  name: string;
  picture: string | null;
}

/** The workspace's members by user id, and the signed-in member's id. */
export function useMergeMembers() {
  const { userId } = useAuth();
  const { data } = useWorkspaceMemberDirectory();
  const members = useMemo<MergeMember[]>(
    () =>
      (data?.data ?? []).map((m) => ({
        userId: m.userId,
        name: m.name?.trim() || m.email || m.userId,
        picture: m.picture ?? null,
      })),
    [data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  return { members, memberById, currentUserId: userId ?? null };
}
