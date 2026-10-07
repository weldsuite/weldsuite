/**
 * Helpdesk conversation actions: assign_conversation, tag_conversation,
 * change_conversation_status, change_priority, send_reply, add_internal_note.
 * Ported from api-worker. Each no-ops (returns { success:false }) when no
 * conversation can be resolved.
 */

import { eq, and, isNull, asc, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { ActionContext, ActionHandler } from '../types';
import { resolveConversationId, publishRealtime } from './helpers';
import { asText } from '@weldsuite/text';

/**
 * Pick the least-loaded active agent (optionally within a department) for
 * `round_robin` / `least_busy` and bump their load counters. Returns null
 * when no agent is available.
 */
async function pickAgentByLoad(
  ctx: ActionContext,
  strategy: 'round_robin' | 'least_busy',
  departmentId: string | undefined,
): Promise<{ userId: string | null; name: string | null } | null> {
  const conditions: SQL[] = [
    eq(schema.helpdeskAgents.status, 'active'),
    isNull(schema.helpdeskAgents.deletedAt),
  ];
  if (departmentId) conditions.push(eq(schema.helpdeskAgents.departmentId, departmentId));
  const orderCol =
    strategy === 'round_robin'
      ? schema.helpdeskAgents.ticketsAssigned
      : schema.helpdeskAgents.currentActiveTickets;
  const agents = await ctx.db
    .select({ id: schema.helpdeskAgents.id, userId: schema.helpdeskAgents.userId, name: schema.helpdeskAgents.name })
    .from(schema.helpdeskAgents)
    .where(and(...conditions))
    .orderBy(asc(orderCol))
    .limit(1);
  if (!agents[0]) return null;
  await ctx.db
    .update(schema.helpdeskAgents)
    .set({
      ticketsAssigned: sql`COALESCE(${schema.helpdeskAgents.ticketsAssigned}, 0) + 1`,
      currentActiveTickets: sql`COALESCE(${schema.helpdeskAgents.currentActiveTickets}, 0) + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.helpdeskAgents.id, agents[0].id));
  return { userId: agents[0].userId, name: agents[0].name };
}

export const handleAssignConversation: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const strategy = asText(inputs.strategy || 'specific_agent');
  const departmentId = inputs.departmentId ? asText(inputs.departmentId) : undefined;
  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (strategy === 'specific_agent' && inputs.agentId) {
    updateData.assigneeId = asText(inputs.agentId);
    if (inputs.agentName) updateData.assigneeName = asText(inputs.agentName);
  } else if (strategy === 'department' && departmentId) {
    updateData.departmentId = departmentId;
  } else if (strategy === 'round_robin' || strategy === 'least_busy') {
    const agent = await pickAgentByLoad(ctx, strategy, departmentId);
    if (!agent) return { success: false, error: 'No available agents' };
    updateData.assigneeId = agent.userId;
    updateData.assigneeName = agent.name;
  }

  await ctx.db
    .update(schema.helpdeskConversations)
    .set(updateData)
    .where(eq(schema.helpdeskConversations.id, conversationId));

  if (updateData.assigneeId) {
    await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'agent:assigned', {
      conversationId,
      agentId: updateData.assigneeId,
      agentName: updateData.assigneeName || 'Agent',
    });
  }
  return { success: true, conversationId, strategy, ...updateData };
};

export const handleTagConversation: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const mode = asText(inputs.mode || 'add');
  const inputTags = (Array.isArray(inputs.tags) ? inputs.tags : []).map(String);
  const [conversation] = await ctx.db
    .select({ tags: schema.helpdeskConversations.tags })
    .from(schema.helpdeskConversations)
    .where(eq(schema.helpdeskConversations.id, conversationId))
    .limit(1);

  const currentTags: string[] = (conversation?.tags as string[]) ?? [];
  let newTags: string[];
  switch (mode) {
    case 'remove':
      newTags = currentTags.filter((t) => !inputTags.includes(t));
      break;
    case 'replace':
      newTags = inputTags;
      break;
    default:
      newTags = [...new Set([...currentTags, ...inputTags])];
  }

  await ctx.db
    .update(schema.helpdeskConversations)
    .set({ tags: newTags, updatedAt: new Date() })
    .where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, mode, tags: newTags };
};

export const handleChangeConversationStatus: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const status = String(inputs.status);
  const updateData: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === 'resolved') updateData.resolvedAt = new Date();
  if (status === 'closed') updateData.closedAt = new Date();
  await ctx.db
    .update(schema.helpdeskConversations)
    .set(updateData)
    .where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, status };
};

export const handleChangePriority: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const priority = String(inputs.priority);
  await ctx.db
    .update(schema.helpdeskConversations)
    .set({ priority, updatedAt: new Date() })
    .where(eq(schema.helpdeskConversations.id, conversationId));
  return { success: true, conversationId, priority };
};

export const handleSendReply: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const messageId = generateId('msg');
  const authorType = asText(inputs.authorType || 'system');
  const content = asText(inputs.message || '');
  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId,
    content,
    authorType,
    authorId: authorType === 'agent' ? ctx.tenant.userId : 'system',
    authorName: authorType === 'agent' ? 'Agent' : 'System',
    type: 'message',
    isPublic: true,
    status: 'sent',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await ctx.db
    .update(schema.helpdeskConversations)
    .set({ lastMessageAt: new Date(), lastAgentMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.helpdeskConversations.id, conversationId));
  await publishRealtime(ctx.env, ctx.tenant.workspaceId, `conversation:${conversationId}`, 'message:new', {
    id: messageId,
    conversationId,
    content,
    sender: 'agent',
    timestamp: new Date().toISOString(),
  });
  return { success: true, messageId, conversationId };
};

export const handleAddInternalNote: ActionHandler = async (inputs, ctx) => {
  const conversationId = resolveConversationId(inputs, ctx);
  if (!conversationId) return { success: false, error: 'No conversation ID' };

  const messageId = generateId('msg');
  await ctx.db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId,
    content: asText(inputs.content || ''),
    authorType: 'agent',
    authorId: ctx.tenant.userId,
    authorName: 'System',
    type: 'note',
    isPublic: false,
    isInternal: true,
    status: 'sent',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { success: true, messageId, conversationId };
};
