/**
 * Pure helpers for the Access tab: who can be added to an entity and which
 * roles can be given inside it.
 */

import type { WorkspaceMember } from '@/hooks/queries/use-settings-queries';

/** Member types that never get per-entity access: employees live in My HR only, guests are external. */
const EXCLUDED_MEMBER_TYPES = new Set(['EMPLOYEE', 'EXTERNAL_GUEST']);

/**
 * Team members that can be added to a legal entity: active internal members
 * (no employees, no guests, no pending invites) that are not listed yet.
 */
export function availableMembersToAdd(
  members: readonly WorkspaceMember[],
  listed: ReadonlyArray<{ userId: string }>,
): WorkspaceMember[] {
  const listedIds = new Set(listed.map((m) => m.userId));
  return members.filter((m) => {
    if (!m.userId || listedIds.has(m.userId)) return false;
    if (m.memberType && EXCLUDED_MEMBER_TYPES.has(m.memberType.toUpperCase())) return false;
    if (m.status && m.status.toUpperCase() !== 'ACTIVE') return false;
    return true;
  });
}

/** Case-insensitive match on name or email; an empty query keeps everyone. */
export function filterMembersByQuery(members: readonly WorkspaceMember[], query: string): WorkspaceMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...members];
  return members.filter((m) => `${m.name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q));
}

interface RoleLike {
  id: string;
  name: string;
  isSystemRole: boolean;
}

/** Roles a member can act with inside an entity: every role but the system Owner role. */
export function assignableEntityRoles<T extends RoleLike>(roles: readonly T[]): T[] {
  return roles.filter((role) => !(role.isSystemRole && role.name.toLowerCase() === 'owner'));
}
