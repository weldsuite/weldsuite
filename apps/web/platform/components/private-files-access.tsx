import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getAppApiUrl } from '@/lib/api/public-env';

/**
 * Keeps the files cookie for the active workspace fresh (TASK-620).
 *
 * Private uploads (drive files, attachments, receipts) live in a bucket with
 * no public domain; their URLs point at app-api `/api/storage/private/<key>`.
 * `POST /api/storage/access` sets a short-lived HttpOnly cookie, path-scoped
 * to the workspace's keys, so `<img>`, `<a href>` and `<video>` on those URLs
 * just work without a bearer header at every render site. This component asks
 * for it on sign-in and on every workspace switch, and again before it lapses.
 * Renders nothing.
 */

const REFRESH_BEFORE_SECONDS = 10 * 60;
const RETRY_SECONDS = 60;
const storageKey = (orgId: string) => `ws-files-access:${orgId}`;

function readExpiry(orgId: string): number {
  try {
    return Number(localStorage.getItem(storageKey(orgId))) || 0;
  } catch {
    return 0;
  }
}

function writeExpiry(orgId: string, expiresAt: number) {
  try {
    localStorage.setItem(storageKey(orgId), String(expiresAt));
  } catch {
    // Private mode or blocked storage: we just refresh on the next mount.
  }
}

export function PrivateFilesAccess() {
  const { isSignedIn, orgId, getToken } = useAuth();

  useEffect(() => {
    if (!isSignedIn || !orgId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (seconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(refresh, Math.max(seconds, 5) * 1000);
    };

    async function refresh() {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        const res = await fetch(`${getAppApiUrl()}/api/storage/access`, {
          method: 'POST',
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`files access ${res.status}`);
        const { data } = (await res.json()) as { data: { expiresAt: number } };
        if (cancelled) return;
        writeExpiry(orgId!, data.expiresAt);
        schedule(data.expiresAt - Date.now() / 1000 - REFRESH_BEFORE_SECONDS);
      } catch {
        if (!cancelled) schedule(RETRY_SECONDS);
      }
    }

    const remaining = () => readExpiry(orgId) - Date.now() / 1000;
    if (remaining() > REFRESH_BEFORE_SECONDS) schedule(remaining() - REFRESH_BEFORE_SECONDS);
    else void refresh();

    // Timers stall while a laptop sleeps; catch up when the tab is back.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && remaining() < REFRESH_BEFORE_SECONDS) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isSignedIn, orgId, getToken]);

  return null;
}
