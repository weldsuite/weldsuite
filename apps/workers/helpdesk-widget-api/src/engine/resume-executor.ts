/**
 * Resume Executor
 *
 * Resumes workflow execution from an interactive step (choices, forms, CSAT).
 * Loads execution state from DB, executes branch children + remaining steps inline.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { schema } from '../db';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { executeStepHandler, type StepExecutionOptions } from './step-executor';
import type { Database } from '../db';
import type { Env } from '../index';
import type { WorkflowStepDef } from './types';

export interface ResumeOptions {
  db: Database;
  env: Env;
  conversationId: string;
  workspaceId: string;
  stepId: string;
  selectedValue?: string;
  selectedLabel?: string;
  submittedData?: Record<string, string>;
  rating?: number;
  feedback?: string;
  emit?: (event: { event: string; data: Record<string, unknown> }) => void;
}

export interface ResumeResult {
  action: 'completed' | 'waiting_for_input' | 'not_found';
  messagesCreated: number;
}

export async function resumeWorkflowInline(opts: ResumeOptions): Promise<ResumeResult> {
  const { db, env, conversationId, workspaceId, stepId, selectedValue, submittedData, rating, feedback, emit } = opts;
  const rt = env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;

  const publish = async (convId: string, msg: Record<string, unknown>) => {
    if (rt) { try { await rt.conversationPublish(convId, msg); } catch {} }
  };

  // Find waiting execution
  const [execution] = await db
    .select()
    .from(schema.helpdeskWorkflowExecutions)
    .where(and(
      eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
      eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
    ))
    .limit(1);

  if (!execution) return { action: 'not_found', messagesCreated: 0 };

  const execCtx = (execution.executionContext || {}) as Record<string, unknown>;
  const stepResults = (execCtx.stepResults || {}) as Record<string, unknown>;
  const variables = (execCtx.variables || {}) as Record<string, unknown>;
  const allSteps = (execCtx.allSteps || []) as WorkflowStepDef[];
  const mainStepIndex = (execCtx.mainStepIndex as number) ?? 0;
  const waitingStepId = execCtx.waitingStepId as string;
  const triggerData = (execution.triggerData || {}) as Record<string, unknown>;

  // Store the response in step results
  stepResults[waitingStepId] = {
    ...(stepResults[waitingStepId] as Record<string, unknown> || {}),
    selectedValue,
    submittedData,
    rating,
    feedback,
    responded: true,
  };

  // Mark execution as running
  await db.update(schema.helpdeskWorkflowExecutions).set({
    status: 'running',
    executionContext: { stepResults, variables, allSteps, mainStepIndex },
    updatedAt: new Date(),
  }).where(eq(schema.helpdeskWorkflowExecutions.id, execution.id));

  let totalMessages = 0;

  // Execute branch children for send_choices
  const waitingStep = allSteps.find((s) => s.id === waitingStepId);
  if (waitingStep?.type === 'send_choices' && selectedValue) {
    const branchId = `${waitingStepId}_branch_${selectedValue}`;
    const branchChildren = allSteps
      .filter((s) => s.parentBranchId === branchId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const branchStep of branchChildren) {
      const outcome = await executeStepHandler(branchStep, {
        db, env, conversationId, workspaceId, executionId: execution.id, triggerData, stepResults, variables,
      }, publish, emit);

      stepResults[branchStep.id] = outcome.result;
      if (outcome.hasNewMessage) {
        totalMessages++;
        await publish(conversationId, { type: 'refetch', ts: Date.now() });
      }
    }
  }

  // Continue with remaining main steps
  const mainSteps = allSteps.filter((s) => !s.parentBranchId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (let i = mainStepIndex + 1; i < mainSteps.length; i++) {
    const wfStep = mainSteps[i]!;

    const execOpts: StepExecutionOptions = {
      db, env, conversationId, workspaceId, executionId: execution.id, triggerData, stepResults, variables,
    };

    const outcome = await executeStepHandler(wfStep, execOpts, publish, emit);
    stepResults[wfStep.id] = outcome.result;

    if (outcome.hasNewMessage) {
      totalMessages++;
      await publish(conversationId, { type: 'refetch', ts: Date.now() });
    }

    if (outcome.type === 'waiting_for_input') {
      await db.update(schema.helpdeskWorkflowExecutions).set({
        status: 'waiting_for_input',
        currentStepIndex: i + 1,
        currentStepId: wfStep.id,
        executionContext: { stepResults, variables, waitingStepId: wfStep.id, allSteps, mainStepIndex: i },
        updatedAt: new Date(),
      }).where(eq(schema.helpdeskWorkflowExecutions.id, execution.id));

      return { action: 'waiting_for_input', messagesCreated: totalMessages };
    }

    if (outcome.type === 'failed' && !(wfStep as any).continueOnError) break;
  }

  // Complete
  await db.update(schema.helpdeskWorkflowExecutions).set({
    status: 'completed', completedAt: new Date(), output: stepResults, updatedAt: new Date(),
  }).where(eq(schema.helpdeskWorkflowExecutions.id, execution.id));

  await db.update(schema.helpdeskConversations)
    .set({ hasActiveWorkflow: false, updatedAt: new Date() })
    .where(eq(schema.helpdeskConversations.id, conversationId));

  if (rt) {
    try { await rt.conversationPublish(conversationId, { type: 'refetch', ts: Date.now() }); } catch {}
  }

  return { action: 'completed', messagesCreated: totalMessages };
}
