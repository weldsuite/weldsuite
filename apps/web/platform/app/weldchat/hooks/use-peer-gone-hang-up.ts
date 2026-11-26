import { useEffect, useRef, useState } from 'react';
import type RealtimeKitClient from '@cloudflare/realtimekit';
import { currentPeers, type CallPeer } from '../lib/call-peers';

/**
 * How long the other person in a 1:1 call may be gone before the call hangs
 * up. It rides out their reconnect after a network drop. The mobile app waits
 * the same (`CallHost`).
 */
export const PEER_GONE_GRACE_MS = 10_000;

/** The part of RealtimeKit's (and the LiveKit client's) `participants.joined` this needs. */
interface JoinedList {
  toArray?: () => CallPeer[];
  on?: (event: string, listener: () => void) => void;
  off?: (event: string, listener: () => void) => void;
}

/** Whether anyone but ourselves is in the media room. */
function usePeerPresent(meeting: RealtimeKitClient | null): boolean {
  // Kept with the client it was read from, so a new client never shows the old one's answer.
  const [seen, setSeen] = useState<{ meeting: RealtimeKitClient | null; present: boolean }>({
    meeting: null,
    present: false,
  });
  useEffect(() => {
    const joined = meeting?.participants?.joined as unknown as JoinedList | undefined;
    if (!meeting || !joined) return;
    const evaluate = () =>
      setSeen({ meeting, present: currentPeers(joined.toArray?.() ?? [], meeting.self).length > 0 });
    // A reconnect rebuilds the list: cleared, then everyone re-added right after.
    const onCleared = () => queueMicrotask(evaluate);
    evaluate();
    joined.on?.('participantJoined', evaluate);
    joined.on?.('participantLeft', evaluate);
    joined.on?.('participantsCleared', onCleared);
    return () => {
      joined.off?.('participantJoined', evaluate);
      joined.off?.('participantLeft', evaluate);
      joined.off?.('participantsCleared', onCleared);
    };
  }, [meeting]);
  return !!meeting && seen.meeting === meeting && seen.present;
}

interface PeerGoneHangUpOptions {
  callId: string | null;
  meeting: RealtimeKitClient | null;
  /** A 1:1 (DM) call. Group and channel calls carry on with whoever is left. */
  isDirect: boolean;
  /**
   * Our own connection to the room is up. While it is down (or a new client
   * rejoins) the room looks empty whether the other person left or not.
   */
  inRoom: boolean;
  onHangUp: () => void;
}

/**
 * A 1:1 call ends for both once one of them leaves, as on the phone. The
 * other person's leave does not end the call server side while we are still
 * in the room, so once they have been gone for PEER_GONE_GRACE_MS we hang up
 * here. Only after they were in the call: before that it is still ringing.
 */
export function usePeerGoneHangUp({ callId, meeting, isDirect, inRoom, onHangUp }: PeerGoneHangUpOptions) {
  const peerPresent = usePeerPresent(meeting);

  // Kept per call, not per client: a rejoin after our own connection dropped
  // brings a new client, and the other person may have left meanwhile.
  const [peerSeenInCall, setPeerSeenInCall] = useState<string | null>(null);
  useEffect(() => {
    if (callId && peerPresent) setPeerSeenInCall(callId);
  }, [callId, peerPresent]);
  const peerJoined = !!callId && peerSeenInCall === callId;

  // Read from a ref so a new `onHangUp` (it changes with the call state) can't restart the wait.
  const onHangUpRef = useRef(onHangUp);
  onHangUpRef.current = onHangUp;

  const peerGone = isDirect && inRoom && peerJoined && !peerPresent;
  useEffect(() => {
    if (!peerGone) return;
    const id = setTimeout(() => onHangUpRef.current(), PEER_GONE_GRACE_MS);
    return () => clearTimeout(id);
  }, [peerGone]);
}
