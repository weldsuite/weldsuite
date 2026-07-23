/**
 * Realtime Publisher — HTTP client for the realtime-worker.
 *
 * Since the Discord bot runs on Hetzner (not Cloudflare), it can't use
 * the RealtimePublisher service binding. Instead, it calls the
 * realtime-worker's HTTP endpoints directly.
 */

import { getEnv } from './env.js';

function getRealtimeUrl(): string {
  try {
    return getEnv().REALTIME_WORKER_URL || '';
  } catch {
    return process.env.REALTIME_WORKER_URL || '';
  }
}

/**
 * Publish a helpdesk event to the workspace hub.
 * This notifies all connected agents in the platform UI.
 */
export async function publishHelpdeskEvent(
  workspaceId: string,
  event: string,
  data: unknown,
): Promise<void> {
  const url = getRealtimeUrl();
  if (!url) {
    console.warn('[Realtime] REALTIME_WORKER_URL not set, skipping publish');
    return;
  }

  try {
    const res = await fetch(`${url}/publish/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        topic: 'helpdesk',
        event,
        data,
        userId: 'system',
      }),
    });
    console.log(`[Realtime] Published ${event} to workspace ${workspaceId} (${res.status})`);
  } catch (err) {
    console.error(`[Realtime] Failed to publish ${event}:`, err);
  }
}

/**
 * Publish an event to a specific conversation room.
 */
export async function publishConversationEvent(
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = getRealtimeUrl();
  if (!url) return;

  try {
    await fetch(`${url}/publish/conversation/${conversationId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Realtime] Failed to publish to conversation ${conversationId}:`, err);
  }
}
