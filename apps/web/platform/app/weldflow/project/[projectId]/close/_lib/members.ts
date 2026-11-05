/**
 * The workspace's people, for the names and pickers of the close and
 * templates pages. Names resolve for everyone ever listed (a sponsor who left
 * still has a name); pickers offer active members only.
 */

import { useMemo } from 'react';
import { useWorkspaceMemberDirectory, type WorkspaceMember } from '@/hooks/queries/use-settings-queries';

export interface PickerMember {
  userId: string;
  name: string;
  email: string | null;
  avatar: string | null;
}

export function toPickerMember(member: WorkspaceMember): PickerMember | null {
  if (!member.userId) return null;
  return {
    userId: member.userId,
    name: member.name || member.email || member.userId,
    email: member.email ?? null,
    avatar: member.picture ?? null,
  };
}

/** Active means not pending or removed; a member without a status counts as active. */
export function isActiveMember(member: Pick<WorkspaceMember, 'status'>): boolean {
  return !member.status || member.status.toUpperCase() === 'ACTIVE';
}

export function useMemberDirectory() {
  const query = useWorkspaceMemberDirectory();
  return useMemo(() => {
    const all = query.data?.data ?? [];
    const everyone = new Map<string, PickerMember>();
    const pickable: PickerMember[] = [];
    for (const member of all) {
      const picked = toPickerMember(member);
      if (!picked) continue;
      everyone.set(picked.userId, picked);
      if (isActiveMember(member)) pickable.push(picked);
    }
    pickable.sort((a, b) => a.name.localeCompare(b.name));
    return {
      members: pickable,
      memberOf: (userId: string | null | undefined) => (userId ? (everyone.get(userId) ?? null) : null),
      isLoading: query.isLoading,
    };
  }, [query.data, query.isLoading]);
}
