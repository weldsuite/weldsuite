/**
 * Inline Workflow Executor
 *
 * Executes workflow steps directly in the widget API request — no CF Workflows hop.
 * AI steps (ai_auto_reply, ai_agent) are delegated to the WORKFLOW_WORKER service binding.
 */

import { eq, and, isNull, inArray } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from '../lib/id';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { executeStepHandler, type StepExecutionOptions } from './step-executor';
import type { Database } from '../db';
import type { Env } from '../index';
import type { WorkflowStepDef } from './types';

// ============================================================================
// Types
// ============================================================================

export interface InlineExecutionOptions {
  db: Database;
  env: Env;
  conversationId: string;
  workspaceId: string;
  eventType: 'conversation_created' | 'message_received';
  triggerData: Record<string, unknown>;
  channel: string;
  /** Optional SSE emit function ��� when provided, step events (AI tokens etc.) are streamed. */
  emit?: (event: { event: string; data: Record<string, unknown> }) => void;
}

export interface InlineExecutionResult {
  action: 'completed' | 'waiting_for_input' | 'no_workflows' | 'busy';
  executionId?: string;
  messagesCreated: number;
  waitingStepId?: string;
}

// ============================================================================
// Executor
// ============================================================================

export async function executeWorkflowInline(opts: InlineExecutionOptions): Promise<InlineExecutionResult> {
  const { db, env, conversationId, workspaceId, eventType, triggerData, channel, emit } = opts;
  const rt = env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;

  // Publish helper
  const publish = async (convId: string, msg: Record<string, unknown>) => {
    if (rt) {
      try { await rt.conversationPublish(convId, msg); } catch {}
    }
  };

  // Check for active execution — skip if already running
  const [activeExec] = await db
    .select({ id: schema.helpdeskWorkflowExecutions.id, status: schema.helpdeskWorkflowExecutions.status, executionContext: schema.helpdeskWorkflowExecutions.executionContext })
    .from(schema.helpdeskWorkflowExecutions)
    .where(and(
      eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
      inArray(schema.helpdeskWorkflowExecutions.status, ['running', 'waiting_for_input', 'ai_active']),
    ))
    .limit(1);

  if (activeExec) {
    return { action: 'busy', messagesCreated: 0 };
  }

  // ── Match triggers ──
  const workflows = await db
    .select({ id: schema.helpdeskWorkflows.id, name: schema.helpdeskWorkflows.name, steps: schema.helpdeskWorkflows.steps, triggers: schema.helpdeskWorkflows.triggers })
    .from(schema.helpdeskWorkflows)
    .where(and(eq(schema.helpdeskWorkflows.status, 'active'), isNull(schema.helpdeskWorkflows.deletedAt)))
    .orderBy(schema.helpdeskWorkflows.sortOrder);

  const matched = workflows.filter((wf) => {
    const triggers = (wf.triggers || []) as Array<{ type: string; isEnabled?: boolean; config?: { entityType?: string; eventType?: string; channels?: string[] } }>;
    return triggers.some((t) => {
      if (!t.isEnabled || t.type !== 'entity_event') return false;
      const cfg = t.config;
      if (!cfg) return false;
      if (eventType === 'conversation_created') {
        if (cfg.entityType !== 'helpdesk_conversation') return false;
        if (cfg.eventType && cfg.eventType !== 'created') return false;
      } else if (eventType === 'message_received') {
        const isConvMessage = cfg.entityType === 'helpdesk_conversation' && (cfg.eventType === 'message_received' || cfg.eventType === 'first_message');
        const isMsgCreated = cfg.entityType === 'helpdesk_conversation_message' && (!cfg.eventType || cfg.eventType === 'created');
        if (!isConvMessage && !isMsgCreated) return false;
      }
      if (cfg.channels?.length && !cfg.channels.includes(channel)) return false;
      return true;
    });
  });

  if (!matched.length) return { action: 'no_workflows', messagesCreated: 0 };

  // ── Set hasActiveWorkflow ──
  await db.update(schema.helpdeskConversations)
    .set({ hasActiveWorkflow: true, updatedAt: new Date() })
    .where(eq(schema.helpdeskConversations.id, conversationId));

  let totalMessages = 0;

  for (const workflow of matched) {
    const allSteps = (workflow.steps || []) as WorkflowStepDef[];
    const mainSteps = allSteps.filter((s) => !s.parentBranchId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Create execution record
    const executionId = generateId('wex');
    const now = new Date();
    await db.insert(schema.helpdeskWorkflowExecutions).values({
      id: executionId, helpdeskWorkflowId: workflow.id, workflowVersion: 1, workflowName: workflow.name,
      status: 'running', triggeredBy: 'system', triggerType: 'entity_event', triggerData,
      startedAt: now, totalSteps: mainSteps.length, currentStepIndex: 0,
      conversationId, channel: channel || 'web', executionContext: {},
      createdAt: now, updatedAt: now,
    });

    const stepResults: Record<string, unknown> = {};
    const variables: Record<string, unknown> = {};

    for (let i = 0; i < mainSteps.length; i++) {
      const wfStep = mainSteps[i]!;

      const execOpts: StepExecutionOptions = {
        db, env, conversationId, workspaceId, executionId, triggerData, stepResults, variables,
      };

      const outcome = await executeStepHandler(wfStep, execOpts, publish, emit);
      stepResults[wfStep.id] = outcome.result;

      if (outcome.hasNewMessage) {
        totalMessages++;
        await publish(conversationId, { type: 'refetch', ts: Date.now() });
      }

      // Interactive step — pause and wait for customer response
      if (outcome.type === 'waiting_for_input') {
        await db.update(schema.helpdeskWorkflowExecutions).set({
          status: 'waiting_for_input',
          currentStepIndex: i + 1,
          currentStepId: wfStep.id,
          executionContext: { stepResults, variables, waitingStepId: wfStep.id, allSteps: allSteps, mainStepIndex: i, workflowId: workflow.id },
          updatedAt: new Date(),
        }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));

        return { action: 'waiting_for_input', executionId, messagesCreated: totalMessages, waitingStepId: wfStep.id };
      }

      if (outcome.type === 'failed' && !(wfStep as any).continueOnError) {
        await db.update(schema.helpdeskWorkflowExecutions).set({
          status: 'failed', error: { message: outcome.error || 'Step failed' },
          completedAt: new Date(), updatedAt: new Date(),
        }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
        break;
      }
    }

    // Complete execution
    const [exec] = await db.select({ status: schema.helpdeskWorkflowExecutions.status })
      .from(schema.helpdeskWorkflowExecutions).where(eq(schema.helpdeskWorkflowExecutions.id, executionId)).limit(1);

    if (exec?.status === 'running') {
      await db.update(schema.helpdeskWorkflowExecutions).set({
        status: 'completed', completedAt: new Date(), output: stepResults, updatedAt: new Date(),
      }).where(eq(schema.helpdeskWorkflowExecutions.id, executionId));
    }
  }

  // Finalize
  await db.update(schema.helpdeskConversations)
    .set({ hasActiveWorkflow: false, updatedAt: new Date() })
    .where(eq(schema.helpdeskConversations.id, conversationId));

  if (rt) {
    try {
      await rt.conversationPublish(conversationId, { type: 'refetch', ts: Date.now() });
      await rt.helpdeskEvent(workspaceId, 'conversation_new', { conversationId });
    } catch {}
  }

  return { action: 'completed', messagesCreated: totalMessages };
}
