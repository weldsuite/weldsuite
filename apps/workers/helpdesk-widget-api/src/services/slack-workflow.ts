/**
 * Inline Slack Workflow Executor
 *
 * Executes helpdesk workflows directly in the widget-api worker.
 * No dependency on helpdesk-workflow-worker.
 * Sends output messages to Slack threads via chat.postMessage.
 */

import { eq, and, isNull, sql, inArray } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

interface ExecuteParams {
  db: Database;
  conversationId: string;
  workspaceId: string;
  eventType: 'conversation_created' | 'message_received';
  botToken: string;
  slackChannelId: string;
  slackThreadTs: string;
  triggerData: Record<string, unknown>;
}

export async function executeSlackWorkflows(params: ExecuteParams): Promise<void> {
  const { db, conversationId, eventType, botToken, slackChannelId, slackThreadTs } = params;

  try {
    // Check for active execution
    const [activeExec] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
          inArray(schema.helpdeskWorkflowExecutions.status, ['running', 'waiting_for_input']),
        ),
      )
      .limit(1);

    if (activeExec) return;

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

    // Match triggers
    const matched = workflows.filter((wf) => {
      const triggers = (wf.triggers || []) as Array<{
        type: string;
        isEnabled?: boolean;
        config?: { entityType?: string; eventType?: string };
      }>;

      return triggers.some((t) => {
        if (t.isEnabled === false) return false;
        if (t.type !== 'entity_event') return false;
        const cfg = t.config;
        if (!cfg) return false;

        if (eventType === 'conversation_created') {
          return cfg.entityType === 'helpdesk_conversation' &&
            (!cfg.eventType || cfg.eventType === 'created');
        } else if (eventType === 'message_received') {
          return (
            (cfg.entityType === 'helpdesk_conversation' && cfg.eventType === 'message_received') ||
            (cfg.entityType === 'helpdesk_conversation_message' && (!cfg.eventType || cfg.eventType === 'created'))
          );
        }
        return false;
      });
    });

    if (matched.length === 0) return;

    console.log(`[Slack Workflow] Matched ${matched.length} workflow(s) for ${eventType}`);

    for (const wf of matched) {
      const steps = ((wf.steps || []) as any[])
        .filter((s: any) => !s.parentBranchId)
        .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));

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
        triggerData: params.triggerData,
        startedAt: now,
        totalSteps: steps.length,
        currentStepIndex: 0,
        conversationId,
        channel: 'slack',
        createdAt: now,
        updatedAt: now,
      });

      let stopped = false;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const inputs = { ...(step.config || {}), ...(step.inputs || {}) };

        console.log(`[Slack Workflow] Step ${i + 1}/${steps.length}: ${step.type} "${step.name}"`);

        try {
          switch (step.type) {
            case 'send_message': {
              const content = String(inputs.message || inputs.content || '');
              if (!content) break;

              await createBotMessage(db, conversationId, content, { source: 'workflow' });
              await touchConversation(db, conversationId);
              await slackSend(botToken, slackChannelId, slackThreadTs, content);
              break;
            }

            case 'send_choices': {
              const content = String(inputs.message || inputs.content || 'Please select an option:');
              const options = (inputs.options as any[]) || [];

              await createBotMessage(db, conversationId, content, {
                interactiveType: 'choices',
                workflowExecutionId: executionId,
                workflowStepId: step.id,
                options,
                source: 'workflow',
              });
              await touchConversation(db, conversationId);

              // Send Block Kit buttons
              await slackSendBlocks(botToken, slackChannelId, slackThreadTs, content, [
                {
                  type: 'actions',
                  block_id: `wf_choices_${step.id}`,
                  elements: options.slice(0, 5).map((opt: any) => ({
                    type: 'button',
                    text: { type: 'plain_text', text: opt.label, emoji: true },
                    action_id: `wf_choice:${conversationId}:${step.id}:${opt.value}`,
                    value: opt.value,
                  })),
                },
              ]);

              // Pause execution
              await db.update(schema.helpdeskWorkflowExecutions).set({
                status: 'waiting_for_input',
                currentStepId: step.id,
                currentStepIndex: i + 1,
                executionContext: { pausedAtIndex: i, workflowSteps: steps, triggerData: params.triggerData },
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
              stopped = true;
              break;
            }

            case 'trigger_csat': {
              const content = String(inputs.message || inputs.question || 'How would you rate your experience?');

              await createBotMessage(db, conversationId, content, {
                interactiveType: 'csat',
                workflowExecutionId: executionId,
                workflowStepId: step.id,
                source: 'workflow',
              });
              await touchConversation(db, conversationId);

              const ratings = [
                { value: '1', emoji: '\u{1F61E}' },
                { value: '2', emoji: '\u{1F641}' },
                { value: '3', emoji: '\u{1F610}' },
                { value: '4', emoji: '\u{1F642}' },
                { value: '5', emoji: '\u{1F60A}' },
              ];

              await slackSendBlocks(botToken, slackChannelId, slackThreadTs, content, [
                {
                  type: 'actions',
                  block_id: `wf_csat_${step.id}`,
                  elements: ratings.map((r) => ({
                    type: 'button',
                    text: { type: 'plain_text', text: `${r.emoji} ${r.value}`, emoji: true },
                    action_id: `wf_csat:${conversationId}:${step.id}:${r.value}`,
                    value: r.value,
                  })),
                },
              ]);

              await db.update(schema.helpdeskWorkflowExecutions).set({
                status: 'waiting_for_input',
                currentStepId: step.id,
                currentStepIndex: i + 1,
                executionContext: { pausedAtIndex: i, workflowSteps: steps, triggerData: params.triggerData },
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
              stopped = true;
              break;
            }

            case 'collect_input':
            case 'collect_customer_info': {
              const content = String(inputs.message || inputs.content || 'Please provide the following information:');
              const fields = (inputs.fields || []) as any[];

              await createBotMessage(db, conversationId, content, {
                interactiveType: 'collect_input',
                workflowExecutionId: executionId,
                workflowStepId: step.id,
                fields,
                source: 'workflow',
              });
              await touchConversation(db, conversationId);

              // Send a button that opens a modal form
              await slackSendBlocks(botToken, slackChannelId, slackThreadTs, content, [
                {
                  type: 'actions',
                  block_id: `wf_form_${step.id}`,
                  elements: [{
                    type: 'button',
                    text: { type: 'plain_text', text: 'Fill in details', emoji: true },
                    action_id: `wf_form:${conversationId}:${step.id}`,
                    style: 'primary',
                  }],
                },
              ]);

              await db.update(schema.helpdeskWorkflowExecutions).set({
                status: 'waiting_for_input',
                currentStepId: step.id,
                currentStepIndex: i + 1,
                executionContext: { pausedAtIndex: i, workflowSteps: steps, triggerData: params.triggerData },
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
              stopped = true;
              break;
            }

            case 'assign_conversation': {
              const assigneeId = inputs.agentId as string | undefined;
              if (assigneeId) {
                await db.update(schema.helpdeskConversations).set({
                  assigneeId,
                  assigneeName: (inputs.agentName as string) || assigneeId,
                  updatedAt: new Date(),
                }).where(eq(schema.helpdeskConversations.id, conversationId));
              }
              break;
            }

            case 'close_conversation':
              await db.update(schema.helpdeskConversations).set({
                status: 'closed',
                closedAt: new Date(),
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskConversations.id, conversationId));
              break;

            case 'change_status':
              await db.update(schema.helpdeskConversations).set({
                status: String(inputs.status || 'active'),
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskConversations.id, conversationId));
              break;

            case 'change_priority':
              await db.update(schema.helpdeskConversations).set({
                priority: String(inputs.priority || 'medium'),
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskConversations.id, conversationId));
              break;

            case 'tag_conversation': {
              const tags = (inputs.tags as string[]) || [];
              if (tags.length === 0) break;
              const [conv] = await db
                .select({ tags: schema.helpdeskConversations.tags })
                .from(schema.helpdeskConversations)
                .where(eq(schema.helpdeskConversations.id, conversationId))
                .limit(1);
              const merged = [...new Set([...((conv?.tags as string[]) || []), ...tags])];
              await db.update(schema.helpdeskConversations).set({
                tags: merged,
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskConversations.id, conversationId));
              break;
            }

            case 'add_internal_note': {
              const content = String(inputs.message || inputs.content || '');
              if (content) {
                await createBotMessage(db, conversationId, content, { source: 'workflow' }, true);
              }
              break;
            }

            case 'delay': {
              // CF Workers can't sleep, skip delays
              break;
            }

            case 'condition':
              break;

            default:
              console.log(`[Slack Workflow] Skipping unsupported step: ${step.type}`);
          }
        } catch (err) {
          console.error(`[Slack Workflow] Step ${step.type} failed:`, err);
        }

        if (stopped) break;
      }

      if (!stopped) {
        await db.update(schema.helpdeskWorkflowExecutions).set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
      }
    }
  } catch (err) {
    console.error(`[Slack Workflow] Execution failed:`, err);
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function createBotMessage(
  db: Database,
  conversationId: string,
  content: string,
  metadata: Record<string, unknown>,
  isInternal = false,
): Promise<string> {
  const id = generateId('msg');
  const now = new Date();
  await db.insert(schema.helpdeskConversationMessages).values({
    id,
    conversationId,
    content,
    authorType: 'agent',
    authorId: 'workflow',
    authorName: 'Bot',
    type: 'message',
    isPublic: !isInternal,
    isInternal,
    status: 'sent',
    isRead: false,
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  return id;
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

/**
 * Resume a paused Slack workflow after interactive step response.
 */
export async function resumeSlackWorkflow(params: {
  db: Database;
  conversationId: string;
  workspaceId: string;
  executionId: string;
  botToken: string;
  slackChannelId: string;
  slackThreadTs: string;
}): Promise<void> {
  const { db, conversationId, executionId, botToken, slackChannelId, slackThreadTs } = params;

  try {
    const [execution] = await db
      .select()
      .from(schema.helpdeskWorkflowExecutions)
      .where(eq(schema.helpdeskWorkflowExecutions.id, executionId))
      .limit(1);

    if (!execution) return;

    const execCtx = (execution.executionContext || {}) as {
      pausedAtIndex: number;
      workflowSteps: any[];
      triggerData: Record<string, unknown>;
    };

    const steps = execCtx.workflowSteps || [];
    const pausedAt = execCtx.pausedAtIndex ?? 0;

    // Mark as running
    await db.update(schema.helpdeskWorkflowExecutions).set({
      status: 'running',
      updatedAt: new Date(),
    }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));

    // Re-execute from the step after the paused one using the main executor logic
    // We create a temporary params object and call the step loop
    let stopped = false;

    for (let i = pausedAt + 1; i < steps.length; i++) {
      const step = steps[i];
      const inputs = { ...(step.config || {}), ...(step.inputs || {}) };

      console.log(`[Slack Workflow:Resume] Step ${i + 1}/${steps.length}: ${step.type} "${step.name}"`);

      try {
        switch (step.type) {
          case 'send_message': {
            const content = String(inputs.message || inputs.content || '');
            if (!content) break;
            await createBotMessage(db, conversationId, content, { source: 'workflow' });
            await touchConversation(db, conversationId);
            await slackSend(botToken, slackChannelId, slackThreadTs, content);
            break;
          }

          case 'assign_conversation': {
            const assigneeId = inputs.agentId as string | undefined;
            if (assigneeId) {
              await db.update(schema.helpdeskConversations).set({
                assigneeId,
                assigneeName: (inputs.agentName as string) || assigneeId,
                updatedAt: new Date(),
              }).where(eq(schema.helpdeskConversations.id, conversationId));
            }
            break;
          }

          case 'close_conversation':
            await db.update(schema.helpdeskConversations).set({
              status: 'closed', closedAt: new Date(), updatedAt: new Date(),
            }).where(eq(schema.helpdeskConversations.id, conversationId));
            break;

          case 'change_status':
            await db.update(schema.helpdeskConversations).set({
              status: String(inputs.status || 'active'), updatedAt: new Date(),
            }).where(eq(schema.helpdeskConversations.id, conversationId));
            break;

          case 'change_priority':
            await db.update(schema.helpdeskConversations).set({
              priority: String(inputs.priority || 'medium'), updatedAt: new Date(),
            }).where(eq(schema.helpdeskConversations.id, conversationId));
            break;

          case 'tag_conversation': {
            const tags = (inputs.tags as string[]) || [];
            if (tags.length === 0) break;
            const [conv] = await db.select({ tags: schema.helpdeskConversations.tags })
              .from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, conversationId)).limit(1);
            const merged = [...new Set([...((conv?.tags as string[]) || []), ...tags])];
            await db.update(schema.helpdeskConversations).set({ tags: merged, updatedAt: new Date() })
              .where(eq(schema.helpdeskConversations.id, conversationId));
            break;
          }

          default:
            console.log(`[Slack Workflow:Resume] Skipping: ${step.type}`);
        }
      } catch (err) {
        console.error(`[Slack Workflow:Resume] Step ${step.type} failed:`, err);
      }
    }

    // Mark complete
    await db.update(schema.helpdeskWorkflowExecutions).set({
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));

    console.log(`[Slack Workflow:Resume] Completed for conversation ${conversationId}`);
  } catch (err) {
    console.error(`[Slack Workflow:Resume] Failed:`, err);
  }
}

async function slackSend(botToken: string, channel: string, threadTs: string, text: string): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

async function slackSendBlocks(
  botToken: string,
  channel: string,
  threadTs: string,
  text: string,
  blocks: unknown[],
): Promise<void> {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...blocks],
    }),
  });
}
