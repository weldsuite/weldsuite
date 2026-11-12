/** The realtime events WeldDesk phone sends a member (call-api `lib/desk-phone-realtime.ts`). */

export type DeskPhoneEndedReason = 'answered_elsewhere' | 'caller_hung_up' | 'timeout';

const ENDED_REASONS: readonly string[] = ['answered_elsewhere', 'caller_hung_up', 'timeout'];

export function isDeskPhoneEndedReason(value: unknown): value is DeskPhoneEndedReason {
  return typeof value === 'string' && ENDED_REASONS.includes(value);
}

/** A string, or null for anything else (the events are untyped on the wire). */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The inbox path of a phone conversation. */
export function deskPhoneConversationPath(conversationId: string): string {
  return `/welddesk/inbox/phone/${conversationId}`;
}

/** Whether `pathname` is already that conversation. */
export function isConversationOpen(pathname: string | null, conversationId: string): boolean {
  return Boolean(pathname?.split('/').filter(Boolean).includes(conversationId));
}

/** Seconds since `since` (an ISO time), never negative; 0 for a time that does not parse. */
export function secondsSince(since: string | null | undefined, now: number): number {
  const start = since ? Date.parse(since) : Number.NaN;
  return Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatWait(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
