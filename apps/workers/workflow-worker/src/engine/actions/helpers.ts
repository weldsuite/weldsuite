/**
 * Shared helpers for the action handlers.
 */

import type { ActionContext, WorkflowEnv } from '../types';

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
