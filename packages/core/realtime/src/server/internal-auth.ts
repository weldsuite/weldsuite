/**
 * Authentication of server-side publishes to the realtime-worker.
 *
 * Every `/publish/*` route of the realtime-worker takes caller-supplied
 * workspace, room and user ids, so a request that reaches one can inject events
 * into any tenant's live stream. Whoever publishes therefore proves it with a
 * shared secret in this header, on every request, whether it arrives over a
 * service binding (the workers, via `RealtimePublisher`) or over HTTP (the
 * admin console, the meeting portal, the Discord bot). The realtime-worker
 * compares it in constant time and answers 403 when the secret does not match
 * or is not configured.
 *
 * The secret is the `REALTIME_INTERNAL_SECRET` environment value of both the
 * realtime-worker and each publisher.
 */
export const REALTIME_INTERNAL_SECRET_HEADER = 'x-internal-secret';
