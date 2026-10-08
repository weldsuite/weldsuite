import { useCallback } from 'react';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';

/** Names of workspace members by Clerk user id, for approvals, holds and history. Falls back to the id. */
export function useMemberNames(enabled = true) {
  const { data } = useWorkspaceMemberDirectory(enabled);
  const members = data?.data;
  return useCallback(
    (userId: string | null | undefined): string => {
      if (!userId) return '—';
      const member = members?.find((m) => m.userId === userId);
      return member?.name || member?.email || userId;
    },
    [members],
  );
}
