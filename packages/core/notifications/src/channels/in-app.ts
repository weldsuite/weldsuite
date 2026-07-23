/**
 * In-app channel — publishes a `notification:created` event to the user's
 * personal topic on the realtime-worker WorkspaceHub, which fans it out to
 * the `useNotifications` hook on the platform.
 *
 * Publishes via @weldsuite/realtime. When the REALTIME service binding is
 * absent (e.g. local dev without realtime-worker running), this becomes a
 * no-op rather than throwing — in-app delivery is best-effort.
 */

/** Subset of Cloudflare's Fetcher we need. Declared structurally so this
 *  module doesn't depend on `@cloudflare/workers-types` at runtime. */
interface RealtimeBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface InAppParams {
  realtime: RealtimeBinding | undefined;
  workspaceId: string;
  userId: string;
  notification: {
    id: string;
    title: string;
    body: string;
    category: string;
    actionUrl: string;
    entityType: string;
    entityId: string;
  };
}

/**
 * Publish a `notification:created` event to the user's personal topic.
 * Matches `RealtimePublisher.notify()` in `@weldsuite/realtime`: the
 * recipient access list rides along under `_access.userIds` so the DO
 * only fans the event out to that user's WebSockets.
 */
export async function publishInAppNotification(params: InAppParams): Promise<void> {
  const { realtime, workspaceId, userId, notification } = params;
  if (!realtime) return;

  const topic = `notification.${userId}`;
  const payload = { ...notification, _access: { userIds: [userId] } };

  const res = await realtime.fetch('https://internal/publish/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      topic,
      event: 'created',
      data: payload,
      userId: 'system',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[realtime notify] ${res.status} ${res.statusText}: ${body}`);
  }
}
