/**
 * Client state shared by the WeldDesk phone pieces that never render together:
 * the headless softphone bridge writes it, the incoming-call card and the
 * "take calls" switch read it.
 */

import { atom } from 'jotai';
import type { DeskPhoneEndedReason } from './desk-phone-events';

/** The latest `phone.incoming` realtime event: who is calling this browser. */
export interface DeskPhoneIncoming {
  /** The WeldCall call row (not the Telnyx call id). */
  callId: string;
  conversationId: string | null;
  fromNumber: string;
  callerName: string | null;
  customerName: string | null;
  departmentId: string | null;
  /** ISO time the caller started waiting. */
  waitingSince: string;
  /** When the browser got the event (ms since epoch). */
  receivedAt: number;
}

export const deskPhoneIncomingAtom = atom<DeskPhoneIncoming | null>(null);

/** A ring that ended without this member answering it (`phone.ended`). */
export interface DeskPhoneEnded {
  callId: string;
  reason: DeskPhoneEndedReason;
  at: number;
}

export const deskPhoneEndedAtom = atom<DeskPhoneEnded | null>(null);

/**
 * Where the member's softphone stands, for the "take calls" switch:
 * `off` (switch off), `not_configured` (no telephony for this deployment),
 * `connecting`, `connected`, `mic_blocked` (signed in but the browser has the
 * microphone blocked) and `failed` (sign-in gave up).
 */
export type DeskSoftphoneStatus = 'off' | 'not_configured' | 'connecting' | 'connected' | 'mic_blocked' | 'failed';

export const deskSoftphoneStatusAtom = atom<DeskSoftphoneStatus>('off');

/** Bumped by the switch's "try again": the bridge starts its sign-in over. */
export const deskSoftphoneRetryAtom = atom(0);
