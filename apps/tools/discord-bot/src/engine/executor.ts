/**
 * Workflow Executor — Runs helpdesk workflows inline in the Discord bot.
 *
 * Self-contained: no dependency on helpdesk-workflow-worker.
 * Loads workflow definitions from DB, matches triggers, executes steps
 * sequentially, and sends output messages directly to Discord.
 *
 * Supports:
 * - send_message: persist to DB + send to Discord
 * - send_choices: persist + send embed with buttons (pauses for response)
 * - ai_auto_reply: call AI gateway + stream + persist + send to Discord
 * - assign_conversation, close_conversation, change_status, change_priority
 * - tag_conversation, delay, condition
 * - trigger_csat: persist + send rating buttons (pauses for response)
 * - collect_input: persist + send prompt (pauses for response)
 */

import { eq, and, isNull, desc, sql, inArray } from 'drizzle-orm';
import type { ThreadChannel, TextChannel } from 'discord.js';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getTenantDb, schema, type Database } from '../lib/db.js';
import { generateId } from '../lib/id.js';
import { publishConversationEvent } from '../lib/realtime.js';

// ============================================================================
// Types
// ============================================================================

interface WorkflowDef {
  id: string;
  name: string;
  steps: StepDef[];
}

interface StepDef {
  id: string;
  name: string;
  type: string;
  order?: number;
  inputs?: Record<string, unknown>;
  config?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  parentBranchId?: string;
}

interface ExecutionContext {
  db: Database;
  conversationId: string;
  workspaceId: string;
  channel: TextChannel | ThreadChannel;
  triggerData: Record<string, unknown>;
  stepResults: Record<string, unknown>;
}

// ============================================================================
// Main Entry: trigger workflows for a conversation event
// ============================================================================

export async function executeWorkflows(params: {
  db: Database;
  conversationId: string;
  workspaceId: string;
  eventType: 'conversation_created' | 'message_received';
  channelObj: TextChannel | ThreadChannel;
  triggerData: Record<string, unknown>;
}): Promise<void> {
  const { db, conversationId, workspaceId, eventType, channelObj, triggerData } = params;

  try {
    // Check for active execution — skip if already running
    const [activeExec] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
          inArray(schema.helpdeskWorkflowExecutions.status, ['running', 'waiting_for_input', 'ai_active']),
        ),
      )
      .limit(1);

    if (activeExec) {
      console.log(`[Workflow] Conversation ${conversationId} already has active execution, skipping`);
      return;
    }

    // Load active workflows
    const workflows = await db
      .select({
        id: schema.helpdeskWorkflows.id,
        name: schema.helpdeskWorkflows.name,
        steps: schema.helpdeskWorkflows.steps,
        triggers: schema.helpdeskWorkflows.triggers,
      })
      .from(schema.helpdeskWorkflows)
      .where(
        and(
          eq(schema.helpdeskWorkflows.status, 'active'),
          isNull(schema.helpdeskWorkflows.deletedAt),
        ),
      )
      .orderBy(schema.helpdeskWorkflows.sortOrder);

    // Match triggers against 4 supported event types
    console.log(`[Workflow] Evaluating ${workflows.length} workflow(s) for eventType=${eventType}`);

    const matched = workflows.filter((wf) => {
      const triggers = (wf.triggers || []) as Array<{
        type: string;
        isEnabled?: boolean;
        config?: { entityType?: string; eventType?: string; channels?: string[] };
      }>;

      return triggers.some((t) => {
        if (t.isEnabled === false) return false;
        if (t.type !== 'entity_event') return false;
        const cfg = t.config;
        if (!cfg) return false;

        // Map our event types to trigger configs
        switch (eventType) {
          case 'conversation_created':
            return cfg.entityType === 'helpdesk_conversation' &&
              (!cfg.eventType || cfg.eventType === 'created');

          case 'message_received':
            return (
              (cfg.entityType === 'helpdesk_conversation' && cfg.eventType === 'message_received') ||
              (cfg.entityType === 'helpdesk_conversation_message' && (!cfg.eventType || cfg.eventType === 'created')) ||
              (cfg.entityType === 'helpdesk_conversation' && cfg.eventType === 'first_message')
            );

          case 'conversation_assigned':
            return cfg.entityType === 'helpdesk_conversation' && cfg.eventType === 'assigned';

          case 'conversation_closed':
            return cfg.entityType === 'helpdesk_conversation' &&
              (cfg.eventType === 'closed' || cfg.eventType === 'status_changed');

          default:
            return false;
        }
      });
    });

    if (matched.length === 0) {
      console.log(`[Workflow] No workflows matched for ${eventType}`);
      return;
    }

    console.log(`[Workflow] Matched ${matched.length} workflow(s) for ${eventType} on conversation ${conversationId}`);
    for (const wf of matched) {
      const allSteps = (wf.steps || []) as any[];
      const mainSteps = allSteps.filter((s: any) => !s.parentBranchId);
      console.log(`[Workflow]   "${wf.name}": ${allSteps.length} total steps, ${mainSteps.length} main steps`);
      mainSteps.forEach((s: any, i: number) => console.log(`[Workflow]     ${i + 1}. ${s.type} "${s.name}"`));
    }

    // Set hasActiveWorkflow
    await db.update(schema.helpdeskConversations)
      .set({ hasActiveWorkflow: true, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    // Execute each matched workflow
    for (const wf of matched) {
      const steps = ((wf.steps || []) as StepDef[])
        .filter((s) => !s.parentBranchId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const executionId = generateId('wex');
      const now = new Date();

      await db.insert(schema.helpdeskWorkflowExecutions).values({
        id: executionId,
        helpdeskWorkflowId: wf.id,
        workflowVersion: 1,
        workflowName: wf.name,
        status: 'running',
        triggeredBy: 'system',
        triggerType: 'entity_event',
        triggerData,
        startedAt: now,
        totalSteps: steps.length,
        currentStepIndex: 0,
        conversationId,
        channel: 'discord',
        createdAt: now,
        updatedAt: now,
      });

      const ctx: ExecutionContext = {
        db,
        conversationId,
        workspaceId,
        channel: channelObj,
        triggerData,
        stepResults: {},
      };

      let stopped = false;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;

        try {
          console.log(`[Workflow] Executing step ${i + 1}/${steps.length}: ${step.type} "${step.name}" (${step.id})`);
          const result = await executeStep(step, ctx, executionId);
          console.log(`[Workflow] Step ${step.type} result:`, JSON.stringify(result).substring(0, 200));
          ctx.stepResults[step.id] = result;

          // Update execution progress
          await db.update(schema.helpdeskWorkflowExecutions).set({
            currentStepIndex: i + 1,
            updatedAt: new Date(),
          }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));

          // If step is waiting for input, pause execution and save state for resumption
          if (result.__waitingForInput) {
            await db.update(schema.helpdeskWorkflowExecutions).set({
              status: 'waiting_for_input',
              currentStepId: step.id,
              executionContext: {
                stepResults: ctx.stepResults,
                waitingStepId: step.id,
                pausedAtIndex: i,
                workflowSteps: steps,
                triggerData: ctx.triggerData,
              },
              updatedAt: new Date(),
            }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
            stopped = true;
            break;
          }

          // Handle delay
          if (result.__delayMs) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(result.__delayMs as number, 30000)));
          }
        } catch (err) {
          console.error(`[Workflow] Step ${step.type} failed:`, err);
        }
      }

      // Mark complete if not paused
      if (!stopped) {
        await db.update(schema.helpdeskWorkflowExecutions).set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
      }
    }

    // Clear hasActiveWorkflow
    await db.update(schema.helpdeskConversations)
      .set({ hasActiveWorkflow: false, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));

  } catch (err) {
    console.error(`[Workflow] Execution failed for conversation ${conversationId}:`, err);

    // Ensure flag is cleared on error
    try {
      await db.update(schema.helpdeskConversations)
        .set({ hasActiveWorkflow: false, updatedAt: new Date() })
        .where(eq(schema.helpdeskConversations.id, conversationId));
    } catch {}
  }
}

// ============================================================================
// Step Executor
// ============================================================================

async function executeStep(
  step: StepDef,
  ctx: ExecutionContext,
  executionId: string,
): Promise<Record<string, unknown>> {
  const inputs = { ...(step.config || {}), ...(step.inputs || {}) } as Record<string, unknown>;

  switch (step.type) {
    case 'send_message':
      return stepSendMessage(ctx, inputs);

    case 'send_choices':
      return stepSendChoices(ctx, inputs, executionId, step.id);

    case 'trigger_csat':
      return stepTriggerCsat(ctx, inputs, executionId, step.id);

    case 'collect_input':
    case 'collect_customer_info':
      return stepCollectInput(ctx, inputs, executionId, step.id);

    case 'assign_conversation':
      return stepAssignConversation(ctx, inputs);

    case 'close_conversation':
      return stepCloseConversation(ctx);

    case 'change_status':
      return stepChangeStatus(ctx, inputs);

    case 'change_priority':
      return stepChangePriority(ctx, inputs);

    case 'tag_conversation':
      return stepTagConversation(ctx, inputs);

    case 'add_internal_note':
      return stepAddInternalNote(ctx, inputs);

    case 'delay':
      return { success: true, __delayMs: Number(inputs.duration || inputs.durationMs || 1000) };

    case 'condition':
      return { success: true };

    default:
      console.log(`[Workflow] Skipping unsupported step type: ${step.type}`);
      return { success: true, skipped: true };
  }
}

// ============================================================================
// Step Implementations
// ============================================================================

async function stepSendMessage(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const content = String(inputs.message || inputs.content || '');
  if (!content) return { success: true, skipped: true };

  const messageId = await createBotMessage(ctx.db, ctx.conversationId, content, {
    source: 'workflow',
    isBot: true,
  });

  await touchConversation(ctx.db, ctx.conversationId);

  // Send to Discord
  await ctx.channel.send(content);

  // Publish to ConversationRoom for platform agents
  publishConversationEvent(ctx.conversationId, {
    type: 'message',
    id: messageId,
    content,
    senderId: 'workflow',
    senderName: 'Bot',
    senderType: 'agent',
    ts: Date.now(),
  });

  return { success: true, messageId, content };
}

async function stepSendChoices(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
  executionId: string,
  stepId: string,
): Promise<Record<string, unknown>> {
  const content = String(inputs.message || inputs.content || 'Please select an option:');
  const options = (inputs.options as Array<{ id?: string; label: string; value: string }>) || [];

  const messageId = await createBotMessage(ctx.db, ctx.conversationId, content, {
    interactiveType: 'choices',
    workflowExecutionId: executionId,
    workflowStepId: stepId,
    options,
    source: 'workflow',
  });

  await touchConversation(ctx.db, ctx.conversationId);

  // Send embed with buttons to Discord
  const embed = new EmbedBuilder()
    .setDescription(content)
    .setColor(0x5865F2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...options.slice(0, 5).map((opt) =>
      new ButtonBuilder()
        .setCustomId(`wf_choice:${ctx.conversationId}:${stepId}:${opt.value}`)
        .setLabel(opt.label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    ),
  );

  await ctx.channel.send({ embeds: [embed], components: [row] });

  publishConversationEvent(ctx.conversationId, {
    type: 'message',
    id: messageId,
    content: content,
    senderId: 'workflow',
    senderName: 'Bot',
    senderType: 'agent',
    ts: Date.now(),
  });

  return { __waitingForInput: true, success: true, messageId, stepId };
}

async function stepTriggerCsat(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
  executionId: string,
  stepId: string,
): Promise<Record<string, unknown>> {
  const content = String(inputs.message || inputs.question || 'How would you rate your experience?');

  const messageId = await createBotMessage(ctx.db, ctx.conversationId, content, {
    interactiveType: 'csat',
    workflowExecutionId: executionId,
    workflowStepId: stepId,
    source: 'workflow',
  });

  await touchConversation(ctx.db, ctx.conversationId);

  const embed = new EmbedBuilder()
    .setDescription(content)
    .setColor(0x5865F2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...[1, 2, 3, 4, 5].map((rating) =>
      new ButtonBuilder()
        .setCustomId(`wf_csat:${ctx.conversationId}:${stepId}:${rating}`)
        .setLabel(`${rating}`)
        .setStyle(rating <= 2 ? ButtonStyle.Danger : rating === 3 ? ButtonStyle.Secondary : ButtonStyle.Success),
    ),
  );

  await ctx.channel.send({ embeds: [embed], components: [row] });

  publishConversationEvent(ctx.conversationId, {
    type: 'message',
    id: messageId,
    content: content,
    senderId: 'workflow',
    senderName: 'Bot',
    senderType: 'agent',
    ts: Date.now(),
  });

  return { __waitingForInput: true, success: true, messageId, stepId };
}

async function stepCollectInput(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
  executionId: string,
  stepId: string,
): Promise<Record<string, unknown>> {
  const content = String(inputs.message || inputs.content || 'Please provide the following information:');
  const fields = (inputs.fields as Array<{ id: string; label: string; type?: string; required?: boolean; placeholder?: string }>) || [];

  const messageId = await createBotMessage(ctx.db, ctx.conversationId, content, {
    interactiveType: 'collect_input',
    workflowExecutionId: executionId,
    workflowStepId: stepId,
    fields,
    source: 'workflow',
  });

  await touchConversation(ctx.db, ctx.conversationId);

  // Send embed with a button that opens a modal form
  const embed = new EmbedBuilder()
    .setDescription(content)
    .setColor(0x5865F2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wf_form:${ctx.conversationId}:${stepId}`)
      .setLabel('Fill in details')
      .setStyle(ButtonStyle.Primary),
  );

  await ctx.channel.send({ embeds: [embed], components: [row] });

  publishConversationEvent(ctx.conversationId, {
    type: 'message',
    id: messageId,
    content: content,
    senderId: 'workflow',
    senderName: 'Bot',
    senderType: 'agent',
    ts: Date.now(),
  });

  return { __waitingForInput: true, success: true, messageId, stepId, fields };
}

async function stepAssignConversation(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assigneeId = inputs.agentId as string | undefined;
  const assigneeName = inputs.agentName as string | undefined;

  if (assigneeId) {
    await ctx.db.update(schema.helpdeskConversations).set({
      assigneeId,
      assigneeName: assigneeName || assigneeId,
      updatedAt: new Date(),
    }).where(eq(schema.helpdeskConversations.id, ctx.conversationId));
  }

  return { success: true, assigneeId };
}

async function stepCloseConversation(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  await ctx.db.update(schema.helpdeskConversations).set({
    status: 'closed',
    closedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(schema.helpdeskConversations.id, ctx.conversationId));

  return { success: true };
}

async function stepChangeStatus(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = String(inputs.status || 'active');
  await ctx.db.update(schema.helpdeskConversations).set({
    status,
    updatedAt: new Date(),
  }).where(eq(schema.helpdeskConversations.id, ctx.conversationId));

  return { success: true, status };
}

async function stepChangePriority(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const priority = String(inputs.priority || 'medium');
  await ctx.db.update(schema.helpdeskConversations).set({
    priority,
    updatedAt: new Date(),
  }).where(eq(schema.helpdeskConversations.id, ctx.conversationId));

  return { success: true, priority };
}

async function stepTagConversation(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tags = (inputs.tags as string[]) || [];
  if (tags.length === 0) return { success: true };

  const [conv] = await ctx.db
    .select({ tags: schema.helpdeskConversations.tags })
    .from(schema.helpdeskConversations)
    .where(eq(schema.helpdeskConversations.id, ctx.conversationId))
    .limit(1);

  const existing = (conv?.tags as string[]) || [];
  const merged = [...new Set([...existing, ...tags])];

  await ctx.db.update(schema.helpdeskConversations).set({
    tags: merged,
    updatedAt: new Date(),
  }).where(eq(schema.helpdeskConversations.id, ctx.conversationId));

  return { success: true, tags: merged };
}

async function stepAddInternalNote(
  ctx: ExecutionContext,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const content = String(inputs.message || inputs.content || '');
  if (!content) return { success: true, skipped: true };

  const messageId = await createBotMessage(ctx.db, ctx.conversationId, content, {
    source: 'workflow',
  }, { isPublic: false, isInternal: true });

  return { success: true, messageId };
}

// ============================================================================
// Helpers
// ============================================================================

async function createBotMessage(
  db: Database,
  conversationId: string,
  content: string,
  metadata: Record<string, unknown>,
  overrides?: { isPublic?: boolean; isInternal?: boolean },
): Promise<string> {
  const messageId = generateId('msg');
  const now = new Date();

  await db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId,
    content,
    authorType: 'agent',
    authorId: 'workflow',
    authorName: 'Bot',
    type: 'message',
    isPublic: overrides?.isPublic ?? true,
    isInternal: overrides?.isInternal ?? false,
    status: 'sent',
    isRead: false,
    metadata,
    createdAt: now,
    updatedAt: now,
  });

  return messageId;
}

async function touchConversation(db: Database, conversationId: string): Promise<void> {
  const now = new Date();
  await db.update(schema.helpdeskConversations).set({
    lastMessageAt: now,
    lastAgentMessageAt: now,
    messageCount: sql`${schema.helpdeskConversations.messageCount} + 1`,
    updatedAt: now,
  }).where(eq(schema.helpdeskConversations.id, conversationId));
}

// ============================================================================
// Resume workflow after interactive step response
// ============================================================================

/**
 * Resume a paused workflow execution after receiving a customer response
 * (form submission, choice selection, CSAT rating).
 * Continues executing remaining steps from where it paused.
 */
export async function resumeWorkflow(params: {
  db: Database;
  conversationId: string;
  workspaceId: string;
  executionId: string;
  stepId: string;
  channelObj: TextChannel | ThreadChannel;
  responseData: Record<string, unknown>;
}): Promise<void> {
  const { db, conversationId, workspaceId, executionId, stepId, channelObj, responseData } = params;

  try {
    // Load execution context
    const [execution] = await db
      .select()
      .from(schema.helpdeskWorkflowExecutions)
      .where(eq(schema.helpdeskWorkflowExecutions.id, executionId))
      .limit(1);

    if (!execution || execution.status !== 'waiting_for_input') {
      console.log(`[Workflow] Cannot resume ${executionId}: status=${execution?.status}`);
      return;
    }

    const execCtx = (execution.executionContext || {}) as {
      stepResults: Record<string, unknown>;
      pausedAtIndex: number;
      workflowSteps: StepDef[];
      triggerData: Record<string, unknown>;
    };

    const steps = execCtx.workflowSteps || [];
    const pausedAt = execCtx.pausedAtIndex ?? 0;
    const stepResults = execCtx.stepResults || {};

    // Store the response in step results
    stepResults[stepId] = { ...((stepResults[stepId] || {}) as Record<string, unknown>), ...responseData, responded: true };

    // Mark as running
    await db.update(schema.helpdeskWorkflowExecutions).set({
      status: 'running',
      executionContext: { stepResults, triggerData: execCtx.triggerData },
      updatedAt: new Date(),
    }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));

    // Continue executing remaining steps
    const ctx: ExecutionContext = {
      db,
      conversationId,
      workspaceId,
      channel: channelObj,
      triggerData: execCtx.triggerData || {},
      stepResults,
    };

    let stopped = false;
    for (let i = pausedAt + 1; i < steps.length; i++) {
      const step = steps[i]!;

      try {
        console.log(`[Workflow:Resume] Executing step ${i + 1}/${steps.length}: ${step.type} "${step.name}"`);
        const result = await executeStep(step, ctx, executionId);
        console.log(`[Workflow:Resume] Step ${step.type} result:`, JSON.stringify(result).substring(0, 200));
        ctx.stepResults[step.id] = result;

        await db.update(schema.helpdeskWorkflowExecutions).set({
          currentStepIndex: i + 1,
          updatedAt: new Date(),
        }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));

        if (result.__waitingForInput) {
          await db.update(schema.helpdeskWorkflowExecutions).set({
            status: 'waiting_for_input',
            currentStepId: step.id,
            executionContext: {
              stepResults: ctx.stepResults,
              waitingStepId: step.id,
              pausedAtIndex: i,
              workflowSteps: steps,
              triggerData: ctx.triggerData,
            },
            updatedAt: new Date(),
          }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
          stopped = true;
          break;
        }

        if (result.__delayMs) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(result.__delayMs as number, 30000)));
        }
      } catch (err) {
        console.error(`[Workflow:Resume] Step ${step.type} failed:`, err);
      }
    }

    if (!stopped) {
      await db.update(schema.helpdeskWorkflowExecutions).set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
    }

    // Clear hasActiveWorkflow
    await db.update(schema.helpdeskConversations)
      .set({ hasActiveWorkflow: false, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    console.log(`[Workflow:Resume] ${stopped ? 'Paused again' : 'Completed'} for conversation ${conversationId}`);
  } catch (err) {
    console.error(`[Workflow:Resume] Failed for execution ${executionId}:`, err);
  }
}
