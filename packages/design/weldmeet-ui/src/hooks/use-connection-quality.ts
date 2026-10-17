import { useEffect, useRef, useState } from 'react';
import type { MeetingClient } from '../types';

/**
 * How the local connection to the call is doing.
 * - `good` / `fair` / `poor`: from RealtimeKit's score of what you send.
 * - `reconnecting`: the SDK lost the room and is getting back in by itself.
 * - `offline`: the browser reports no network at all.
 * - `unknown`: no score reported yet (the first one comes a few seconds in).
 */
export type ConnectionLevel = 'good' | 'fair' | 'poor' | 'reconnecting' | 'offline' | 'unknown';

export interface ConnectionQuality {
  level: ConnectionLevel;
  /** Your send score, 0–10: the lower of your microphone and camera. Null before the first report. */
  score: number | null;
  /** Packet loss on what you send, in percent, when RealtimeKit reported it. */
  packetLossPercent: number | null;
  /** Peer ids (`participant.id`) of the people whose audio or video reaches you poorly. */
  poorPeerIds: ReadonlySet<string>;
}

/** RealtimeKit scores run 0–10; it flags `poorConnection` below about 4. */
export const GOOD_SCORE = 7;
export const FAIR_SCORE = 4;

export function scoreLevel(score: number | null): ConnectionLevel {
  if (score === null) return 'unknown';
  if (score >= GOOD_SCORE) return 'good';
  if (score >= FAIR_SCORE) return 'fair';
  return 'poor';
}

interface ScoreUpdate {
  kind?: string;
  isScreenshare?: boolean;
  score?: number;
  participantId?: string;
  scoreStats?: unknown;
}

const EMPTY: ReadonlySet<string> = new Set();
const INITIAL: ConnectionQuality = { level: 'unknown', score: null, packetLossPercent: null, poorPeerIds: EMPTY };

function packetLossOf(stats: unknown): number | null {
  const loss = (stats as { packetsLostPercentage?: unknown } | null | undefined)?.packetsLostPercentage;
  return typeof loss === 'number' && Number.isFinite(loss) ? loss : null;
}

function sameQuality(a: ConnectionQuality, b: ConnectionQuality): boolean {
  if (a.level !== b.level || a.score !== b.score || a.packetLossPercent !== b.packetLossPercent) return false;
  if (a.poorPeerIds.size !== b.poorPeerIds.size) return false;
  for (const id of a.poorPeerIds) if (!b.poorPeerIds.has(id)) return false;
  return true;
}

interface Tracked {
  /** Your send score per media kind (`audio`, `video`); screen shares are left out. */
  self: Map<string, { score: number; loss: number | null }>;
  /** What you receive, per peer id and media kind. */
  peers: Map<string, Map<string, number>>;
  reconnecting: boolean;
  offline: boolean;
}

/** Pure: the quality the tracked scores add up to. */
export function summarizeConnection(t: Tracked): ConnectionQuality {
  const selfScores = [...t.self.values()];
  const worst = selfScores.reduce<{ score: number; loss: number | null } | null>(
    (min, s) => (!min || s.score < min.score ? s : min),
    null,
  );
  const score = worst ? Math.round(worst.score) : null;
  const poorPeerIds = new Set<string>();
  for (const [peerId, kinds] of t.peers) {
    if ([...kinds.values()].some((s) => s < FAIR_SCORE)) poorPeerIds.add(peerId);
  }
  let level = scoreLevel(score);
  if (t.reconnecting) level = 'reconnecting';
  if (t.offline) level = 'offline';
  return {
    level,
    score,
    packetLossPercent: worst && worst.loss !== null ? Math.round(worst.loss * 10) / 10 : null,
    poorPeerIds: poorPeerIds.size > 0 ? poorPeerIds : EMPTY,
  };
}

/**
 * Follows RealtimeKit's media scores (`mediaScoreUpdate` on `meeting.self` for
 * what you send, on `participants.joined` for what you receive), the SDK's own
 * reconnects, and the browser's online state. Re-renders only when the
 * summary changes, not on every score report.
 */
export function useConnectionQuality(meeting: MeetingClient | null): ConnectionQuality {
  const [quality, setQuality] = useState<ConnectionQuality>(INITIAL);
  const qualityRef = useRef(quality);

  useEffect(() => {
    const tracked: Tracked = {
      self: new Map(),
      peers: new Map(),
      reconnecting: false,
      offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    };
    const publish = () => {
      const next = summarizeConnection(tracked);
      if (sameQuality(next, qualityRef.current)) return;
      qualityRef.current = next;
      setQuality(next);
    };
    publish();
    if (!meeting) return;

    const onSelfScore = (u: ScoreUpdate) => {
      if (u.isScreenshare || typeof u.score !== 'number' || !u.kind) return;
      tracked.self.set(u.kind, { score: u.score, loss: packetLossOf(u.scoreStats) });
      publish();
    };
    const onPeerScore = (u: ScoreUpdate) => {
      if (u.isScreenshare || typeof u.score !== 'number' || !u.kind || !u.participantId) return;
      const kinds = tracked.peers.get(u.participantId) ?? new Map<string, number>();
      kinds.set(u.kind, u.score);
      tracked.peers.set(u.participantId, kinds);
      publish();
    };
    const onPeerLeft = (p?: { id?: string }) => {
      if (p?.id && tracked.peers.delete(p.id)) publish();
    };
    const onRoomLeft = (payload?: { state?: string }) => {
      if (payload?.state !== 'disconnected') return;
      tracked.reconnecting = true;
      publish();
    };
    const onRoomJoined = () => {
      tracked.reconnecting = false;
      // Old scores describe the connection that dropped.
      tracked.self.clear();
      tracked.peers.clear();
      publish();
    };
    const onOnline = () => {
      tracked.offline = false;
      publish();
    };
    const onOffline = () => {
      tracked.offline = true;
      publish();
    };

    // The SDK's event maps are typed per emitter; these handlers read the
    // shared payload fields defensively, so one loose signature serves all.
    type Emitter = {
      on?: (event: string, handler: (...args: never[]) => void) => unknown;
      off?: (event: string, handler: (...args: never[]) => void) => unknown;
    };
    const selfEmitter = meeting.self as unknown as Emitter | undefined;
    const joined = meeting.participants?.joined as unknown as Emitter | undefined;
    selfEmitter?.on?.('mediaScoreUpdate', onSelfScore);
    selfEmitter?.on?.('roomLeft', onRoomLeft);
    selfEmitter?.on?.('roomJoined', onRoomJoined);
    joined?.on?.('mediaScoreUpdate', onPeerScore);
    joined?.on?.('participantLeft', onPeerLeft);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      selfEmitter?.off?.('mediaScoreUpdate', onSelfScore);
      selfEmitter?.off?.('roomLeft', onRoomLeft);
      selfEmitter?.off?.('roomJoined', onRoomJoined);
      joined?.off?.('mediaScoreUpdate', onPeerScore);
      joined?.off?.('participantLeft', onPeerLeft);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [meeting]);

  return quality;
}
