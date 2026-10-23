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

const LEGACY_STARTED = /^(.*) started a (voice|video|audio)? ?call$/i;
const LEGACY_ENDED = /^call ended(?:\s*[—-]\s*(.+))?$/i;

/** "1h 2m 3s" / "47m 13s" / "45s" / "2:34" → seconds. */
export function parseDurationText(text: string): number | undefined {
  const clock = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(text.trim());
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const h = /(\d+)\s*h/.exec(text);
  const m = /(\d+)\s*m/.exec(text);
  const s = /(\d+)\s*s/.exec(text);
  if (!h && !m && !s) return undefined;
  return Number(h?.[1] ?? 0) * 3600 + Number(m?.[1] ?? 0) * 60 + Number(s?.[1] ?? 0);
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
  const started = LEGACY_STARTED.exec(text);
  if (started) return { event: 'started', callType: asCallType(started[2]?.toLowerCase()) ?? 'voice' };
  if (/^missed call$/i.test(text)) return { event: 'ended', outcome: 'missed', duration: 0 };
  const ended = LEGACY_ENDED.exec(text);
  if (ended) {
    return { event: 'ended', outcome: 'answered', duration: ended[1] ? parseDurationText(ended[1]) : undefined };
  }
  return null;
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
  const calls = new Map<string, CallSummary>();
  const folded = new Set<string>();
  const openByCallId = new Map<string, string>();
  const openByAuthor = new Map<string, string[]>();

  for (const message of messages) {
    const notice = parseCallNotice(message);
    if (!notice) continue;

    if (notice.event === 'started') {
      calls.set(message.id, {
        callType: notice.callType ?? 'voice',
        initiatorId: message.authorId ?? undefined,
        initiatorName: message.authorName ?? undefined,
        startedAt: message.createdAt ?? undefined,
      });
      if (notice.callId) openByCallId.set(notice.callId, message.id);
      const author = message.authorId ?? '';
      openByAuthor.set(author, [...(openByAuthor.get(author) ?? []), message.id]);
      continue;
    }

    const author = message.authorId ?? '';
    const authorOpen = openByAuthor.get(author) ?? [];
    const startId =
      (notice.callId ? openByCallId.get(notice.callId) : undefined) ??
      // A tagged end only pairs by id; an untagged one takes the latest open call.
      (notice.callId ? undefined : authorOpen.at(-1));

    const startSummary = startId ? calls.get(startId) : undefined;
    if (startId && startSummary) {
      calls.set(startId, {
        ...startSummary,
        callType: notice.callType ?? startSummary.callType,
        endedAt: message.createdAt ?? undefined,
        outcome: notice.outcome ?? 'answered',
        duration: notice.duration,
      });
      folded.add(message.id);
      if (notice.callId) openByCallId.delete(notice.callId);
      openByAuthor.set(author, authorOpen.filter((id) => id !== startId));
      continue;
    }

    calls.set(message.id, {
      callType: notice.callType ?? 'voice',
      initiatorId: message.authorId ?? undefined,
      initiatorName: message.authorName ?? undefined,
      startedAt: message.createdAt ?? undefined,
      endedAt: message.createdAt ?? undefined,
      outcome: notice.outcome ?? 'answered',
      duration: notice.duration,
      endOnly: true,
    });
  }

  return { calls, folded };
}
