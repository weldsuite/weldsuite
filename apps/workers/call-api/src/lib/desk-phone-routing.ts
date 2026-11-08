/**
 * An inbound call on the WeldDesk inbox, after `ingestDeskPhone`: the hub
 * events (`desk_conversation created` for a new conversation, `desk_message
 * created` for the caller's message), so WeldConnect workflows triggered by
 * phone conversations run; then routing (`@weldsuite/db/lib/desk-routing`, a
 * new conversation only) and auto-assignment, as the widget and email paths
 * do, each step published like theirs.
 */

import { eq } from 'drizzle-orm';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';
import { autoAssignDeskConversation, deskAssignmentRouterPicker } from '@weldsuite/db/lib/desk-assignment';
import { routeAndAssignDeskConversation, type DeskRoutingStep } from '@weldsuite/db/lib/desk-routing';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env } from '../types';

async function publish(
  env: Env,
  db: Database,
  workspaceId: string,
  entityType: 'desk_conversation' | 'desk_message',
  action: 'created' | 'updated' | 'assigned',
  row: DeskConversation | DeskMessage,
): Promise<void> {
  await publishEntityEventRaw({
    env,
    db,
    workspaceId,
    userId: 'system',
    entityType,
    action,
    entityId: row.id,
    data: row as unknown as Record<string, unknown>,
    source: 'system',
  });
}

/** Publish, route and assign a call that just landed. Best-effort: a failure never fails the webhook. */
export async function announceDeskPhoneCall(args: {
  env: Env;
  db: Database;
  /** Clerk org id (what events, realtime and the assignment router key on). */
  workspaceId: string;
  conversationId: string;
  message: DeskMessage;
  created: boolean;
}): Promise<void> {
  const { env, db, workspaceId, conversationId, message, created } = args;
  try {
    const [conversation] = await db
      .select()
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, conversationId))
      .limit(1);
    if (!conversation) return;
    if (created) await publish(env, db, workspaceId, 'desk_conversation', 'created', conversation);
    await publish(env, db, workspaceId, 'desk_message', 'created', message);

    const pick = deskAssignmentRouterPicker(env.HELPDESK_WORKFLOW, workspaceId);
    let steps: DeskRoutingStep[] = [];
    let slaCheckAt: Date | null = null;
    if (created) {
      ({ steps, slaCheckAt } = await routeAndAssignDeskConversation(db, {
        generateId,
        conversationId,
        pick,
        trigger: 'opened',
      }));
    } else if (!conversation.assigneeId && conversation.state === 'open') {
      const assigned = await autoAssignDeskConversation(db, { generateId, conversationId, pick });
      if (assigned) {
        steps = [{ conversation: assigned.conversation, message: assigned.message, action: 'assigned' }];
        slaCheckAt = assigned.slaCheckAt;
      }
    }
    if (slaCheckAt) await markWorkspaceDue(env.SCHEDULE_INDEX, 'desk_sla', workspaceId, slaCheckAt);
    for (const step of steps) {
      await publish(env, db, workspaceId, 'desk_conversation', step.action, step.conversation);
      if (!env.REALTIME) continue;
      try {
        const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
        await rt.publish(workspaceId, 'desk_conversation', 'updated', step.conversation, 'system');
        await rt.publish(workspaceId, 'desk_message', 'created', step.message, 'system');
      } catch (err) {
        console.error('[desk-phone] realtime publish failed:', err);
      }
    }
  } catch (err) {
    console.error('[desk-phone] routing / auto-assignment failed:', err);
  }
}
