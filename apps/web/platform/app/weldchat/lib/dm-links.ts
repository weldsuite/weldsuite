/**
 * Which `/weldchat/dm/<userId>` a 1:1 DM row links to.
 *
 * `/weldchat/dm/$userId` treats its param as the OTHER person's user id and
 * resolves the DM channel from it. A DM with yourself ("notes to self") has no
 * other member, so it must link to your own user id — falling back to the
 * channel id would open a DM with a user that does not exist.
 */

interface DmMember {
  userId?: string | null;
}

interface DmRow<M extends DmMember> {
  id: string;
  otherMembers?: M[];
}

export interface OneToOneDmTarget {
  /** Dedupe key and `/weldchat/dm/<key>` param. */
  key: string;
  /** The conversation is with the signed-in user themselves. */
  isSelf: boolean;
}

export function resolveOneToOneDmTarget<M extends DmMember>(
  dm: DmRow<M>,
  otherMembers: M[],
  currentUserId: string | null | undefined,
): OneToOneDmTarget {
  const other = otherMembers[0];
  if (other?.userId) return { key: other.userId, isSelf: false };
  // Until the auth state has loaded there is no user id; the channel id keeps
  // the row unique and the href is corrected on the next render.
  return { key: currentUserId || dm.id, isSelf: true };
}

/**
 * Channel id of the DM that `/weldchat/dm/<targetUserId>` shows, or null when
 * the DM list has no such conversation (yet).
 */
export function findDmChannelIdForUser<M extends DmMember>(
  dms: Array<DmRow<M>>,
  targetUserId: string,
  currentUserId: string | null | undefined,
): string | null {
  if (currentUserId && targetUserId === currentUserId) {
    const self = dms.find((dm) => !(dm.otherMembers ?? []).some((m) => m?.userId));
    return self?.id ?? null;
  }
  const match = dms.find((dm) => dm.otherMembers?.some((m) => m.userId === targetUserId));
  return match?.id ?? null;
}
