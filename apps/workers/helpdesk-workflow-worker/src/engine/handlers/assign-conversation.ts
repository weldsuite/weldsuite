import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq, and, isNull, asc, sql } from 'drizzle-orm';
import { schema } from '../../db';
import { publishMessageToConversation, publishToRealtimeChannel } from '../../lib/realtime-publisher';
import { resolveConversationId } from '../../lib/workflow-shared';
import { generateId } from '../../lib/id';
import { asText } from '@weldsuite/text';

type AssignOptions = StepContext['options'];
type AssignmentFields = Record<string, unknown>;
type AgentPick = { fields: AssignmentFields } | { error: string };

/** Picks the least-loaded active agent (optionally in a department) and bumps its counters. */
async function pickAgentByLoad(
  db: AssignOptions['db'],
  strategy: 'round_robin' | 'least_busy',
  departmentId: string | undefined,
): Promise<AgentPick> {
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

  if (!agents[0]) return { error: 'No available agents found' };

  await db
    .update(schema.helpdeskAgents)
    .set({
      ticketsAssigned: sql`COALESCE(${schema.helpdeskAgents.ticketsAssigned}, 0) + 1`,
      currentActiveTickets: sql`COALESCE(${schema.helpdeskAgents.currentActiveTickets}, 0) + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.helpdeskAgents.id, agents[0].id));

  return { fields: { assigneeId: agents[0].userId, assigneeName: agents[0].name } };
}

/** Resolves the conversation fields to set for the configured assignment strategy. */
async function resolveAssignmentFields(
  db: AssignOptions['db'],
  strategy: string,
  inputs: StepContext['inputs'],
  departmentId: string | undefined,
): Promise<AgentPick> {
  if (strategy === 'specific_agent' && inputs.agentId) {
    const fields: AssignmentFields = { assigneeId: asText(inputs.agentId) };
    if (inputs.agentName) fields.assigneeName = asText(inputs.agentName);
    return { fields };
  }
  if (strategy === 'department' && departmentId) {
    return { fields: { departmentId } };
  }
  if (strategy === 'round_robin' || strategy === 'least_busy') {
    return pickAgentByLoad(db, strategy, departmentId);
  }
  return { fields: {} };
}

/** Posts the "agent joined" system message and the agent_assigned realtime event. */
async function announceHandoff(
  db: AssignOptions['db'],
  env: AssignOptions['env'],
  conversationId: string,
  newAssigneeId: string,
  updateData: AssignmentFields,
): Promise<void> {
  const agentName = updateData.assigneeName ? asText(updateData.assigneeName) : 'an agent';
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

export const assignConversationHandler: StepHandler = {
  type: 'assign_conversation',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db, env, workspaceId } = ctx.options;

    const strategy = asText(ctx.inputs.strategy || 'specific_agent');
    const departmentId = ctx.inputs.departmentId ? asText(ctx.inputs.departmentId) : undefined;

    const pick = await resolveAssignmentFields(db, strategy, ctx.inputs, departmentId);
    if ('error' in pick) return { success: false, error: pick.error };
    const updateData: AssignmentFields = { updatedAt: new Date(), ...pick.fields };

    // Check current assignee before updating — only send system message if it actually changed
    const [current] = await db
      .select({ assigneeId: schema.helpdeskConversations.assigneeId })
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    const previousAssigneeId = current?.assigneeId;
    const newAssigneeId = updateData.assigneeId ? asText(updateData.assigneeId) : null;

    await db
      .update(schema.helpdeskConversations)
      .set(updateData)
      .where(eq(schema.helpdeskConversations.id, conversationId));

    if (newAssigneeId && newAssigneeId !== previousAssigneeId) {
      await announceHandoff(db, env, conversationId, newAssigneeId, updateData);
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
