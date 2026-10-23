/**
 * Call history in a conversation: pairs each call's "started" notice with its
 * "ended" notice so the list shows one row per call (outcome, duration, time)
 * instead of two loose chips.
 *
 * New notices carry `metadata.call` (see `callNoticeMetadata` in
 * `@weldsuite/chat-domain/call-lifecycle`). Older ones only have their English
 * text ("<name> started a voice call", "Call ended — 4m 12s", "Missed call"),
 * which is parsed instead. Both are only read from real `type: 'system'` rows,
 * so a member can't fake a call by typing the text or sending the metadata.
 */

export type CallOutcome = 'answered' | 'missed' | 'declined';

export interface CallNotice {
  event: 'started' | 'ended';
  callId?: string;
  callType?: 'voice' | 'video';
  outcome?: CallOutcome;
  /** Seconds; on `ended` notices. */
  duration?: number;
}

/** One call as its row renders it. */
export interface CallSummary {
  callType: 'voice' | 'video';
  initiatorId?: string;
  initiatorName?: string;
  /** When the call started (the started notice), or the ended notice's time if that one is all there is. */
  startedAt?: string;
  endedAt?: string;
  /** Undefined while the call has not ended (or its end isn't loaded). */
  outcome?: CallOutcome;
  duration?: number;
  /** Only the ended notice was found; who started it and when is unknown. */
  endOnly?: boolean;
}

interface CallNoticeMessage {
  id: string;
  type?: string | null;
  content?: string | null;
  metadata?: unknown;
  authorId?: string | null;
  authorName?: string | null;
  createdAt?: string | null;
}

/** Endings of the legacy "<name> started a … call" text, lower-cased. */
const LEGACY_STARTED_SUFFIXES: ReadonlyArray<[string, 'voice' | 'video']> = [
  [' started a voice call', 'voice'],
  [' started a video call', 'video'],
  [' started a audio call', 'voice'],
  [' started a call', 'voice'],
];
const LEGACY_ENDED = 'call ended';
const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };

/** "1h 2m 3s" / "47m 13s" / "45s" / "2:34" → seconds. */
export function parseDurationText(text: string): number | undefined {
  const trimmed = text.trim();
  const clock = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(trimmed);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  let total = 0;
  for (const part of trimmed.split(' ')) {
    const unit = UNIT_SECONDS[part.slice(-1)];
    const value = part.slice(0, -1);
    if (!unit || !/^\d+$/.test(value)) return undefined;
    total += Number(value) * unit;
  }
  return trimmed ? total : undefined;
}

/** "Call ended" / "Call ended — 47m 13s" → the ended notice, else null. */
function legacyEndedNotice(text: string): CallNotice | null {
  if (!text.toLowerCase().startsWith(LEGACY_ENDED)) return null;
  const rest = text.slice(LEGACY_ENDED.length).trim();
  if (!rest) return { event: 'ended', outcome: 'answered', duration: undefined };
  if (!rest.startsWith('—') && !rest.startsWith('-')) return null;
  return { event: 'ended', outcome: 'answered', duration: parseDurationText(rest.slice(1)) };
}

function legacyStartedCallType(text: string): 'voice' | 'video' | undefined {
  const lower = text.toLowerCase();
  return LEGACY_STARTED_SUFFIXES.find(([suffix]) => lower.endsWith(suffix))?.[1];
}

/** "45s", "47m 13s", "1h 05m". */
export function formatCallDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return s > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${m}m`;
  return `${s}s`;
}

function asCallType(value: unknown): 'voice' | 'video' | undefined {
  if (value === 'video') return 'video';
  if (value === 'voice' || value === 'audio') return 'voice';
  return undefined;
}

function noticeFromMetadata(metadata: unknown): CallNotice | null {
  const call = (metadata as { call?: Record<string, unknown> } | null | undefined)?.call;
  if (!call || (call.event !== 'started' && call.event !== 'ended')) return null;
  const outcome = call.outcome;
  return {
    event: call.event,
    callId: typeof call.callId === 'string' ? call.callId : undefined,
    callType: asCallType(call.callType),
    outcome: outcome === 'answered' || outcome === 'missed' || outcome === 'declined' ? outcome : undefined,
    duration: typeof call.duration === 'number' ? call.duration : undefined,
  };
}

/** The call notice a message is, or null when it isn't one. */
export function parseCallNotice(message: Pick<CallNoticeMessage, 'type' | 'content' | 'metadata'>): CallNotice | null {
  if (message.type !== 'system') return null;
  const fromMetadata = noticeFromMetadata(message.metadata);
  if (fromMetadata) return fromMetadata;

  const text = (message.content ?? '').trim();
  const startedType = legacyStartedCallType(text);
  if (startedType) return { event: 'started', callType: startedType };
  if (/^missed call$/i.test(text)) return { event: 'ended', outcome: 'missed', duration: 0 };
  return legacyEndedNotice(text);
}

export interface CallHistory {
  /** Started-notice id (or a lone ended-notice id) → the call it renders. */
  calls: Map<string, CallSummary>;
  /** Ended notices folded into their call's row: not rendered on their own. */
  folded: Set<string>;
}

/**
 * Pair the call notices of a chronological (oldest first) message list.
 *
 * An ended notice pairs with its call's started notice by call id, else
 * (older rows) with the latest still-open call by the same author: the ended
 * notice is always posted under the caller's name. One whose start isn't
 * loaded or never existed renders on its own.
 */
export function buildCallHistory(messages: readonly CallNoticeMessage[]): CallHistory {
  const history: CallHistory = { calls: new Map(), folded: new Set() };
  const open: OpenCalls = { byCallId: new Map(), byAuthor: new Map() };

  for (const message of messages) {
    const notice = parseCallNotice(message);
    if (notice?.event === 'started') addStarted(history, open, message, notice);
    else if (notice) addEnded(history, open, message, notice);
  }

  return history;
}

/** Started-notice ids of calls that haven't ended yet. */
interface OpenCalls {
  byCallId: Map<string, string>;
  byAuthor: Map<string, string[]>;
}

function addStarted(history: CallHistory, open: OpenCalls, message: CallNoticeMessage, notice: CallNotice): void {
  history.calls.set(message.id, {
    callType: notice.callType ?? 'voice',
    initiatorId: message.authorId ?? undefined,
    initiatorName: message.authorName ?? undefined,
    startedAt: message.createdAt ?? undefined,
  });
  if (notice.callId) open.byCallId.set(notice.callId, message.id);
  const author = message.authorId ?? '';
  open.byAuthor.set(author, [...(open.byAuthor.get(author) ?? []), message.id]);
}

function addEnded(history: CallHistory, open: OpenCalls, message: CallNoticeMessage, notice: CallNotice): void {
  const author = message.authorId ?? '';
  const authorOpen = open.byAuthor.get(author) ?? [];
  // A tagged end only pairs by id; an untagged one takes the latest open call.
  const startId = notice.callId ? open.byCallId.get(notice.callId) : authorOpen.at(-1);
  const startSummary = startId ? history.calls.get(startId) : undefined;
  const ended = {
    endedAt: message.createdAt ?? undefined,
    outcome: notice.outcome ?? 'answered',
    duration: notice.duration,
  } as const;

  if (!startId || !startSummary) {
    history.calls.set(message.id, {
      callType: notice.callType ?? 'voice',
      initiatorId: message.authorId ?? undefined,
      initiatorName: message.authorName ?? undefined,
      startedAt: message.createdAt ?? undefined,
      ...ended,
      endOnly: true,
    });
    return;
  }

  history.calls.set(startId, { ...startSummary, callType: notice.callType ?? startSummary.callType, ...ended });
  history.folded.add(message.id);
  if (notice.callId) open.byCallId.delete(notice.callId);
  open.byAuthor.set(author, authorOpen.filter((id) => id !== startId));
}
