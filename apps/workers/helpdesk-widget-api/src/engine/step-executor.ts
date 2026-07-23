/**
 * Step Executor — executes a single workflow step handler inline.
 */

import { resolveInputs, evaluateCondition, isInteractiveStep } from './workflow-shared';
import { getHandler } from './handlers';
import type { Database } from '../db';
import type { Env } from '../index';
import type { WorkflowStepDef } from './types';

export interface StepExecutionOptions {
  db: Database;
  env: Env;
  conversationId: string;
  workspaceId: string;
  executionId: string;
  triggerData: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  variables: Record<string, unknown>;
}

export interface StepOutcome {
  type: 'completed' | 'waiting_for_input' | 'delay' | 'failed' | 'skipped';
  result: Record<string, unknown>;
  hasNewMessage: boolean;
  delayMs?: number;
  error?: string;
}

export async function executeStepHandler(
  stepDef: WorkflowStepDef,
  opts: StepExecutionOptions,
  publish: (conversationId: string, msg: Record<string, unknown>) => Promise<void>,
  emit?: (event: { event: string; data: Record<string, unknown> }) => void,
): Promise<StepOutcome> {
  const { db, env, conversationId, workspaceId, executionId, triggerData, stepResults, variables } = opts;

  // Evaluate condition
  if (stepDef.condition) {
    const met = evaluateCondition(stepDef.condition as Record<string, unknown>, stepResults, triggerData, variables, {});
    if (!met) return { type: 'skipped', result: { skipped: true }, hasNewMessage: false };
  }

  // Resolve template inputs
  const rawInputs = { ...(stepDef.config || {}), ...(stepDef.inputs || {}) } as Record<string, unknown>;
  const resolvedInputs = resolveInputs(rawInputs, stepResults, triggerData, variables, {});

  // Get handler
  const handler = getHandler(stepDef.type);
  if (!handler) {
    if (stepDef.type === 'condition') return { type: 'completed', result: {}, hasNewMessage: false };
    console.warn(`[StepExecutor] Unknown step type: ${stepDef.type}, skipping`);
    return { type: 'skipped', result: { skipped: true }, hasNewMessage: false };
  }

  // Build context
  const ctx = {
    inputs: resolvedInputs,
    state: { executionId, workflowId: '', conversationId, stepResults, variables, triggerData },
    options: { db, env, conversationId, workspaceId },
    emit: emit || (() => {}),
    publish: async (msg: any) => {
      await publish(conversationId, {
        type: 'message',
        id: msg.id,
        content: msg.content,
        senderId: msg.senderId,
        senderName: msg.senderName,
        senderType: msg.senderType,
        ts: Date.now(),
      });
    },
    stepDef: stepDef as any,
  };

  try {
    const result = await handler.execute(ctx);

    if (stepDef.type === 'delay') {
      return { type: 'delay', result: { success: true, durationMs: result.durationMs }, hasNewMessage: false, delayMs: result.durationMs as number };
    }

    if (isInteractiveStep(stepDef.type) && result.__waitingForInput) {
      return { type: 'waiting_for_input', result: { messageId: result.messageId, conversationId: result.conversationId }, hasNewMessage: true };
    }

    const isCustomerFacing = ['send_message', 'send_choices', 'collect_input', 'collect_customer_info', 'suggest_articles', 'ai_auto_reply', 'ai_agent'].includes(stepDef.type);
    return { type: result.success ? 'completed' : 'failed', result: result as Record<string, unknown>, hasNewMessage: isCustomerFacing && result.success, error: result.error };
  } catch (err) {
    return { type: 'failed', result: { error: (err as Error).message }, hasNewMessage: false, error: (err as Error).message };
  }
}
