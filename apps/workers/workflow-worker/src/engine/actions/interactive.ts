/**
 * Human-in-the-loop / chat-widget interactive actions.
 * send_message posts a bot message; send_choices / collect_input / manual_step
 * pause the run by returning a WaitingForInputResult.
 */

import { generateId } from '../../lib/id';
import { schema } from '../../db';
import type { ActionHandler, WaitingForInputResult } from '../types';
import { resolveConversationId, publishRealtime } from './helpers';

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

export const handleManualStep: ActionHandler = async (inputs, ctx) => {
  const title = String(inputs.title || 'Manual Review Required');
  let targetUserId = ctx.tenant.userId;
  if (inputs.assignTo === 'specific_user' && inputs.assigneeId) targetUserId = String(inputs.assigneeId);

  const notificationId = generateId('notif');
  // NOTE: the notifications tenant table has no workspaceId column.
  await ctx.db.insert(schema.notifications).values({
    id: notificationId,
    userId: targetUserId,
    title,
    body: inputs.description ? String(inputs.description) : 'A workflow step requires your action.',
    category: 'task',
    notificationType: 'manual_step',
    entityType: 'workflow_execution',
    entityId: ctx.executionId,
    actionUrl: `/weldconnect/workflows/executions/${ctx.executionId}`,
    severity: 'info',
    data: { stepConfig: inputs },
    isRead: false,
    deliveredInApp: true,
    deliveredEmail: false,
    deliveredPush: false,
    createdAt: new Date(),
  });

  return { __waitingForInput: true, stepType: 'manual_step' } satisfies WaitingForInputResult;
};
