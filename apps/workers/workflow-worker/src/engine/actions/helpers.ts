/**
 * Shared helpers for the action handlers.
 */

import type { ActionContext, WorkflowEnv } from '../types';

/**
 * POST to an app-api `/api/internal/*` route with the shared
 * INTERNAL_API_SECRET bearer (apps/workers/app-api/src/routes/internal/index.ts).
 * This worker's secret must match app-api's for the auth to pass. Throws with
 * the response body on a non-2xx so the step fails with a useful message.
 */
export async function postInternalApi<T>(
  env: WorkflowEnv,
  path: string,
  body: unknown,
  label: string,
): Promise<T> {
  const appApiUrl = env.APP_API_URL
    ? String(env.APP_API_URL).replace(/\/+$/, '')
    : 'https://app-api.weldsuite.org';
  const internalSecret = env.INTERNAL_API_SECRET;
  if (!internalSecret) throw new Error(`INTERNAL_API_SECRET not configured for ${label}`);

  const response = await fetch(`${appApiUrl}/api/internal${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${internalSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`${label} failed: ${response.status} - ${errorBody}`);
  }
  return (await response.json()) as T;
}

/** Resolve the target conversation id from inputs or the triggering event. */
export function resolveConversationId(
  inputs: Record<string, unknown>,
  context: ActionContext,
): string | null {
  if (inputs.conversationId) return String(inputs.conversationId);
  const td = context.triggerData as Record<string, unknown> | undefined;
  if (td?.entityType === 'helpdesk_conversation') return String(td.entityId);
  if (td?.data && typeof td.data === 'object' && 'conversationId' in (td.data as object)) {
    return String((td.data as Record<string, unknown>).conversationId);
  }
  return null;
}

/** Best-effort realtime publish (no-op when REALTIME isn't bound). */
export async function publishRealtime(
  env: WorkflowEnv,
  workspaceId: string,
  channel: string,
  event: string,
  data: unknown,
): Promise<void> {
  if (!env.REALTIME) return;
  try {
    const { RealtimePublisher } = await import('@weldsuite/realtime/server');
    const rt = new RealtimePublisher(env.REALTIME);
    if (channel.startsWith('conversation:')) {
      const convId = channel.split(':')[1];
      await rt.conversationPublish(convId, {
        type: event,
        ...(data && typeof data === 'object' ? data : { data }),
        ts: Date.now(),
      });
    } else {
      await rt.publish(workspaceId, channel.replace(`workspace:${workspaceId}`, 'helpdesk'), event, data, 'system');
    }
  } catch (err) {
    console.warn(`[Realtime] Failed to publish ${event}: ${err}`);
  }
}
