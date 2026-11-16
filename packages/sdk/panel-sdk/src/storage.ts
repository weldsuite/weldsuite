/**
 * Everything the SDK keeps in the browser (ADR PANEL-006). Before consent:
 * nothing but the opt-out flag, if the visitor opted out. After consent:
 *
 * - localStorage `weldpanel:<token>`: the visitor's ids and user id;
 * - localStorage `weldpanel:<token>:rec`: whether this session is recorded and
 *   the next recording chunk number, shared by the session's tabs;
 * - sessionStorage `weldpanel:<token>`: this tab's last page (quick backs),
 *   errors already reported this session, heatmap snapshots already taken.
 *
 * No cookies. Storage can be missing or throw (Safari private mode, blocked
 * site data); the SDK then keeps its state in memory for the page's lifetime.
 */

import { uuid } from './event';

/** A visit ends after 30 minutes without events. */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const OPT_OUT_KEY = 'weldpanel:optout';

export interface VisitorState {
  /** Anonymous id, `a_` + UUID. */
  a: string;
  /** Session id, `s_` + UUID. */
  s: string;
  /** Last event, epoch ms. */
  t: number;
  /** 1 when `consent.grant()` created it, 0 when the project needs no consent. */
  g: 0 | 1;
  /** The user id from `identify()`. */
  u?: string;
}

export const stateKey = (token: string): string => `weldpanel:${token}`;
export const recordingKey = (token: string): string => `weldpanel:${token}:rec`;

function store(session?: boolean): Storage | null {
  try {
    return session ? sessionStorage : localStorage;
  } catch {
    return null;
  }
}

/** A JSON value from storage, or null when it is missing, unreadable or not an object. */
export function readJson<T extends object>(key: string, session?: boolean): Partial<T> | null {
  try {
    const v = JSON.parse(store(session)?.getItem(key) || 'null') as unknown;
    return v && typeof v === 'object' ? (v as Partial<T>) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: object, session?: boolean): void {
  try {
    store(session)?.setItem(key, JSON.stringify(value));
  } catch {
    // Memory only for this page.
  }
}

export function readState(token: string): VisitorState | null {
  const v = readJson<VisitorState>(stateKey(token));
  return v && typeof v.a === 'string' && typeof v.s === 'string' && typeof v.t === 'number'
    ? { a: v.a, s: v.s, t: v.t, g: v.g === 1 ? 1 : 0, ...(typeof v.u === 'string' ? { u: v.u } : {}) }
    : null;
}

export function writeState(token: string, state: VisitorState): void {
  writeJson(stateKey(token), state);
}

/** Deletes everything kept for the project: ids, recording state, this tab's session record. */
export function clearState(token: string): void {
  for (const [key, session] of [
    [stateKey(token), false],
    [recordingKey(token), false],
    [stateKey(token), true],
  ] as const) {
    try {
      store(session)?.removeItem(key);
    } catch {
      // Nothing stored that we can reach.
    }
  }
}

export function newState(granted: boolean, now: number): VisitorState {
  return { a: `a_${uuid()}`, s: `s_${uuid()}`, t: now, g: granted ? 1 : 0 };
}

/** Rolls the session after {@link SESSION_TIMEOUT_MS} of silence and records this event's time. */
export function touchSession(state: VisitorState, now: number): VisitorState {
  return { ...state, s: now - state.t > SESSION_TIMEOUT_MS ? `s_${uuid()}` : state.s, t: now };
}

export function isOptedOut(): boolean {
  try {
    return store()?.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setOptedOut(value: boolean): void {
  try {
    const s = store();
    if (value) s?.setItem(OPT_OUT_KEY, '1');
    else s?.removeItem(OPT_OUT_KEY);
  } catch {
    // The opt-out still holds for this page.
  }
}

/** `weldpanel:<token>:rec`: the recording decision and chunk counter of one session. */
export interface RecordingState {
  /** Session id. */
  s: string;
  /** 1 when the session is recorded. */
  r: 0 | 1;
  /** The next chunk number. */
  q: number;
}

/**
 * Whether the session is recorded: decided once, at `rate`, and kept with the
 * session so every tab and page of it agrees. Only called with consent.
 */
export function sampleSession(token: string, sessionId: string, rate: number): boolean {
  const v = readJson<RecordingState>(recordingKey(token));
  if (v && v.s === sessionId && (v.r === 0 || v.r === 1)) return v.r === 1;
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 < rate ? 1 : 0;
  writeJson(recordingKey(token), { s: sessionId, r, q: 0 });
  return r === 1;
}

/** The next chunk number of the session (0 for its first), counted across its tabs and pages. */
export function nextSeq(token: string, sessionId: string): number {
  const key = recordingKey(token);
  const v = readJson<RecordingState>(key);
  const stored = v && v.s === sessionId && typeof v.q === 'number' ? v.q : 0;
  // Storage may be unavailable or refuse writes: this page's own count still never repeats a number.
  const m = memorySeq.get(key);
  const q = Math.max(stored, m && m.s === sessionId ? m.q : 0);
  memorySeq.set(key, { s: sessionId, q: q + 1 });
  writeJson(key, { s: sessionId, r: 1, q: q + 1 });
  return q;
}

const memorySeq = new Map<string, { s: string; q: number }>();

/** Forgets the in-memory chunk counters. Tests only. */
export function resetSeqMemory(): void {
  memorySeq.clear();
}
