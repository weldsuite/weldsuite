/**
 * ExecuteSequenceWorkflow — Cloudflare Workflow
 *
 * Executes CRM sequence steps durably per-enrollment using Cloudflare
 * Workflows step.do() for persistence and step.sleep() for delays.
 *
 * Ported from apps/api-worker/src/workflows/execute-sequence.ts (W4
 * legacy-worker phase-out). Hosted in crm-api under the workflow names
 * `execute-sequence-v3[-dev]` (bound as EXECUTE_SEQUENCE and re-exported from
 * crm-api's src/index.ts, where routes/sequences dispatches it). app-api keeps
 * its old `execute-sequence-v2*` names and re-exports this class only while
 * their in-flight instances drain (docs/plans/app-api-module-split.md,
 * "Workflows draining in app-api").
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, getMasterDb, schema, masterSchema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { resolveInputs } from './execute-workflow/resolve-inputs';
import { evaluateCondition } from './execute-workflow/evaluate-condition';
// TODO(weldconnect-rebuild): fold execute-workflow helpers into workflow-worker engine;
// kept here because CRM sequence execution still imports this legacy executor copy.
import { executeAction, isWaitingForInput, type ActionContext, type ActionEnv } from './execute-workflow/action-handlers';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';

/**
 * The bindings the workflow reads: tenant/master DB resolution plus what the
 * step runners need (action-handlers' `ActionEnv`). Any worker Env with
 * them fits.
 */
export interface ExecuteSequenceEnv extends DbEnv, ActionEnv {}

// ============================================================================
// Types
// ============================================================================

export interface ExecuteSequenceParams {
  workspaceId: string;   // Clerk org ID
  userId: string;
  sequenceId: string;    // workflows.id
  enrollmentId: string;  // sequenceEnrollments.id
  customerId: string;
}

// NOTE: `any` (not `unknown`) in the fields below is deliberate — values
// returned from `step.do()` must satisfy workers-types' `Rpc.Serializable`
// constraint, and `unknown` is not assignable to it (newer workers-types
// than api-worker was written against).
interface WorkflowStepDef {
  id: string;
  name: string;
  type: string;
  inputs?: Record<string, any>;
  config?: Record<string, any>;
  condition?: { field?: string; operator?: string; value?: any };
  continueOnError?: boolean;
}

// ============================================================================
// Usage tracking helpers (ported from platform/lib/task/usage-tracking.ts)
// ============================================================================

function shouldResetMonthly(lastReset: Date): boolean {
  const now = new Date();
  return now.getUTCFullYear() > lastReset.getUTCFullYear()
    || now.getUTCMonth() > lastReset.getUTCMonth();
}

/** `length` random base36 characters from the Web Crypto RNG. */
function randomBase36(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function generateUsageId(): string {
  return `wsu_${Date.now().toString(36)}_${randomBase36(7)}`;
}

async function resolveInternalWorkspaceId(env: ExecuteSequenceEnv, clerkOrgId: string): Promise<string> {
  if (clerkOrgId.startsWith('ws_')) return clerkOrgId;

  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({ id: masterSchema.workspaces.id })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!workspace) throw new Error(`Workspace not found for: ${clerkOrgId}`);
  return workspace.id;
}

async function checkTaskExecutionLimit(env: ExecuteSequenceEnv, workspaceId: string): Promise<{
  allowed: boolean;
  message: string;
  used: number;
  limit: number | null;
  planName: string;
}> {
  try {
    const masterDb = getMasterDb(env);
    const internalId = await resolveInternalWorkspaceId(env, workspaceId);

    // Get or create usage record
    let [usage] = await masterDb
      .select()
      .from(masterSchema.workspaceUsage)
      .where(eq(masterSchema.workspaceUsage.workspaceId, internalId))
      .limit(1);

    if (!usage) {
      [usage] = await masterDb
        .insert(masterSchema.workspaceUsage)
        .values({
          id: generateUsageId(),
          workspaceId: internalId,
          taskExecutionsThisMonth: 0,
          taskExecutionsLastReset: new Date(),
          emailsSentThisMonth: 0,
          emailsLastReset: new Date(),
          aiCreditsUsedThisMonth: 0,
          aiCreditsLastReset: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
    } else if (shouldResetMonthly(usage.taskExecutionsLastReset)) {
      [usage] = await masterDb
        .update(masterSchema.workspaceUsage)
        .set({
          taskExecutionsThisMonth: 0,
          taskExecutionsLastReset: new Date(),
          emailsSentThisMonth: 0,
          emailsLastReset: new Date(),
          aiCreditsUsedThisMonth: 0,
          aiCreditsLastReset: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(masterSchema.workspaceUsage.id, usage.id))
        .returning();
    }

    // Get plan limits
    const [workspace] = await masterDb
      .select({
        planId: masterSchema.workspaces.planId,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.id, internalId))
      .limit(1);

    let taskLimit: number | null = null;
    let planName = 'Free';

    if (workspace?.planId) {
      const [plan] = await masterDb
        .select()
        .from(masterSchema.plans)
        .where(eq(masterSchema.plans.id, workspace.planId))
        .limit(1);

      if (plan) {
        const features = (plan.features as PlanFeatures) || {};
        taskLimit = features.taskExecutions ?? null;
        planName = plan.name;
      }
    }

    if (!workspace?.planId || taskLimit === undefined) {
      // Fall back to default plan
      const [defaultPlan] = await masterDb
        .select()
        .from(masterSchema.plans)
        .where(eq(masterSchema.plans.isDefault, true))
        .limit(1);

      if (defaultPlan) {
        const features = (defaultPlan.features as PlanFeatures) || {};
        taskLimit = features.taskExecutions ?? 100;
        planName = defaultPlan.name;
      }
    }

    if (taskLimit === null) {
      return { allowed: true, message: 'OK', used: usage.taskExecutionsThisMonth, limit: null, planName };
    }

    if (usage.taskExecutionsThisMonth >= taskLimit) {
      return {
        allowed: false,
        message: `Your ${planName} plan allows ${taskLimit} workflow executions per month. You've used ${usage.taskExecutionsThisMonth}. Upgrade to continue.`,
        used: usage.taskExecutionsThisMonth,
        limit: taskLimit,
        planName,
      };
    }

    return { allowed: true, message: 'OK', used: usage.taskExecutionsThisMonth, limit: taskLimit, planName };
  } catch (error) {
    console.error('[checkTaskExecutionLimit] Error:', error);
    return { allowed: true, message: 'Could not verify limits', used: 0, limit: null, planName: 'Unknown' };
  }
}

async function incrementTaskExecutions(env: ExecuteSequenceEnv, workspaceId: string): Promise<void> {
  try {
    const masterDb = getMasterDb(env);
    const internalId = await resolveInternalWorkspaceId(env, workspaceId);

    const [usage] = await masterDb
      .select({ id: masterSchema.workspaceUsage.id })
      .from(masterSchema.workspaceUsage)
      .where(eq(masterSchema.workspaceUsage.workspaceId, internalId))
      .limit(1);

    if (usage) {
      await masterDb
        .update(masterSchema.workspaceUsage)
        .set({
          taskExecutionsThisMonth: sql`${masterSchema.workspaceUsage.taskExecutionsThisMonth} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(masterSchema.workspaceUsage.id, usage.id));
    }
  } catch (error) {
    console.error('[incrementTaskExecutions] Error:', error);
  }
}

// ============================================================================
// Workflow
// ============================================================================

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;

// `result` is `any` so the step.do() return value satisfies Rpc.Serializable
// (executeAction returns `unknown`, which does not).
type StepOutcome =
  | { type: 'skipped'; stepId: string }
  | { type: 'completed'; stepId: string; result: any; delayMs: number | undefined }
  | { type: 'failed'; stepId: string; error: string }
  | { type: 'error_continued'; stepId: string; error: string };

interface SequenceRunContext {
  env: ExecuteSequenceEnv;
  params: ExecuteSequenceParams;
  rt: RealtimePublisher | null;
  executionId: string;
  steps: WorkflowStepDef[];
  stepResults: Record<string, unknown>;
  enrichedTriggerData: Record<string, unknown>;
  variables: Record<string, any>;
  contactData: Record<string, any>;
}

async function publishExecutionEvent(
  rt: RealtimePublisher | null,
  workspaceId: string,
  executionId: string,
  event: string,
  data: unknown,
): Promise<void> {
  if (rt) await rt.workflowExecutionEvent(workspaceId, executionId, event, data);
}

/** Step 1: check usage limits; marks the enrollment failed when the limit is hit. */
async function checkLimitsForEnrollment(env: ExecuteSequenceEnv, params: ExecuteSequenceParams) {
  const check = await checkTaskExecutionLimit(env, params.workspaceId);
  if (!check.allowed) {
    // Mark enrollment as failed due to limit
    try {
      const db = await getTenantDbForWorkspace(env, params.workspaceId);
      await db.update(schema.sequenceEnrollments).set({
        status: 'failed',
        failedAt: new Date(),
        errorMessage: check.message,
      }).where(eq(schema.sequenceEnrollments.id, params.enrollmentId));
    } catch (e) {
      console.error('Failed to update enrollment after limit check:', e);
    }
  }
  return check;
}

/** Step 2: load sequence definition, variables, and enrollment. */
async function loadSequenceDefinition(env: ExecuteSequenceEnv, params: ExecuteSequenceParams) {
  const db = await getTenantDbForWorkspace(env, params.workspaceId);

  // Load workflow (sequence)
  const workflow = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, params.sequenceId), isNull(schema.workflows.deletedAt)))
    .limit(1)
    .then(rows => rows[0]);

  if (!workflow) throw new Error(`Sequence ${params.sequenceId} not found`);
  if (workflow.status !== 'active') return { skipped: true as const, reason: 'Sequence not active' };

  // Check enrollment is still active
  const enrollment = await db
    .select({
      status: schema.sequenceEnrollments.status,
      customerSnapshot: schema.sequenceEnrollments.customerSnapshot,
    })
    .from(schema.sequenceEnrollments)
    .where(eq(schema.sequenceEnrollments.id, params.enrollmentId))
    .limit(1)
    .then(rows => rows[0]);

  if (!enrollment) throw new Error(`Enrollment ${params.enrollmentId} not found`);
  if (enrollment.status !== 'active') return { skipped: true as const, reason: `Enrollment status is ${enrollment.status}` };

  // Load variables
  const variableRecords = await db
    .select()
    .from(schema.workflowVariables)
    .where(and(
      or(eq(schema.workflowVariables.workflowId, params.sequenceId), isNull(schema.workflowVariables.workflowId)),
      isNull(schema.workflowVariables.deletedAt),
    ));

  const variables: Record<string, any> = {};
  for (const v of variableRecords) {
    variables[v.name] = v.value;
  }

  return {
    skipped: false as const,
    name: workflow.name,
    version: workflow.version,
    steps: (workflow.steps || []) as WorkflowStepDef[],
    variables,
    contactData: (enrollment.customerSnapshot || {}) as Record<string, any>,
  };
}

/** Step 3: create the execution record, bump usage and publish `started`. */
async function createExecutionRecord(
  env: ExecuteSequenceEnv,
  params: ExecuteSequenceParams,
  rt: RealtimePublisher | null,
  instanceId: string,
  workflowName: string,
  workflowVersion: number,
  stepCount: number,
): Promise<string> {
  const db = await getTenantDbForWorkspace(env, params.workspaceId);
  const execId = generateId('wex');
  const now = new Date();

  await db.insert(schema.workflowExecutions).values({
    id: execId,
    workflowId: params.sequenceId,
    workflowVersion,
    workflowName,
    status: 'running',
    triggeredBy: params.userId,
    triggerType: 'manual',
    triggerData: {
      source: 'sequence_enrollment',
      enrollmentId: params.enrollmentId,
      customerId: params.customerId,
    },
    startedAt: now,
    totalSteps: stepCount,
    currentStepIndex: 0,
    cfWorkflowInstanceId: instanceId,
    createdAt: now,
    updatedAt: now,
  });

  // Increment usage counter
  await incrementTaskExecutions(env, params.workspaceId);

  // Publish started event
  await publishExecutionEvent(rt, params.workspaceId, execId, 'started', {
    executionId: execId,
    workflowId: params.sequenceId,
    workflowName,
    totalSteps: stepCount,
  });

  return execId;
}

/** Returns a `skipped` outcome when the step's condition is not met, else null. */
async function skipStepIfConditionFails(
  ctx: SequenceRunContext,
  db: TenantDb,
  wfStep: WorkflowStepDef,
  stepIndex: number,
  stepExecutionId: string,
): Promise<StepOutcome | null> {
  if (!wfStep.condition) return null;
  const { params, rt, executionId, steps, stepResults, enrichedTriggerData, variables, contactData } = ctx;

  const conditionMet = evaluateCondition(wfStep.condition, stepResults, enrichedTriggerData, variables, contactData);
  if (conditionMet) return null;

  await db.update(schema.workflowExecutionSteps).set({
    status: 'skipped', completedAt: new Date(), output: { skipped: true, reason: 'Condition not met' },
  }).where(eq(schema.workflowExecutionSteps.id, stepExecutionId));

  await publishExecutionEvent(rt, params.workspaceId, executionId, 'step_skipped', {
    stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name, reason: 'Condition not met',
  });

  return { type: 'skipped', stepId: wfStep.id };
}

/** Resolves inputs, runs the step's action and records the completed step. */
async function executeStepAction(
  ctx: SequenceRunContext,
  db: TenantDb,
  wfStep: WorkflowStepDef,
  stepIndex: number,
  stepExecutionId: string,
): Promise<StepOutcome> {
  const { env, params, rt, executionId, steps, stepResults, enrichedTriggerData, variables, contactData } = ctx;

  // Resolve inputs
  const resolvedInputs = resolveInputs(
    wfStep.config || wfStep.inputs || {},
    stepResults, enrichedTriggerData, variables, contactData,
  );
  const inputsWithStepId = { ...resolvedInputs, __stepId: wfStep.id };

  // Execute action
  const actionContext: ActionContext = {
    tenant: { workspaceId: params.workspaceId, userId: params.userId },
    executionId,
    db: db as any,
    env,
    previousResults: stepResults,
    triggerData: enrichedTriggerData,
    variables,
  };

  // `any` so the step.do() return value satisfies Rpc.Serializable
  // (executeAction returns `unknown`, which does not).
  const result = (await executeAction(wfStep.type, inputsWithStepId, actionContext)) as any;

  // Sequences don't support interactive pauses
  if (isWaitingForInput(result)) {
    throw new Error(`Step "${wfStep.name}" requires interactive input, which is not supported in sequences`);
  }

  // Handle delay steps — return durationMs for the caller to sleep
  const delayMs: number | undefined = result?.__delayMs;

  // Mark step completed
  await db.update(schema.workflowExecutionSteps).set({
    status: 'completed', completedAt: new Date(), output: result as Record<string, unknown>,
  }).where(eq(schema.workflowExecutionSteps.id, stepExecutionId));

  await publishExecutionEvent(rt, params.workspaceId, executionId, 'step_completed', {
    stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name,
  });

  // Update enrollment progress
  try {
    await db.update(schema.sequenceEnrollments).set({
      currentStepIndex: stepIndex,
    }).where(eq(schema.sequenceEnrollments.id, params.enrollmentId));
  } catch (enrollErr) {
    console.warn('Failed to update enrollment progress:', enrollErr);
  }

  return { type: 'completed', stepId: wfStep.id, result, delayMs };
}

/** Records a failed step; aborts the execution and enrollment unless `continueOnError`. */
async function recordStepFailure(
  ctx: SequenceRunContext,
  db: TenantDb,
  wfStep: WorkflowStepDef,
  stepIndex: number,
  stepExecutionId: string,
  stepError: unknown,
): Promise<StepOutcome> {
  const { params, rt, executionId, steps } = ctx;
  const errorMessage = stepError instanceof Error ? stepError.message : String(stepError);

  await db.update(schema.workflowExecutionSteps).set({
    status: 'failed', completedAt: new Date(), error: { message: errorMessage },
  }).where(eq(schema.workflowExecutionSteps.id, stepExecutionId));

  await publishExecutionEvent(rt, params.workspaceId, executionId, 'step_failed', {
    stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name, error: errorMessage,
  });

  if (wfStep.continueOnError) {
    return { type: 'error_continued', stepId: wfStep.id, error: errorMessage };
  }

  // Mark execution failed
  await db.update(schema.workflowExecutions).set({
    status: 'failed', completedAt: new Date(), updatedAt: new Date(),
    error: { message: errorMessage, stepId: wfStep.id, stepName: wfStep.name },
  }).where(eq(schema.workflowExecutions.id, executionId));

  // Log error
  await db.insert(schema.workflowErrorLogs).values({
    id: generateId('wel'),
    workflowId: params.sequenceId,
    executionId,
    errorMessage,
    stepId: wfStep.id,
    stepName: wfStep.name,
    severity: 'error',
    input: wfStep.inputs as Record<string, unknown>,
    createdAt: new Date(),
    occurredAt: new Date(),
  });

  // Mark enrollment as failed
  try {
    await db.update(schema.sequenceEnrollments).set({
      status: 'failed',
      failedAt: new Date(),
      errorMessage: `Step "${wfStep.name}" failed: ${errorMessage}`,
      currentStepIndex: stepIndex,
    }).where(eq(schema.sequenceEnrollments.id, params.enrollmentId));
  } catch (enrollErr) {
    console.warn('Failed to update enrollment failure status:', enrollErr);
  }

  return { type: 'failed', stepId: wfStep.id, error: errorMessage };
}

/** Step 4 body: runs one step of the sequence inside a durable step.do(). */
async function runSequenceStep(
  ctx: SequenceRunContext,
  wfStep: WorkflowStepDef,
  i: number,
): Promise<StepOutcome> {
  const { env, params, rt, executionId, steps } = ctx;
  const db = await getTenantDbForWorkspace(env, params.workspaceId);
  const stepExecutionId = generateId('wes');
  const stepIndex = i + 1;

  // Publish step_started
  await publishExecutionEvent(rt, params.workspaceId, executionId, 'step_started', {
    stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name, stepType: wfStep.type,
  });

  // Create step execution record
  await db.insert(schema.workflowExecutionSteps).values({
    id: stepExecutionId,
    executionId,
    stepId: wfStep.id,
    stepName: wfStep.name,
    stepType: wfStep.type,
    stepIndex,
    status: 'running',
    input: wfStep.inputs as Record<string, unknown>,
    startedAt: new Date(),
    createdAt: new Date(),
  });

  // Update execution current step
  await db.update(schema.workflowExecutions).set({
    currentStepId: wfStep.id,
    currentStepIndex: stepIndex,
    updatedAt: new Date(),
  }).where(eq(schema.workflowExecutions.id, executionId));

  try {
    const skipped = await skipStepIfConditionFails(ctx, db, wfStep, stepIndex, stepExecutionId);
    if (skipped) return skipped;
    return await executeStepAction(ctx, db, wfStep, stepIndex, stepExecutionId);
  } catch (stepError) {
    return recordStepFailure(ctx, db, wfStep, stepIndex, stepExecutionId, stepError);
  }
}

/** Stores a non-failed outcome in `stepResults`; returns the delay (ms) to sleep, if any. */
function recordStepOutcome(stepResults: Record<string, unknown>, outcome: StepOutcome): number {
  switch (outcome.type) {
    case 'skipped':
      stepResults[outcome.stepId] = { skipped: true };
      return 0;
    case 'error_continued':
      stepResults[outcome.stepId] = { error: outcome.error };
      return 0;
    case 'completed':
      stepResults[outcome.stepId] = outcome.result;
      return outcome.delayMs && outcome.delayMs > 0 ? outcome.delayMs : 0;
    default:
      return 0;
  }
}

/** Step 5: mark the execution and enrollment completed. */
async function finalizeSequence(
  ctx: SequenceRunContext,
  executionStartTime: number,
): Promise<void> {
  const { env, params, executionId, steps, stepResults } = ctx;
  const db = await getTenantDbForWorkspace(env, params.workspaceId);
  const endTime = new Date();
  const duration = endTime.getTime() - executionStartTime;

  // Mark execution completed
  await db.update(schema.workflowExecutions).set({
    status: 'completed',
    completedAt: endTime,
    output: stepResults,
    duration,
    updatedAt: new Date(),
  }).where(eq(schema.workflowExecutions.id, executionId));

  // Update sequence stats
  await updateSequenceStats(db, params.sequenceId);

  // Mark enrollment completed
  try {
    await db.update(schema.sequenceEnrollments).set({
      status: 'completed',
      completedAt: endTime,
      currentStepIndex: steps.length,
    }).where(eq(schema.sequenceEnrollments.id, params.enrollmentId));
  } catch (enrollErr) {
    console.warn('Failed to update enrollment completion status:', enrollErr);
  }
}

export class ExecuteSequenceWorkflow extends WorkflowEntrypoint<ExecuteSequenceEnv, ExecuteSequenceParams> {
  async run(event: WorkflowEvent<ExecuteSequenceParams>, step: WorkflowStep) {
    const params = event.payload;
    const rt = this.env.REALTIME ? new RealtimePublisher(this.env.REALTIME) : null;

    // Step 1: Check usage limits
    const limitResult = await step.do('check-limits', () => checkLimitsForEnrollment(this.env, params));

    if (!limitResult.allowed) {
      return { blocked: true, reason: limitResult.message };
    }

    // Step 2: Load sequence definition, variables, and enrollment
    const loadResult = await step.do('load-sequence', () => loadSequenceDefinition(this.env, params));

    if ('skipped' in loadResult && loadResult.skipped) {
      return { skipped: true, reason: loadResult.reason };
    }

    const { name: workflowName, version: workflowVersion, steps, variables, contactData } = loadResult;

    // Step 3: Create execution record & increment usage
    const executionId = await step.do('create-execution', () =>
      createExecutionRecord(this.env, params, rt, event.instanceId, workflowName, workflowVersion, steps.length),
    );

    // Build enriched trigger data for variable resolution
    const enrichedTriggerData = {
      source: 'sequence_enrollment',
      enrollmentId: params.enrollmentId,
      customerId: params.customerId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      timestamp: new Date().toISOString(),
      triggerType: 'manual',
      workflowId: params.sequenceId,
      workflowName,
      executionId,
    };

    const stepResults: Record<string, unknown> = {};
    const ctx: SequenceRunContext = {
      env: this.env, params, rt, executionId, steps, stepResults, enrichedTriggerData, variables, contactData,
    };
    const executionStartTime = Date.now();

    // Step 4: Execute each step
    for (let i = 0; i < steps.length; i++) {
      const wfStep = steps[i];

      const stepOutcome = await step.do(`step-${i}-${wfStep.id}`, () => runSequenceStep(ctx, wfStep, i));

      // Handle step outcomes outside step.do()
      if (stepOutcome.type === 'failed') {
        await publishExecutionEvent(rt, params.workspaceId, executionId, 'failed', {
          executionId, error: stepOutcome.error, failedStepId: stepOutcome.stepId,
        });
        // Update stats
        await step.do('update-stats-failed', async () => {
          const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
          await updateSequenceStats(db, params.sequenceId);
        });
        return { executionId, status: 'failed', error: stepOutcome.error };
      }

      // Handle delay — sleep after step.do() completes (durable, no compute consumed)
      const delayMs = recordStepOutcome(stepResults, stepOutcome);
      if (delayMs > 0) {
        await step.sleep(`delay-${i}`, delayMs);
      }
    }

    // Step 5: Finalize
    await step.do('finalize', () => finalizeSequence(ctx, executionStartTime));

    // Publish completed event
    await publishExecutionEvent(rt, params.workspaceId, executionId, 'completed', {
      executionId,
      duration: Date.now() - executionStartTime,
      stepsCompleted: steps.length,
    });

    return { success: true, executionId, results: stepResults };
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function updateSequenceStats(db: any, sequenceId: string): Promise<void> {
  try {
    const workflow = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, sequenceId))
      .limit(1)
      .then((rows: any[]) => rows[0]);

    if (workflow) {
      await db.update(schema.workflows).set({
        executionCount: (workflow.executionCount || 0) + 1,
        lastExecutedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.workflows.id, sequenceId));
    }
  } catch (err) {
    console.error('Failed to update sequence stats:', err);
  }
}
