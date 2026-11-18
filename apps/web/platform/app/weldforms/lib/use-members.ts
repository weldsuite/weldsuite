import { useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';

export interface FormsMember {
  userId: string;
  name: string;
  email: string | null;
  picture: string | null;
}

/** The workspace's members, by user id, and the signed-in member's id. */
export function useFormsMembers() {
  const { userId } = useAuth();
  const { data, isLoading } = useWorkspaceMemberDirectory();
  const members = useMemo<FormsMember[]>(
    () =>
      (data?.data ?? []).map((m) => ({
        userId: m.userId,
        name: m.name?.trim() || m.email || m.userId,
        email: m.email ?? null,
        picture: m.picture ?? null,
      })),
    [data],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  return { members, memberById, currentUserId: userId ?? null, isLoading };
}
