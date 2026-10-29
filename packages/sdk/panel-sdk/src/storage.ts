/**
 * Everything the SDK keeps in the browser: one localStorage key per project
 * with the visitor's ids (only after consent, ADR PANEL-006) and one opt-out
 * flag per site. No cookies, no sessionStorage.
 *
 * Storage can be missing or throw (Safari private mode, blocked site data);
 * the SDK then keeps its state in memory for the page's lifetime.
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
}

export const stateKey = (token: string): string => `weldpanel:${token}`;

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readState(token: string): VisitorState | null {
  try {
    const raw = store()?.getItem(stateKey(token));
    const v = raw ? (JSON.parse(raw) as Partial<VisitorState>) : null;
    return v && typeof v.a === 'string' && typeof v.s === 'string' && typeof v.t === 'number'
      ? { a: v.a, s: v.s, t: v.t, g: v.g === 1 ? 1 : 0 }
      : null;
  } catch {
    return null;
  }
}

export function writeState(token: string, state: VisitorState): void {
  try {
    store()?.setItem(stateKey(token), JSON.stringify(state));
  } catch {
    // Memory only for this page.
  }
}

export function clearState(token: string): void {
  try {
    store()?.removeItem(stateKey(token));
  } catch {
    // Nothing stored that we can reach.
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
