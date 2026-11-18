/**
 * Live call translation on the member's own call, fed by the realtime events
 * `phone.caption` and `phone.translation` (call-api `desk-phone-translation`).
 * Holds the lines of the one call this browser is on; it is cleared when the
 * call ends (the captions panel unmounts) and replaced by the next call's lines.
 */

import { atom } from 'jotai';
import {
  phoneCaptionEventSchema,
  phoneTranslationEventSchema,
  type PhoneCaptionEvent,
  type PhoneTranslationEvent,
} from '@weldsuite/core-api-client/schemas/desk-call-translation';

/** Lines kept on screen: a long call does not grow without bound. */
export const MAX_CAPTION_LINES = 200;

export interface CallTranslationLive {
  callId: string;
  lines: PhoneCaptionEvent[];
  /** The caller's language once the server has detected it. */
  callerLanguage: string | null;
  speakAvailable: boolean | null;
  /** The system stopped the translation (the agent's own Stop is not a reason). */
  stoppedReason: 'no_credits' | 'call_ended' | null;
  /** Any stop, the agent's included. */
  stopped: boolean;
}

export const deskCallTranslationAtom = atom<CallTranslationLive | null>(null);

function emptyLive(callId: string): CallTranslationLive {
  return { callId, lines: [], callerLanguage: null, speakAvailable: null, stoppedReason: null, stopped: false };
}

/** The live state of `callId`: the previous one while it is the same call, a fresh one otherwise. */
function forCall(prev: CallTranslationLive | null, callId: string): CallTranslationLive {
  return prev?.callId === callId ? prev : emptyLive(callId);
}

/** Add a line in time order; a line seen twice (a replayed event) is kept once. */
export function withCaption(prev: CallTranslationLive | null, caption: PhoneCaptionEvent): CallTranslationLive {
  const live = forCall(prev, caption.callId);
  if (live.lines.some((line) => line.lineId === caption.lineId)) return live;
  const lines = [...live.lines, caption].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_CAPTION_LINES);
  return { ...live, lines };
}

export function withTranslationEvent(prev: CallTranslationLive | null, event: PhoneTranslationEvent): CallTranslationLive {
  const live = forCall(prev, event.callId);
  return {
    ...live,
    callerLanguage: event.callerLanguage ?? live.callerLanguage,
    speakAvailable: event.speakAvailable,
    stopped: !event.active,
    stoppedReason: event.active ? null : event.stoppedReason,
  };
}

/** Starting again begins a clean transcript. */
export function cleared(prev: CallTranslationLive | null, callId: string): CallTranslationLive | null {
  return prev?.callId === callId ? null : prev;
}

/** The realtime payloads are untyped on the wire: null for one that is not a caption. */
export function parseCaption(data: unknown): PhoneCaptionEvent | null {
  const parsed = phoneCaptionEventSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function parseTranslationEvent(data: unknown): PhoneTranslationEvent | null {
  const parsed = phoneTranslationEventSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
