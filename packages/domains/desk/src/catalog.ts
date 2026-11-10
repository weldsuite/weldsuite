/**
 * What a WeldDesk service request does after the rows change, for writers in
 * different workers (desk-api when an agent decides an approval or makes a
 * conversation a request, helpdesk-widget-api when a customer submits one):
 *
 *   - `fulfilDeskCatalogRequest`: the item's fulfilment tasks become WeldFlow
 *     tasks linked to the conversation (`tasks.source_type = 'desk_conversation'`),
 *     each announced like flow-api announces a task (`project_task created`,
 *     an assignment notification), and the timeline gets `fulfilment_started`.
 *     Idempotent per conversation.
 *   - `notifyDeskApprover`: the approver of a step that just opened hears about it.
 *
 * The rows are written by `@weldsuite/db/lib/desk-catalog`. Both functions
 * are meant for `executionCtx.waitUntil`: they never throw, a failure is
 * logged and the request that triggered them is unaffected.
 */

import { createAndDeliverNotification, sendTaskAssignmentNotification, type NotificationEnv } from '@weldsuite/notifications';
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { taskAnalyticsPayload } from '@weldsuite/flow-domain/analytics-payload';
import type { DeskConversation } from '@weldsuite/db/lib/desk';
import {
  hasDeskFulfilmentStarted,
  recordDeskRequestFulfilment,
  type DeskCatalogItem,
  type DeskRequestApproval,
} from '@weldsuite/db/lib/desk-catalog';
import type { IdGenerator } from '@weldsuite/db/lib/mail-contacts';
import type { Database } from '@weldsuite/worker-kit/db';

export interface DeskCatalogContext {
  env: NotificationEnv & EntityEventPublisherEnv;
  /** The workspace's Clerk org id: notifications and entity events are still keyed by it. */
  clerkOrgId: string;
  generateId: IdGenerator;
}

const DAY_MS = 86_400_000;

/** The task a template creates, for `createTask`. */
function taskData(
  template: DeskCatalogItem['fulfilmentTasks'][number],
  conversation: Pick<DeskConversation, 'id' | 'assigneeId'>,
  now: Date,
): Record<string, unknown> {
  const assigneeId = template.assigneeId || conversation.assigneeId || undefined;
  return {
    title: template.title,
    description: template.description,
    assigneeId,
    dueDate: typeof template.dueInDays === 'number' ? new Date(now.getTime() + template.dueInDays * DAY_MS) : undefined,
    sourceType: 'desk_conversation',
    sourceId: conversation.id,
  };
}

export interface FulfilDeskCatalogRequestResult {
  /** The tasks that were created, in the item's order. */
  taskIds: string[];
}

/**
 * Create the item's fulfilment tasks for an approved (or approval-free)
 * request. The task goes to the template's assignee, else the conversation's,
 * else nobody; due `dueInDays` from now; no project. A request whose
 * `fulfilment_started` event exists is left alone, and an item without tasks
 * writes nothing. Returns null when it did nothing or failed.
 */
export async function fulfilDeskCatalogRequest(
  ctx: DeskCatalogContext,
  input: {
    db: Database;
    conversation: Pick<DeskConversation, 'id' | 'assigneeId'>;
    item: Pick<DeskCatalogItem, 'fulfilmentTasks'>;
    /** The member whose action approved the request; absent for the system. */
    actorUserId?: string | null;
  },
): Promise<FulfilDeskCatalogRequestResult | null> {
  const { db, conversation, item } = input;
  const actor = input.actorUserId ?? null;
  try {
    if (item.fulfilmentTasks.length === 0) return null;
    if (await hasDeskFulfilmentStarted(db, conversation.id)) return null;

    const now = new Date();
    const taskIds: string[] = [];
    for (const template of item.fulfilmentTasks) {
      const { row, assigneeIds } = await createTask(db, taskData(template, conversation, now), {
        projectId: null,
        userId: actor ?? 'system',
      });
      taskIds.push(row.id);
      await publishEntityEventRaw({
        env: ctx.env,
        workspaceId: ctx.clerkOrgId,
        userId: actor ?? 'system',
        entityType: 'project_task',
        action: 'created',
        entityId: row.id,
        data: taskAnalyticsPayload(row as Record<string, unknown>, { projectId: null }),
      });
      for (const assigneeId of assigneeIds) {
        await sendTaskAssignmentNotification({
          db,
          env: ctx.env,
          workspaceId: ctx.clerkOrgId,
          assigneeId,
          assignedByUserId: actor ?? 'system',
          taskId: row.id,
          taskTitle: row.title,
          category: 'crm',
          actionUrl: '/weldcrm/tasks',
          projectId: null,
          taskPriority: row.priority ?? null,
          dueDate: row.dueDate ?? null,
          taskDescription: row.description ?? null,
        }).catch((err: unknown) => console.error('[desk-catalog] task assignment notification failed:', err));
      }
    }

    const { conversation: after, message } = await recordDeskRequestFulfilment(db, {
      generateId: ctx.generateId,
      conversationId: conversation.id,
      authorId: actor,
      taskIds,
    });
    await publishEntityEventRaw({
      env: ctx.env,
      workspaceId: ctx.clerkOrgId,
      userId: actor ?? 'system',
      entityType: 'desk_conversation',
      action: 'updated',
      entityId: after.id,
      data: after as unknown as Record<string, unknown>,
    });
    await publishEntityEventRaw({
      env: ctx.env,
      workspaceId: ctx.clerkOrgId,
      userId: actor ?? 'system',
      entityType: 'desk_message',
      action: 'created',
      entityId: message.id,
      data: message as unknown as Record<string, unknown>,
    });
    return { taskIds };
  } catch (err) {
    console.error('[desk-catalog] fulfilment failed:', err);
    return null;
  }
}

/**
 * An in-app notification for the approver of a step that just opened:
 * "Approval needed: <item> for <requester>", linking to the inbox
 * conversation. A step without an approver notifies nobody (the approvals list
 * shows it to the catalogue's managers).
 */
export async function notifyDeskApprover(
  ctx: DeskCatalogContext,
  input: {
    db: Database;
    approval: Pick<DeskRequestApproval, 'approverId' | 'stepName' | 'stepIndex'>;
    conversation: Pick<DeskConversation, 'id' | 'name' | 'email' | 'title' | 'conversationNumber'>;
    item: Pick<DeskCatalogItem, 'name'> | null;
  },
): Promise<void> {
  const { approval, conversation, item } = input;
  if (!approval.approverId) return;
  try {
    const requester = conversation.name || conversation.email || 'a customer';
    const what = item?.name ?? conversation.title ?? 'Service request';
    await createAndDeliverNotification({
      db: input.db,
      env: ctx.env,
      workspaceId: ctx.clerkOrgId,
      userId: approval.approverId,
      title: `Approval needed: ${what} for ${requester}`,
      body: approval.stepName ? `${approval.stepName} · request #${conversation.conversationNumber}` : `Request #${conversation.conversationNumber}`,
      category: 'helpdesk',
      notificationType: 'custom',
      entityType: 'desk_conversation',
      entityId: conversation.id,
      actionUrl: `/welddesk/inbox/${conversation.id}`,
      severity: 'info',
      actorType: 'system',
      actorId: null,
      data: { conversationId: conversation.id, stepIndex: String(approval.stepIndex) },
    });
  } catch (err) {
    console.error('[desk-catalog] approver notification failed:', err);
  }
}
