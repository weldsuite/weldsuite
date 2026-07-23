import type { StepHandler, StepContext, StepResult } from '../types';
import { eq, and, isNull, asc, sql } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../workflow-shared';
import { generateId } from '../../lib/id';

export const assignConversationHandler: StepHandler = {
  type: 'assign_conversation',
  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;
    const strategy = String(ctx.inputs.strategy || 'specific_agent');
    const departmentId = ctx.inputs.departmentId ? String(ctx.inputs.departmentId) : undefined;
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (strategy === 'specific_agent' && ctx.inputs.agentId) {
      updateData.assigneeId = String(ctx.inputs.agentId);
      if (ctx.inputs.agentName) updateData.assigneeName = String(ctx.inputs.agentName);
    } else if (strategy === 'department' && departmentId) {
      updateData.departmentId = departmentId;
    } else if (strategy === 'round_robin' || strategy === 'least_busy') {
      const conditions = [eq(schema.helpdeskAgents.status, 'active'), isNull(schema.helpdeskAgents.deletedAt)];
      if (departmentId) conditions.push(eq(schema.helpdeskAgents.departmentId, departmentId));

      const orderCol = strategy === 'round_robin'
        ? asc(schema.helpdeskAgents.ticketsAssigned)
        : asc(schema.helpdeskAgents.currentActiveTickets);

      const agents = await db.select({ id: schema.helpdeskAgents.id, userId: schema.helpdeskAgents.userId, name: schema.helpdeskAgents.name })
        .from(schema.helpdeskAgents).where(and(...conditions)).orderBy(orderCol).limit(1);

      if (!agents[0]) return { success: false, error: 'No available agents found' };

      updateData.assigneeId = agents[0].userId;
      updateData.assigneeName = agents[0].name;

      await db.update(schema.helpdeskAgents).set({
        ticketsAssigned: sql`COALESCE(${schema.helpdeskAgents.ticketsAssigned}, 0) + 1`,
        currentActiveTickets: sql`COALESCE(${schema.helpdeskAgents.currentActiveTickets}, 0) + 1`,
        updatedAt: new Date(),
      }).where(eq(schema.helpdeskAgents.id, agents[0].id));
    }

    // Check if assignee changed
    const [current] = await db.select({ assigneeId: schema.helpdeskConversations.assigneeId })
      .from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, conversationId)).limit(1);

    const newAssigneeId = updateData.assigneeId ? String(updateData.assigneeId) : null;
    const assigneeChanged = newAssigneeId && newAssigneeId !== current?.assigneeId;

    await db.update(schema.helpdeskConversations).set(updateData).where(eq(schema.helpdeskConversations.id, conversationId));

    if (assigneeChanged) {
      const agentName = updateData.assigneeName ? String(updateData.assigneeName) : 'an agent';
      const now = new Date();
      await db.insert(schema.helpdeskConversationMessages).values({
        id: generateId('msg'),
        conversationId,
        content: `${agentName} has joined the conversation.`,
        authorType: 'system',
        authorId: 'system',
        authorName: 'System',
        type: 'message',
        isPublic: true,
        status: 'sent',
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true, conversationId, strategy, ...updateData };
  },
};
