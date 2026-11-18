/**
 * One tile per person in a call.
 *
 * Getting back into a call gives a person a new RealtimeKit peer, while the
 * old one stays in everyone's `participants.joined` until the media server
 * notices its connection is gone: a rejoin after a dropped connection (see
 * `rejoinCall` in the call context) cannot tell the server it left. Until then
 * the person was shown twice, and the one rejoining saw their own old session
 * as a second "you". The server never keeps a user in a call twice (it evicts
 * the older session on join), so both peers are the same person and only the
 * newest one is shown. RealtimeKit lists peers in the order they joined, so
 * that is the last one; it takes the tile of the first.
 */

export interface CallPeer {
  id: string;
  userId?: string;
  customParticipantId?: string;
}

/** Identifies a person across RTK sessions (the peer `id` changes on a rejoin). */
export function peerKey(p: CallPeer | undefined): string | undefined {
  return p?.customParticipantId || p?.userId || p?.id;
}

/** The remote peers to show: each person's newest peer, without the local user's own older sessions. */
export function currentPeers<T extends CallPeer>(joined: readonly T[], self: CallPeer | undefined): T[] {
  const selfKey = peerKey(self);
  const latest = new Map<string, T>();
  for (const peer of joined) {
    const key = peerKey(peer) ?? peer.id;
    if (key === selfKey) continue;
    latest.set(key, peer);
  }
  return [...latest.values()];
}

/** A `chat_calls.participants` entry, as the join answers carry them. */
export interface CallParticipantEntry {
  userId?: string | null;
  leftAt?: string | null;
}

/**
 * Who the server counts in the call: everyone with an entry they have not
 * left. Every join writes a fresh entry, so one open entry is enough.
 */
export function usersInCall(participants: readonly CallParticipantEntry[] | undefined): string[] {
  const inCall = new Set<string>();
  for (const entry of participants ?? []) {
    if (entry.userId && !entry.leftAt) inCall.add(entry.userId);
  }
  return [...inCall];
}

/** Why a member without a tile of their own is shown anyway. */
export type WaitingState = 'ringing' | 'connecting';

/**
 * The members to show as a placeholder tile while they are not in the media
 * room, and why. The caller sees everyone they rang as ringing. Anyone else
 * rang nobody: they see only the people already in the call whose connection
 * has not come up yet, as connecting. Before, the one answering a DM call saw
 * the caller as "ringing" whenever the caller's connection was slow or failed,
 * which read as the caller calling them back.
 */
export function waitingMembers<M extends { userId?: string }>({
  members,
  inRoom,
  isCallInitiator,
  inCall,
}: {
  /** The channel's other members. */
  members: readonly M[];
  /** The ids (user and app) of the peers in the media room. */
  inRoom: ReadonlySet<string>;
  isCallInitiator: boolean;
  /** `usersInCall` of the call as the user joined it (unused for the caller). */
  inCall: readonly string[];
}): Array<{ member: M; state: WaitingState }> {
  const waiting: Array<{ member: M; state: WaitingState }> = [];
  for (const member of members) {
    if (!member.userId || inRoom.has(member.userId)) continue;
    if (isCallInitiator) waiting.push({ member, state: 'ringing' });
    else if (inCall.includes(member.userId)) waiting.push({ member, state: 'connecting' });
  }
  return waiting;
}
