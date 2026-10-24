/**
 * Cross-tab coordination for OS / browser notifications.
 *
 * Every open tab of the platform holds its own realtime connection, so every
 * tab receives the same notification event. Without coordination each one
 * shows its own toast and plays its own chime. Two shared facts, kept in
 * localStorage (same origin = same browser profile), fix that:
 *
 *   • Which tab, if any, is in the foreground. A background tab must not toast
 *     while the user is looking at the app in another tab.
 *   • Which notifications were already shown. The first tab to claim a key
 *     shows the toast; the others skip it. Claims are serialised with the Web
 *     Locks API so two tabs receiving the event at the same moment cannot both
 *     win.
 *
 * Everything here is best-effort: when storage or locks are unavailable the
 * helpers fall back to "this tab decides alone", which is the old behaviour.
 */

const FOREGROUND_KEY = 'weldsuite:foreground-tab';
const CLAIMS_KEY = 'weldsuite:os-notification-claims';
const CLAIM_LOCK = 'weldsuite:os-notification-claim';

/** How often a foreground tab refreshes its record. */
const HEARTBEAT_MS = 5_000;
/** A foreground record older than this is from a tab that died without cleanup. */
const FOREGROUND_STALE_MS = 15_000;
/** How long a shown notification stays claimed. */
const CLAIM_TTL_MS = 60_000;

interface ForegroundRecord {
  tabId: string;
  at: number;
}

const tabId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full / blocked — coordination is best-effort.
  }
}

/** True when this tab is visible and its window has focus. */
function isThisTabInForeground(): boolean {
  if (typeof document === 'undefined') return false;
  return !document.hidden && document.hasFocus();
}

/** True when this tab, or any other tab of the app, is in the foreground. */
export function isAnyTabInForeground(): boolean {
  if (isThisTabInForeground()) return true;
  const record = readJson<ForegroundRecord>(FOREGROUND_KEY);
  if (!record || typeof record.at !== 'number') return false;
  return Date.now() - record.at < FOREGROUND_STALE_MS;
}

let trackingRefs = 0;
let stopTracking: (() => void) | null = null;

/**
 * Publish this tab's foreground state for the other tabs. Idempotent and
 * ref-counted; returns a cleanup function.
 */
export function startForegroundTracking(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  trackingRefs += 1;
  if (!stopTracking) {
    const sync = () => {
      if (isThisTabInForeground()) {
        writeJson(FOREGROUND_KEY, { tabId, at: Date.now() } satisfies ForegroundRecord);
        return;
      }
      // Only clear our own record: another tab may already have taken over.
      if (readJson<ForegroundRecord>(FOREGROUND_KEY)?.tabId === tabId) {
        try {
          localStorage.removeItem(FOREGROUND_KEY);
        } catch {
          // Best-effort.
        }
      }
    };

    sync();
    const interval = window.setInterval(() => {
      if (isThisTabInForeground()) sync();
    }, HEARTBEAT_MS);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    window.addEventListener('pagehide', sync);
    document.addEventListener('visibilitychange', sync);

    stopTracking = () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      window.removeEventListener('pagehide', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    trackingRefs -= 1;
    if (trackingRefs === 0 && stopTracking) {
      stopTracking();
      stopTracking = null;
    }
  };
}

function claimNow(key: string): boolean {
  const now = Date.now();
  const claims = readJson<Record<string, number>>(CLAIMS_KEY) ?? {};
  const live: Record<string, number> = {};
  for (const [k, expiresAt] of Object.entries(claims)) {
    if (typeof expiresAt === 'number' && expiresAt > now) live[k] = expiresAt;
  }
  if (live[key]) return false;
  live[key] = now + CLAIM_TTL_MS;
  writeJson(CLAIMS_KEY, live);
  return true;
}

/**
 * Claim the right to show the notification identified by `key`. Resolves true
 * for exactly one tab; the others resolve false and should stay quiet.
 */
export async function claimCrossTabNotification(key: string): Promise<boolean> {
  if (typeof localStorage === 'undefined') return true;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return claimNow(key);
  try {
    return await locks.request(CLAIM_LOCK, () => claimNow(key));
  } catch {
    return claimNow(key);
  }
}
