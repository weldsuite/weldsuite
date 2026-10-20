/**
 * Realtime Publisher — HTTP client for the realtime-worker.
 *
 * Since the Discord bot runs on Hetzner (not Cloudflare), it can't use
 * the RealtimePublisher service binding. Instead, it calls the
 * realtime-worker's HTTP endpoints directly, authenticating every request
 * with REALTIME_INTERNAL_SECRET (the realtime-worker refuses a publish
 * without it).
 */

import { getEnv } from './env.js';

/** Header the realtime-worker reads the internal secret from (REALTIME_INTERNAL_SECRET_HEADER in @weldsuite/realtime/server). */
const INTERNAL_SECRET_HEADER = 'x-internal-secret';

function getRealtimeUrl(): string {
  try {
    return getEnv().REALTIME_WORKER_URL || '';
  } catch {
    return process.env.REALTIME_WORKER_URL || '';
  }
}

function getRealtimeSecret(): string {
  try {
    return getEnv().REALTIME_INTERNAL_SECRET || '';
  } catch {
    return process.env.REALTIME_INTERNAL_SECRET || '';
  }
}

/**
 * Request headers for a publish, or null (with a warning) when the secret is
 * not configured: the realtime-worker would answer 403 anyway.
 */
function publishHeaders(): Record<string, string> | null {
  const secret = getRealtimeSecret();
  if (!secret) {
    console.warn('[Realtime] REALTIME_INTERNAL_SECRET not set, skipping publish');
    return null;
  }
  return { 'Content-Type': 'application/json', [INTERNAL_SECRET_HEADER]: secret };
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
  const headers = publishHeaders();
  if (!headers) return;

  try {
    const res = await fetch(`${url}/publish/workspace`, {
      method: 'POST',
      headers,
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
  const headers = publishHeaders();
  if (!headers) return;

  try {
    await fetch(`${url}/publish/conversation/${conversationId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Realtime] Failed to publish to conversation ${conversationId}:`, err);
  }
}
