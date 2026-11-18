/**
 * What a WeldDesk service request does after the rows change, for writers in
 * different workers (desk-api when an agent decides an approval or makes a
 * conversation a request, helpdesk-widget-api when a customer submits one):
 *
 *   - `fulfilDeskCatalogRequest`: the item's fulfilment tasks become WeldFlow
 *     tasks linked to the conversation (`tasks.source_type = 'desk_conversation'`),
 *     each announced like flow-api announces a task (`project_task created`,
 *     an assignment notification), and the timeline gets `fulfilment_started`.
 *     Idempotent per conversation, and a second run after a failure creates
 *     only the tasks the first one did not get to.
 *   - `notifyDeskApprover`: the approver of a step that just opened hears about it.
 *
 * The rows are written by `@weldsuite/db/lib/desk-catalog`. Both functions
 * are meant for `executionCtx.waitUntil`: they never throw, a failure is
 * logged and the request that triggered them is unaffected.
 * `runDeskCatalogFulfilment` is the same fulfilment for a caller that waits
 * for it and answers with its outcome (the retry route): it throws.
 */

import { createAndDeliverNotification, sendTaskAssignmentNotification, type NotificationEnv } from '@weldsuite/notifications';
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { taskAnalyticsPayload } from '@weldsuite/flow-domain/analytics-payload';
import type { DeskConversation } from '@weldsuite/db/lib/desk';
import {
  hasDeskFulfilmentStarted,
  listDeskRequestTasks,
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
  /** The request's tasks, in the item's order: the ones this run created and the ones an earlier run left. */
  taskIds: string[];
  /** How many of them this run created. */
  created: number;
}

export interface FulfilDeskCatalogRequestInput {
  db: Database;
  conversation: Pick<DeskConversation, 'id' | 'assigneeId'>;
  item: Pick<DeskCatalogItem, 'fulfilmentTasks'>;
  /** The member whose action approved the request; absent for the system. */
  actorUserId?: string | null;
}

type TaskTemplate = DeskCatalogItem['fulfilmentTasks'][number];

/** One template's task: created, announced (`project_task created`) and its assignee told. Its id. */
async function createFulfilmentTask(
  ctx: DeskCatalogContext,
  input: FulfilDeskCatalogRequestInput,
  template: TaskTemplate,
  now: Date,
): Promise<string> {
  const { db, conversation } = input;
  const actor = input.actorUserId ?? 'system';
  const { row, assigneeIds } = await createTask(db, taskData(template, conversation, now), {
    projectId: null,
    userId: actor,
  });
  await publishEntityEventRaw({
    env: ctx.env,
    workspaceId: ctx.clerkOrgId,
    userId: actor,
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
      assignedByUserId: actor,
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
  return row.id;
}

/**
 * The tasks a run that stopped half way left on the conversation, by title,
 * oldest first: each one stands for one template of that title.
 */
async function tasksLeftBehind(db: Database, conversationId: string): Promise<Map<string, string[]>> {
  const byTitle = new Map<string, string[]>();
  for (const task of await listDeskRequestTasks(db, conversationId)) {
    byTitle.set(task.title, [...(byTitle.get(task.title) ?? []), task.id]);
  }
  return byTitle;
}

/**
 * Create the item's fulfilment tasks for an approved (or approval-free)
 * request. The task goes to the template's assignee, else the conversation's,
 * else nobody; due `dueInDays` from now; no project. A request whose
 * `fulfilment_started` event exists is left alone, and an item without tasks
 * writes nothing: null then.
 *
 * `fulfilment_started` is written after the last task, so a run that failed
 * can simply run again: a template whose title is already on a task linked to
 * the conversation (`sourceType = 'desk_conversation'`) is not created a
 * second time. Throws when it fails.
 */
export async function runDeskCatalogFulfilment(
  ctx: DeskCatalogContext,
  input: FulfilDeskCatalogRequestInput,
): Promise<FulfilDeskCatalogRequestResult | null> {
  const { db, conversation, item } = input;
  const actor = input.actorUserId ?? null;
  if (item.fulfilmentTasks.length === 0) return null;
  if (await hasDeskFulfilmentStarted(db, conversation.id)) return null;

  const left = await tasksLeftBehind(db, conversation.id);
  const now = new Date();
  const taskIds: string[] = [];
  let created = 0;
  for (const template of item.fulfilmentTasks) {
    const kept = left.get(template.title)?.shift();
    if (kept) {
      taskIds.push(kept);
      continue;
    }
    taskIds.push(await createFulfilmentTask(ctx, input, template, now));
    created += 1;
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
  return { taskIds, created };
}

/**
 * `runDeskCatalogFulfilment` for `executionCtx.waitUntil`: never throws. Null
 * when it did nothing or failed; a failed run is completed by the next one
 * (POST /api/desk/conversations/:id/fulfilment).
 */
export async function fulfilDeskCatalogRequest(
  ctx: DeskCatalogContext,
  input: FulfilDeskCatalogRequestInput,
): Promise<FulfilDeskCatalogRequestResult | null> {
  try {
    return await runDeskCatalogFulfilment(ctx, input);
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
