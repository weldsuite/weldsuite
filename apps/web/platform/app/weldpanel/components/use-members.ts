/**
 * Workspace members for the collaboration views: names for comment and
 * annotation authors, and the options of the email recipients picker.
 */

import { useCallback, useMemo } from 'react';
import { useWorkspaceMembers, type WorkspaceMember } from '@/hooks/queries/use-settings-queries';
import { useAuth } from '@/lib/auth';

export interface MembersDirectory {
  members: WorkspaceMember[];
  isLoading: boolean;
  /** The caller's own user id. */
  me: string | null;
  /** A member's name (or email), `you` for the caller, `fallback` while unknown. */
  nameOf: (userId: string | null | undefined, labels: { you: string; fallback: string }) => string;
}

export function useMembers(enabled = true): MembersDirectory {
  const { userId } = useAuth();
  const { data, isLoading } = useWorkspaceMembers(1, 100, enabled);
  const members = useMemo(() => data?.data ?? [], [data]);
  const byId = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  const nameOf = useCallback(
    (id: string | null | undefined, labels: { you: string; fallback: string }) => {
      if (!id) return labels.fallback;
      if (id === userId) return labels.you;
      const member = byId.get(id);
      return member?.name || member?.email || labels.fallback;
    },
    [byId, userId],
  );
  return { members, isLoading, me: userId ?? null, nameOf };
}
