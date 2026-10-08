/**
 * The link a redirect flow left behind. Redirect providers (Ponto, Enable
 * Banking) and Plaid's OAuth banks take the browser away and bring it back to
 * the callback route, which finds out here which provider and connection the
 * return belongs to. Kept in sessionStorage: it belongs to this tab and goes
 * away with it. Never holds an access token; the Plaid link token is the
 * short-lived, single-use token Plaid asks to be re-opened with.
 */
import type { BankFeedLinkKind, BankFeedLinkMode } from '@/lib/api/domains/weldbooks-bank-feeds';

const STORAGE_KEY = 'weldsuite.bankFeeds.pendingLink';
/** A bank sign-in that has not come back after this long is abandoned. */
const MAX_AGE_MS = 60 * 60 * 1000;

export interface PendingLink {
  provider: string;
  kind: BankFeedLinkKind;
  mode: BankFeedLinkMode;
  connectionId?: string;
  /** What was sent to `link-session` as `redirectUrl`; Ponto checks it again at the token exchange. */
  redirectUrl: string;
  /** In-app path to go back to when the link is done. */
  returnTo: string;
  /** Bank account the user started from, to offer in the account mapping. */
  defaultBankAccountId?: string;
  /** The `state` the bank will echo back, when the authorization URL carried one. */
  state?: string;
  /** Plaid: re-open Link with this token after an OAuth bank returns. */
  linkToken?: string;
  startedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePendingLink(link: Omit<PendingLink, 'startedAt'>, now: number = Date.now()): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...link, startedAt: now } satisfies PendingLink));
  } catch {
    // Storage full or blocked: the redirect still works, the callback reports that the link was lost.
  }
}

function isPendingLink(value: unknown): value is PendingLink {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.provider === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.mode === 'string' &&
    typeof v.redirectUrl === 'string' &&
    typeof v.returnTo === 'string' &&
    typeof v.startedAt === 'number'
  );
}

/** The saved link, or null when there is none, it is malformed, or it is too old. */
export function readPendingLink(now: number = Date.now()): PendingLink | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingLink(parsed) || now - parsed.startedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingLink(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The `state` query parameter of an authorization URL, when it has one. */
export function stateOfAuthorizationUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
}

/** A path inside WeldBooks, so a stored `returnTo` can never send the user elsewhere. */
export function safeReturnPath(path: string | null | undefined, fallback = '/weldbooks/banking/feeds'): string {
  if (path && path.startsWith('/weldbooks/') && !path.startsWith('//')) return path;
  return fallback;
}
