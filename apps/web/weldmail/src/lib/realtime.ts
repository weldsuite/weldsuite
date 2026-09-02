/**
 * Realtime endpoint resolution for the consumer WeldMail SPA.
 *
 * Personal accounts have no Clerk organization, so they connect to the
 * realtime worker's `/ws/personal` upgrade rather than `/ws` — that route
 * binds the socket to a hub named `personal:<clerkUserId>` and limits the
 * subscription to the caller's own mail topic.
 */

const LOCAL_REALTIME = 'ws://localhost:8790/ws/personal';
const PRODUCTION_REALTIME = 'wss://realtime.weldsuite.org/ws/personal';
const TEST_REALTIME = 'wss://realtime-test.weldsuite.org/ws/personal';

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
}

/**
 * Resolve the WebSocket URL.
 *
 * An explicit `VITE_REALTIME_URL` always wins. Otherwise the hostname decides,
 * so a preview build doesn't have to carry a separate env file: anything on a
 * `*-test` host talks to the test worker, everything else to production.
 */
export function getRealtimeUrl(): string {
  const envUrl = import.meta.env.VITE_REALTIME_URL;
  if (envUrl) return envUrl;

  const host = typeof window === 'undefined' ? '' : window.location.hostname;
  if (!host || isLocalHostname(host)) return LOCAL_REALTIME;
  if (host.includes('-test') || host.startsWith('test.')) return TEST_REALTIME;
  return PRODUCTION_REALTIME;
}

/** Topic carrying this user's mail events inside their personal hub. */
export function mailTopic(clerkUserId: string): string {
  return `mail.${clerkUserId}`;
}
