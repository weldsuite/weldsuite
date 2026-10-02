/**
 * Env for `@weldsuite/meet-domain/meeting-lifecycle` (end a session) when it
 * runs in the portal instead of a Cloudflare Worker.
 *
 * - RealtimeKit credentials come from `process.env`, like the rest of the portal.
 * - The workers' `REALTIME` service binding does not exist here, so it is
 *   replaced by a fetcher that sends the same `https://internal/publish/...`
 *   requests to the realtime-worker over HTTP, authenticated with
 *   `REALTIME_INTERNAL_SECRET` (the way the guest chat route publishes).
 * - There is no KV namespace: the 24 h `rtk-meeting:<id>` mapping simply
 *   expires on its own.
 */

import type {
  MeetingLifecycleEnv,
  RealtimeFetcher,
} from '@weldsuite/meet-domain/meeting-lifecycle';
import { realtimeEnv } from './cloudflare-realtime';

/**
 * Rewrites `https://internal/<path>` to `<REALTIME_WORKER_URL>/<path>` and adds
 * the internal secret. Returns undefined (and warns) when either env var is
 * missing, so the lifecycle skips the live push instead of failing.
 */
export function realtimeWorkerFetcher(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): RealtimeFetcher | undefined {
  const base = env.REALTIME_WORKER_URL?.replace(/\/$/, '');
  const secret = env.REALTIME_INTERNAL_SECRET;
  if (!base || !secret) {
    console.warn(
      '[meeting-portal] Realtime publish disabled: REALTIME_WORKER_URL / REALTIME_INTERNAL_SECRET is not set. The platform will not see live session updates from guest leaves.',
    );
    return undefined;
  }

  return {
    fetch(input, init) {
      const source = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      headers.set('x-internal-secret', secret);
      return fetchImpl(`${base}${source.pathname}${source.search}`, { ...init, headers });
    },
  };
}

export function meetingLifecycleEnv(): MeetingLifecycleEnv {
  const { CF_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_APP_SECRET } = realtimeEnv();
  return { CF_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_APP_SECRET, REALTIME: realtimeWorkerFetcher() };
}
