/**
 * Step Executor
 *
 * Executes a single workflow step handler inside a CF Workflow step.do() callback.
 * Handles input resolution, condition evaluation, and returns a typed outcome.
 */

import { resolveInputs, evaluateCondition, isInteractiveStep } from '../lib/workflow-shared';
import { getHandler } from '../engine/registry';
import type { Database } from '../db';

// Ensure all handlers are registered
import '../engine/handlers';
import type { Env } from '../types';

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
  stepDef: {
    id: string;
    type: string;
    name: string;
    config?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    condition?: { field?: string; operator?: string; value?: unknown };
  },
  opts: StepExecutionOptions,
): Promise<StepOutcome> {
  const { db, env, conversationId, workspaceId, executionId, triggerData, stepResults, variables } = opts;

  // Evaluate condition
  if (stepDef.condition) {
    const met = evaluateCondition(
      stepDef.condition as Record<string, unknown>,
      stepResults,
      triggerData,
      variables,
      {},
    );
    if (!met) {
      return { type: 'skipped', result: { skipped: true }, hasNewMessage: false };
    }
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

  // Build step context
  const ctx = {
    inputs: resolvedInputs,
    state: { executionId, workflowId: '', conversationId, stepResults, variables, triggerData },
    options: { db, env, conversationId, workspaceId },
    emit: () => {},
    publish: async () => {},
    stepDef: stepDef as any,
  };

  try {
    const result = await handler.execute(ctx);

    // Check for delay
    if (stepDef.type === 'delay' && result.__delayMs) {
      return { type: 'delay', result: { success: true }, hasNewMessage: false, delayMs: result.__delayMs as number };
    }

    // Check for interactive pause
    if (isInteractiveStep(stepDef.type) && result.__waitingForInput) {
      return {
        type: 'waiting_for_input',
        result: { messageId: result.messageId, conversationId: result.conversationId },
        hasNewMessage: true,
      };
    }

    // Check for customer-facing output (message was persisted to DB by the handler)
    const isCustomerFacing = ['send_message', 'send_choices', 'collect_input', 'collect_customer_info', 'suggest_articles', 'ai_auto_reply', 'ai_agent'].includes(stepDef.type);

    return {
      type: result.success ? 'completed' : 'failed',
      result: result as Record<string, unknown>,
      hasNewMessage: isCustomerFacing && result.success,
      error: result.error,
    };
  } catch (err) {
    return {
      type: 'failed',
      result: { error: (err as Error).message },
      hasNewMessage: false,
      error: (err as Error).message,
    };
  }
}
