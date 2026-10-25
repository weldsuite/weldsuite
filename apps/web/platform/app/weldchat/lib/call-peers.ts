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
