/**
 * Human-in-the-loop / chat-widget interactive actions.
 * send_message posts a bot message; send_choices / collect_input / manual_step
 * pause the run by returning a WaitingForInputResult.
 */

import { and, inArray, isNull } from 'drizzle-orm';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import type { ActionHandler, WaitingForInputResult } from '../types';
import { NonRetryableStepError } from '../errors';
import { resolveConversationId, publishRealtime } from './helpers';
import { handleSendNotification } from './communication';

export const handleSendMessage: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = String(inputs.message || '');
  const messageId = generateId('msg');
  const now = new Date();
  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId,
    content,
    authorType: 'system',
    authorId: 'system',
    authorName: 'Bot',
    type: 'message',
    isPublic: true,
    status: 'sent',
    createdAt: now,
    updatedAt: now,
  });
  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId,
    conversationId,
    content,
    sender: 'agent',
    timestamp: now.toISOString(),
  });
  return { success: true, messageId, conversationId };
};

export const handleSendChoices: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = String(inputs.message || '');
  const options = (inputs.options as Array<{ id: string; label: string; value: string }>) || [];
  const messageId = generateId('msg');
  const now = new Date();
  const metadata = {
    interactiveType: 'choices',
    workflowExecutionId: ctx.executionId,
    workflowStepId: (inputs as any).__stepId || 'unknown',
    options,
  };
  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId,
    content,
    authorType: 'system',
    authorId: 'system',
    authorName: 'Bot',
    type: 'message',
    isPublic: true,
    status: 'sent',
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId,
    conversationId,
    content,
    sender: 'agent',
    timestamp: now.toISOString(),
    metadata,
  });
  return { __waitingForInput: true, conversationId, messageId, stepType: 'send_choices' } satisfies WaitingForInputResult;
};

export const handleCollectInput: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const content = String(inputs.message || '');
  const fields = (inputs.fields as Array<{ id: string; label: string; type: string; required: boolean }>) || [];
  const messageId = generateId('msg');
  const now = new Date();
  const metadata = {
    interactiveType: 'collect_input',
    workflowExecutionId: ctx.executionId,
    workflowStepId: (inputs as any).__stepId || 'unknown',
    fields,
  };
  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId,
    content,
    authorType: 'system',
    authorId: 'system',
    authorName: 'Bot',
    type: 'message',
    isPublic: true,
    status: 'sent',
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId,
    conversationId,
    content,
    sender: 'agent',
    timestamp: now.toISOString(),
    metadata,
  });
  return { __waitingForInput: true, conversationId, messageId, stepType: 'collect_input' } satisfies WaitingForInputResult;
};

/** The approvers a manual_step lists: `approverIds`, or the legacy single `assigneeId`. */
export function manualStepApproverIds(inputs: Record<string, unknown>): string[] {
  const raw = Array.isArray(inputs.approverIds)
    ? inputs.approverIds
    : inputs.assignTo === 'specific_user' && inputs.assigneeId
      ? [inputs.assigneeId]
      : [];
  // An unresolved {{variable}} arrives as an empty string: drop it.
  return [...new Set(raw.map((id) => String(id ?? '').trim()).filter(Boolean))];
}

/** What a waiting manual_step stores as its output (and so on its step row). */
export interface ManualStepWaiting extends WaitingForInputResult {
  stepType: 'manual_step';
  title: string;
  description: string | null;
  /**
   * Members who may decide. Empty = nobody was listed, so any member with
   * `workflow-executions:update` may (connect-api enforces this).
   */
  approverIds: string[];
  /** Who got the in-app notification. */
  notifiedUserIds: string[];
}

/**
 * manual_step — an approval. Notifies the approvers (in-app, linking to the
 * run) and parks the run until someone approves or rejects it on the run page
 * (connect-api POST /workflow-executions/:id/decision sends the resume event).
 * Listed approvers that are not, or no longer, members are left out; when none
 * are listed the workflow's owner is notified instead.
 */
export const handleManualStep: ActionHandler = async (inputs, ctx) => {
  const title = String(inputs.title || '').trim() || 'Approval needed';
  const description = inputs.description ? String(inputs.description) : null;

  const requested = manualStepApproverIds(inputs);
  let approverIds: string[] = [];
  if (requested.length > 0) {
    const rows = await ctx.db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(and(inArray(schema.workspaceMembers.userId, requested), isNull(schema.workspaceMembers.deletedAt)));
    const members = new Set(rows.map((row) => row.userId));
    approverIds = requested.filter((id) => members.has(id));
    if (approverIds.length === 0) {
      throw new NonRetryableStepError('None of the approvers is a member of this workspace');
    }
  }

  const workflowName = (ctx.triggerData as { workflowName?: unknown } | null)?.workflowName;
  const sent = (await handleSendNotification(
    {
      title,
      body:
        description ??
        (typeof workflowName === 'string' && workflowName
          ? `"${workflowName}" is waiting for your approval.`
          : 'A workflow is waiting for your approval.'),
      // Empty: send_notification falls back to the workflow's owner.
      userIds: approverIds,
      category: 'task',
      notificationType: 'manual_step',
      severity: 'warning',
      icon: 'workflow',
      actionUrl: `/weldconnect/executions/${ctx.executionId}`,
      entityType: 'workflow_execution',
      entityId: ctx.executionId,
    },
    ctx,
  )) as { notifiedUserIds?: string[] };

  return {
    __waitingForInput: true,
    stepType: 'manual_step',
    title,
    description,
    approverIds,
    notifiedUserIds: sent.notifiedUserIds ?? [],
  } satisfies ManualStepWaiting;
};

/** A manual_step's output once someone decided: what a following condition reads. */
export interface ManualStepDecision {
  approved: boolean;
  decision: 'approved' | 'rejected';
  comment: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
}

/** Normalise the resume event's payload into the manual_step's output. */
export function manualStepDecision(payload: Record<string, unknown>): ManualStepDecision {
  const approved = payload.approved === true || payload.decision === 'approved';
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    approved,
    decision: approved ? 'approved' : 'rejected',
    comment: text(payload.comment),
    decidedBy: text(payload.decidedBy),
    decidedByName: text(payload.decidedByName),
    decidedAt: text(payload.decidedAt),
  };
}
