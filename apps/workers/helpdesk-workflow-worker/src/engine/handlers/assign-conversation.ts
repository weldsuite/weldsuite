import type { StepHandler, StepContext, StepResult } from '../../types';
import { createBotMessage } from '../helpers';
import { eq, and, isNull, asc, sql } from 'drizzle-orm';
import { schema } from '../../db';
import { publishMessageToConversation, publishToRealtimeChannel } from '../../lib/realtime-publisher';
import { resolveConversationId } from '../../lib/workflow-shared';
import { generateId } from '../../lib/id';

export const assignConversationHandler: StepHandler = {
  type: 'assign_conversation',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db, env, workspaceId } = ctx.options;

    const strategy = String(ctx.inputs.strategy || 'specific_agent');
    const departmentId = ctx.inputs.departmentId ? String(ctx.inputs.departmentId) : undefined;
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (strategy === 'specific_agent' && ctx.inputs.agentId) {
      updateData.assigneeId = String(ctx.inputs.agentId);
      if (ctx.inputs.agentName) updateData.assigneeName = String(ctx.inputs.agentName);
    } else if (strategy === 'department' && departmentId) {
      updateData.departmentId = departmentId;
    } else if (strategy === 'round_robin' || strategy === 'least_busy') {
      const conditions = [
        eq(schema.helpdeskAgents.status, 'active'),
        isNull(schema.helpdeskAgents.deletedAt),
      ];
      if (departmentId) {
        conditions.push(eq(schema.helpdeskAgents.departmentId, departmentId));
      }

      const orderCol = strategy === 'round_robin'
        ? asc(schema.helpdeskAgents.ticketsAssigned)
        : asc(schema.helpdeskAgents.currentActiveTickets);

      const agents = await db
        .select({ id: schema.helpdeskAgents.id, userId: schema.helpdeskAgents.userId, name: schema.helpdeskAgents.name })
        .from(schema.helpdeskAgents)
        .where(and(...conditions))
        .orderBy(orderCol)
        .limit(1);

      if (!agents[0]) return { success: false, error: 'No available agents found' };

      updateData.assigneeId = agents[0].userId;
      updateData.assigneeName = agents[0].name;

      await db
        .update(schema.helpdeskAgents)
        .set({
          ticketsAssigned: sql`COALESCE(${schema.helpdeskAgents.ticketsAssigned}, 0) + 1`,
          currentActiveTickets: sql`COALESCE(${schema.helpdeskAgents.currentActiveTickets}, 0) + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.helpdeskAgents.id, agents[0].id));
    }

    // Check current assignee before updating — only send system message if it actually changed
    const [current] = await db
      .select({ assigneeId: schema.helpdeskConversations.assigneeId })
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    const previousAssigneeId = current?.assigneeId;
    const newAssigneeId = updateData.assigneeId ? String(updateData.assigneeId) : null;
    const assigneeChanged = newAssigneeId && newAssigneeId !== previousAssigneeId;

    await db
      .update(schema.helpdeskConversations)
      .set(updateData)
      .where(eq(schema.helpdeskConversations.id, conversationId));

    if (assigneeChanged) {
      const agentName = updateData.assigneeName ? String(updateData.assigneeName) : 'an agent';
      const handoffContent = `${agentName} has joined the conversation.`;
      const handoffMsgId = generateId('msg');
      const now = new Date();

      await db.insert(schema.helpdeskConversationMessages).values({
        id: handoffMsgId,
        conversationId,
        content: handoffContent,
        authorType: 'system',
        authorId: 'system',
        authorName: 'System',
        type: 'message',
        isPublic: true,
        status: 'sent',
        createdAt: now,
        updatedAt: now,
      });

      await publishMessageToConversation(env, conversationId, {
        id: handoffMsgId,
        content: handoffContent,
        senderId: 'system',
        senderName: 'System',
        senderType: 'system' as any,
        timestamp: now.toISOString(),
      }).catch(() => {});

      // Publish system event: agent_assigned
      await publishToRealtimeChannel(env, `conversation:${conversationId}`, 'agent_assigned', {
        conversationId,
        agentId: newAssigneeId,
        agentName: agentName,
        assignedAt: now.toISOString(),
      }).catch(() => {});
    }

    // Always notify workspace about the update (for inbox refresh)
    if (updateData.assigneeId || updateData.departmentId) {
      const now = new Date();
      await publishToRealtimeChannel(env, `workspace:${workspaceId}`, 'conversation_updated', {
        conversationId,
        assigneeId: updateData.assigneeId,
        assigneeName: updateData.assigneeName,
        departmentId: updateData.departmentId,
        updatedAt: now.toISOString(),
      }).catch(() => {});
    }

    return { success: true, conversationId, strategy, ...updateData };
  },
};
