import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { MeetingClient } from '../types';
import {
  createInitialToolsState,
  filterBreakoutParticipants,
  getMeetingToolsStore,
  type MeetingToolsState,
  type MeetingToolsStore,
} from './tools-store';

const EMPTY_STATE = createInitialToolsState();
const getEmptyState = () => EMPTY_STATE;
const subscribeToNothing = () => () => {};

/** The shared tools store of the meeting, or null before a client exists. */
export function useMeetingToolsStore(meeting: MeetingClient | null): MeetingToolsStore | null {
  return useMemo(() => (meeting ? getMeetingToolsStore(meeting) : null), [meeting]);
}

export function useMeetingToolsState(store: MeetingToolsStore | null): MeetingToolsState {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeToNothing,
    store ? store.getState : getEmptyState,
    store ? store.getState : getEmptyState,
  );
}

/**
 * The participants the local one shares a breakout room with (everyone while
 * no rooms are open). The list holds the local participant first. For
 * surfaces that render people outside MeetingRoomView, such as a PiP window.
 */
export function useBreakoutParticipants<
  T extends { id?: string; userId?: string; customParticipantId?: string },
>(meeting: MeetingClient | null, participants: T[]): T[] {
  const { breakout } = useMeetingToolsState(useMeetingToolsStore(meeting));
  return useMemo(() => filterBreakoutParticipants(breakout, participants), [breakout, participants]);
}

/** The current time, refreshed on an interval while `active` (for countdowns). */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(interval);
  }, [active, intervalMs]);
  return now;
}

// ─── Polls (RealtimeKit's own polls, kept server-side for the session) ───────

export interface MeetingPollOption {
  text: string;
  count: number;
  votes: { id: string; name: string }[];
}

export interface MeetingPoll {
  id: string;
  question: string;
  options: MeetingPollOption[];
  anonymous: boolean;
  hideVotes: boolean;
  createdBy: string;
  createdByUserId: string;
  /** User ids of everyone who voted. */
  voted: string[];
}

export interface MeetingPolls {
  polls: MeetingPoll[];
  /** Ids the local participant is known by, to tell which polls they voted on. */
  selfIds: string[];
  canCreate: boolean;
  canVote: boolean;
  create: (question: string, options: string[], anonymous: boolean) => Promise<void>;
  vote: (pollId: string, optionIndex: number) => Promise<void>;
}

export function useMeetingPolls(
  meeting: MeetingClient | null,
  onNewPoll?: (poll: MeetingPoll) => void,
): MeetingPolls {
  const [polls, setPolls] = useState<MeetingPoll[]>([]);

  useEffect(() => {
    const source = meeting?.polls;
    if (!source) {
      setPolls([]);
      return;
    }
    setPolls([...(source.items ?? [])]);
    const onUpdate = (payload: { polls: MeetingPoll[]; newPoll: boolean }) => {
      const next = [...(payload?.polls ?? [])];
      setPolls(next);
      const latest = next[next.length - 1];
      if (payload?.newPoll && latest && latest.createdByUserId !== meeting.self?.userId) {
        onNewPoll?.(latest);
      }
    };
    try {
      source.on?.('pollsUpdate', onUpdate);
    } catch {
      /* polls module unavailable */
    }
    return () => {
      try {
        source.off?.('pollsUpdate', onUpdate);
      } catch {
        /* ignore */
      }
    };
  }, [meeting, onNewPoll]);

  const create = useCallback(
    async (question: string, options: string[], anonymous: boolean) => {
      await meeting?.polls?.create(question, options, anonymous, false);
    },
    [meeting],
  );
  const vote = useCallback(
    async (pollId: string, optionIndex: number) => {
      await meeting?.polls?.vote(pollId, optionIndex);
    },
    [meeting],
  );

  const permissions = meeting?.self?.permissions?.polls;
  const selfUserId = meeting?.self?.userId;
  const selfPeerId = meeting?.self?.id;
  const selfIds = useMemo(
    () => [selfUserId, selfPeerId].filter((id): id is string => !!id),
    [selfUserId, selfPeerId],
  );
  return {
    polls,
    selfIds,
    canCreate: permissions?.canCreate !== false,
    canVote: permissions?.canVote !== false,
    create,
    vote,
  };
}

// ─── Live transcript (RealtimeKit's live transcription channel) ──────────────

export interface TranscriptLine {
  id: string;
  peerId: string;
  speakerName: string;
  text: string;
  isPartial: boolean;
  at: number;
}

interface RtkTranscript {
  id?: string;
  peerId?: string;
  name?: string;
  transcript?: string;
  isPartialTranscript?: boolean;
  date?: Date | string | number;
}

const MAX_TRANSCRIPT_LINES = 2000;

function toLine(t: RtkTranscript, fallbackIndex: number): TranscriptLine | null {
  if (!t?.transcript || !t.peerId) return null;
  const at = t.date ? new Date(t.date).getTime() : Date.now();
  return {
    id: t.id || `line-${t.peerId}-${fallbackIndex}`,
    peerId: t.peerId,
    speakerName: t.name || 'Speaker',
    text: t.transcript,
    isPartial: t.isPartialTranscript === true,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

/** Appends a transcript frame, replacing the speaker's still-open partial line. */
function appendLine(lines: TranscriptLine[], line: TranscriptLine): TranscriptLine[] {
  const last = lines[lines.length - 1];
  const next =
    last && last.isPartial && last.peerId === line.peerId
      ? [...lines.slice(0, -1), { ...line, id: last.id, at: last.at }]
      : [...lines, line];
  return next.length > MAX_TRANSCRIPT_LINES ? next.slice(-MAX_TRANSCRIPT_LINES) : next;
}

/**
 * Everything said since this client joined, as RealtimeKit transcribed it.
 * Seeded from the SDK's own buffer so it survives the room view remounting.
 */
export function useLiveTranscript(meeting: MeetingClient | null): TranscriptLine[] {
  const [lines, setLines] = useState<TranscriptLine[]>([]);

  useEffect(() => {
    const ai = meeting?.ai;
    if (!ai) {
      setLines([]);
      return;
    }
    let seeded: TranscriptLine[] = [];
    (ai.transcripts ?? []).forEach((t, index) => {
      const line = toLine(t, index);
      if (line) seeded = appendLine(seeded, line);
    });
    setLines(seeded);

    let counter = seeded.length;
    const onTranscript = (t: RtkTranscript) => {
      counter += 1;
      const line = toLine(t, counter);
      if (line) setLines((prev) => appendLine(prev, line));
    };
    try {
      ai.on?.('transcript', onTranscript);
    } catch {
      /* transcription unavailable */
    }
    return () => {
      try {
        ai.off?.('transcript', onTranscript);
      } catch {
        /* ignore */
      }
    };
  }, [meeting]);

  return lines;
}

// ─── Live streaming (RealtimeKit livestream) ─────────────────────────────────

export type LivestreamState = 'IDLE' | 'STARTING' | 'WAITING_ON_MANUAL_INGESTION' | 'LIVESTREAMING' | 'STOPPING';

export interface MeetingLivestream {
  state: LivestreamState;
  isLive: boolean;
  viewerCount: number;
  /** A page people can open to watch, once the stream is up. */
  viewerUrl: string | null;
  /** The preset of this participant allows starting / stopping the stream. */
  canLivestream: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * RealtimeKit streams through Cloudflare Stream and hands back the HLS
 * manifest. Browsers other than Safari cannot open a manifest directly, so
 * point viewers at Stream's hosted player for the same video instead.
 */
export function livestreamViewerUrl(playbackUrl: string | undefined | null): string | null {
  if (!playbackUrl) return null;
  const match = /^(https:\/\/[^/]+\.cloudflarestream\.com\/[^/]+)\/manifest\/video\.m3u8/.exec(playbackUrl);
  return match ? `${match[1]}/watch` : playbackUrl;
}

export function useMeetingLivestream(meeting: MeetingClient | null): MeetingLivestream {
  const [state, setState] = useState<LivestreamState>('IDLE');
  const [viewerCount, setViewerCount] = useState(0);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);

  useEffect(() => {
    const livestream = meeting?.livestream;
    if (!livestream) {
      setState('IDLE');
      return;
    }
    const sync = () => {
      setState(livestream.state ?? 'IDLE');
      setViewerCount(livestream.viewerCount ?? 0);
      setPlaybackUrl(livestream.playbackUrl ?? null);
    };
    sync();
    try {
      livestream.on?.('livestreamUpdate', sync);
      livestream.on?.('viewerCountUpdate', sync);
    } catch {
      /* livestream module unavailable */
    }
    return () => {
      try {
        livestream.off?.('livestreamUpdate', sync);
        livestream.off?.('viewerCountUpdate', sync);
      } catch {
        /* ignore */
      }
    };
  }, [meeting]);

  const start = useCallback(async () => {
    await meeting?.livestream?.start();
  }, [meeting]);
  const stop = useCallback(async () => {
    await meeting?.livestream?.stop();
  }, [meeting]);

  return {
    state,
    isLive: state === 'LIVESTREAMING',
    viewerCount,
    viewerUrl: livestreamViewerUrl(playbackUrl),
    canLivestream: meeting?.self?.permissions?.canLivestream === true,
    start,
    stop,
  };
}
