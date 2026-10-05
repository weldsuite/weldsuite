/**
 * Where a DM channel id (from a message link) should be shown.
 *
 * `GET /channels/:id` returns the channel's `members` (every member, the caller
 * included) and no `otherMembers`, so the other side is derived here.
 */
export type DmRedirectTarget =
  | { kind: 'dm'; userId: string }
  | { kind: 'group' };

interface MemberLike {
  userId?: string | null;
}

export function dmRedirectTarget(members: ReadonlyArray<MemberLike> | undefined, selfUserId: string): DmRedirectTarget {
  const ids = [...new Set((members ?? []).map((m) => m.userId).filter((id): id is string => !!id))];
  const others = ids.filter((id) => id !== selfUserId);
  if (others.length === 1) return { kind: 'dm', userId: others[0] };
  // A note-to-self DM has only the caller as member.
  if (others.length === 0 && ids.length === 1) return { kind: 'dm', userId: selfUserId };
  return { kind: 'group' };
}
