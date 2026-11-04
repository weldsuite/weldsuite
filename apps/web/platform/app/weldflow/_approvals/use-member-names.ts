import { useCallback, useMemo } from 'react';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useI18n } from '@/lib/i18n/provider';

export interface MemberOption {
  userId: string;
  name: string;
}

/** Workspace members for pickers and for naming the people on a review. */
export function useMemberNames() {
  const { t } = useI18n();
  const query = useWorkspaceMembers(undefined, 100);
  const members = useMemo<MemberOption[]>(
    () =>
      (query.data?.data ?? []).map((member) => ({
        userId: member.userId,
        name: member.name?.trim() || member.email || member.userId,
      })),
    [query.data],
  );
  const byId = useMemo(() => new Map(members.map((member) => [member.userId, member.name])), [members]);
  const nameOf = useCallback(
    (userId: string | null | undefined) => (userId ? (byId.get(userId) ?? t.flowApprovals.common.unknownMember) : t.flowApprovals.common.unknownMember),
    [byId, t],
  );
  return { members, nameOf, isLoading: query.isLoading };
}
