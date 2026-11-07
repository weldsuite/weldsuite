/**
 * WeldDesk escalation rules, run by the SLA sweep (./sla-sweep.ts) on the same
 * due index: a desk write stores when a conversation's team rules next need
 * checking (`desk_conversations.escalationCheckAt`, refreshDeskSla) and folds
 * it into the workspace's due time, so a due workspace is opened once for both.
 *
 * For each conversation whose check came due, `runDeskEscalations` fires the
 * rules that are due (`@weldsuite/db/lib/desk-escalation`). Every timeline
 * event it wrote goes out as a `desk_conversation` entity event (`assigned`
 * when the owner changed, else `updated`) and live to the inbox; a public
 * notice to the customer also reaches their conversation room; whoever now
 * owns the conversation is told.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { sendTicketAssignedNotification } from '@weldsuite/notifications';
import { isPublicDeskMessage, toPublicDeskMessage } from '@weldsuite/db/lib/desk';
import { deskAssignmentRouterPicker } from '@weldsuite/db/lib/desk-assignment';
import { listDueDeskEscalations } from '@weldsuite/db/lib/desk-escalation-check';
import {
  backOffDeskEscalation,
  runDeskEscalations,
  type DeskEscalationResult,
} from '@weldsuite/db/lib/desk-escalation';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../types';

type TenantDb = Variables['tenantDb'];

/** A conversation whose escalation failed is looked at again after this. */
const CONVERSATION_RETRY_MS = 30 * 60_000;
/** Conversations per workspace per tick; the rest stay due for the next tick. */
const CONVERSATIONS_PER_TICK = 100;

/** Publish what one conversation's escalation wrote. Best-effort. */
async function publishEscalation(env: Env, db: TenantDb, orgId: string, result: DeskEscalationResult): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  for (const step of result.steps) {
    jobs.push(
      publishEntityEventRaw({
        env,
        workspaceId: orgId,
        userId: 'system',
        entityType: 'desk_conversation',
        action: step.action,
        entityId: step.conversation.id,
        data: step.conversation as unknown as Record<string, unknown>,
      }),
    );
  }
  if (env.REALTIME && result.steps.length > 0) {
    const rt = new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
    for (const step of result.steps) {
      jobs.push(rt.publish(orgId, 'desk_conversation', 'updated', step.conversation, 'system'));
      jobs.push(rt.publish(orgId, 'desk_message', 'created', step.message, 'system'));
      if (isPublicDeskMessage(step.message) && step.message.kind === 'message') {
        jobs.push(
          rt.conversationPublish(step.conversation.id, {
            type: 'message',
            id: step.message.id,
            content: step.message.body ?? '',
            senderId: 'system',
            senderName: 'Support',
            senderType: 'system',
            ts: Date.now(),
            record: toPublicDeskMessage(step.message, new Map()),
          }),
        );
      }
    }
  }
  const conversation = result.conversation;
  if (conversation) {
    for (const userId of result.newOwners) {
      jobs.push(
        sendTicketAssignedNotification({
          db,
          env,
          workspaceId: orgId,
          assigneeId: userId,
          assignedByUserId: null,
          kind: 'conversation',
          entityId: conversation.id,
          subject: conversation.title || conversation.name || conversation.email,
          reference: `#${conversation.conversationNumber}`,
        }),
      );
    }
  }
  for (const outcome of await Promise.allSettled(jobs)) {
    if (outcome.status === 'rejected') console.error('[DeskEscalation] publishing failed:', outcome.reason);
  }
}

/**
 * Run one workspace's due escalation rules; returns how many conversations
 * were escalated. `publish` is replaceable for tests.
 */
export async function sweepWorkspaceEscalations(
  env: Env,
  db: TenantDb,
  orgId: string,
  now: Date,
  publish: typeof publishEscalation = publishEscalation,
): Promise<number> {
  let escalated = 0;
  const retryAt = new Date(now.getTime() + CONVERSATION_RETRY_MS);
  const ids = await listDueDeskEscalations(db, now, CONVERSATIONS_PER_TICK);
  for (const id of ids) {
    try {
      const result = await runDeskEscalations(db, {
        generateId,
        conversationId: id,
        now,
        pick: deskAssignmentRouterPicker(env.HELPDESK_WORKFLOW, orgId),
      });
      if (result.steps.length > 0) escalated += 1;
      await publish(env, db, orgId, result);
    } catch (err) {
      console.error(`[DeskEscalation] conversation ${id} in ${orgId} failed:`, err);
      await backOffDeskEscalation(db, id, retryAt).catch((retryErr: unknown) =>
        console.warn(`[DeskEscalation] could not back off ${id}:`, retryErr),
      );
    }
  }
  return escalated;
}
