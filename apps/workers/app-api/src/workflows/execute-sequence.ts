/**
 * ExecuteSequenceWorkflow — Cloudflare Workflow
 *
 * Executes CRM sequence steps durably per-enrollment using Cloudflare
 * Workflows step.do() for persistence and step.sleep() for delays.
 *
 * Ported from apps/api-worker/src/workflows/execute-sequence.ts (W4
 * legacy-worker phase-out). Hosted in app-api under the NEW workflow names
 * `execute-sequence-v2[-dev/-test/-preview]` — the old `execute-sequence*`
 * names stay owned by api-worker while its in-flight instances drain (same
 * pattern as send-scheduled-email-v2). Bound as EXECUTE_SEQUENCE and exported
 * from src/index.ts, so the dispatch site in routes/sequences keeps working
 * unchanged.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, getMasterDb, schema, masterSchema } from '../db';
import { generateId } from '../lib/id';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { resolveInputs } from './execute-workflow/resolve-inputs';
import { evaluateCondition } from './execute-workflow/evaluate-condition';
import { executeAction, isWaitingForInput, type ActionContext } from './execute-workflow/action-handlers';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';

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

function generateUsageId(): string {
  return `wsu_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

async function resolveInternalWorkspaceId(env: Env, clerkOrgId: string): Promise<string> {
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

async function checkTaskExecutionLimit(env: Env, workspaceId: string): Promise<{
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

async function incrementTaskExecutions(env: Env, workspaceId: string): Promise<void> {
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

export class ExecuteSequenceWorkflow extends WorkflowEntrypoint<Env, ExecuteSequenceParams> {
  async run(event: WorkflowEvent<ExecuteSequenceParams>, step: WorkflowStep) {
    const params = event.payload;
    const rt = this.env.REALTIME ? new RealtimePublisher(this.env.REALTIME) : null;

    // ------------------------------------------------------------------
    // Step 1: Check usage limits
    // ------------------------------------------------------------------
    const limitResult = await step.do('check-limits', async () => {
      const check = await checkTaskExecutionLimit(this.env, params.workspaceId);
      if (!check.allowed) {
        // Mark enrollment as failed due to limit
        try {
          const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
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
    });

    if (!limitResult.allowed) {
      return { blocked: true, reason: limitResult.message };
    }

    // ------------------------------------------------------------------
    // Step 2: Load sequence definition, variables, and enrollment
    // ------------------------------------------------------------------
    const loadResult = await step.do('load-sequence', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);

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
    });

    if ('skipped' in loadResult && loadResult.skipped) {
      return { skipped: true, reason: loadResult.reason };
    }

    const { name: workflowName, version: workflowVersion, steps, variables, contactData } = loadResult;

    // ------------------------------------------------------------------
    // Step 3: Create execution record & increment usage
    // ------------------------------------------------------------------
    const executionId = await step.do('create-execution', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const execId = generateId('wex');
      const now = new Date();

      await db.insert(schema.workflowExecutions).values({
        id: execId,
        workflowId: params.sequenceId,
        workflowVersion: workflowVersion,
        workflowName: workflowName,
        status: 'running',
        triggeredBy: params.userId,
        triggerType: 'manual',
        triggerData: {
          source: 'sequence_enrollment',
          enrollmentId: params.enrollmentId,
          customerId: params.customerId,
        },
        startedAt: now,
        totalSteps: steps.length,
        currentStepIndex: 0,
        cfWorkflowInstanceId: event.instanceId,
        createdAt: now,
        updatedAt: now,
      });

      // Increment usage counter
      await incrementTaskExecutions(this.env, params.workspaceId);

      // Publish started event
      if (rt) {
        await rt.workflowExecutionEvent(params.workspaceId, execId, 'started', {
          executionId: execId,
          workflowId: params.sequenceId,
          workflowName,
          totalSteps: steps.length,
        });
      }

      return execId;
    });

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

    // ------------------------------------------------------------------
    // Step 4: Execute each step
    // ------------------------------------------------------------------
    const stepResults: Record<string, unknown> = {};
    const executionStartTime = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const wfStep = steps[i];

      const stepOutcome = await step.do(`step-${i}-${wfStep.id}`, async () => {
        const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
        const stepExecutionId = generateId('wes');
        const stepIndex = i + 1;

        // Publish step_started
        if (rt) {
          await rt.workflowExecutionEvent(params.workspaceId, executionId, 'step_started', {
            stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name, stepType: wfStep.type,
          });
        }

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
          // Check condition
          if (wfStep.condition) {
            const shouldSkip = !evaluateCondition(wfStep.condition, stepResults, enrichedTriggerData, variables, contactData);
            if (shouldSkip) {
              await db.update(schema.workflowExecutionSteps).set({
                status: 'skipped', completedAt: new Date(), output: { skipped: true, reason: 'Condition not met' },
              }).where(eq(schema.workflowExecutionSteps.id, stepExecutionId));

              if (rt) {
                await rt.workflowExecutionEvent(params.workspaceId, executionId, 'step_skipped', {
                  stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name, reason: 'Condition not met',
                });
              }

              return { type: 'skipped' as const, stepId: wfStep.id };
            }
          }

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
            env: this.env,
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

          if (rt) {
            await rt.workflowExecutionEvent(params.workspaceId, executionId, 'step_completed', {
              stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name,
            });
          }

          // Update enrollment progress
          try {
            await db.update(schema.sequenceEnrollments).set({
              currentStepIndex: stepIndex,
            }).where(eq(schema.sequenceEnrollments.id, params.enrollmentId));
          } catch (enrollErr) {
            console.warn('Failed to update enrollment progress:', enrollErr);
          }

          return { type: 'completed' as const, stepId: wfStep.id, result, delayMs };

        } catch (stepError) {
          const errorMessage = stepError instanceof Error ? stepError.message : String(stepError);

          await db.update(schema.workflowExecutionSteps).set({
            status: 'failed', completedAt: new Date(), error: { message: errorMessage },
          }).where(eq(schema.workflowExecutionSteps.id, stepExecutionId));

          if (rt) {
            await rt.workflowExecutionEvent(params.workspaceId, executionId, 'step_failed', {
              stepIndex, totalSteps: steps.length, stepId: wfStep.id, stepName: wfStep.name, error: errorMessage,
            });
          }

          if (!wfStep.continueOnError) {
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

            return { type: 'failed' as const, stepId: wfStep.id, error: errorMessage };
          }

          return { type: 'error_continued' as const, stepId: wfStep.id, error: errorMessage };
        }
      });

      // Handle step outcomes outside step.do()
      if (stepOutcome.type === 'skipped') {
        stepResults[stepOutcome.stepId] = { skipped: true };
        continue;
      }

      if (stepOutcome.type === 'failed') {
        if (rt) {
          await rt.workflowExecutionEvent(params.workspaceId, executionId, 'failed', {
            executionId, error: stepOutcome.error, failedStepId: stepOutcome.stepId,
          });
        }
        // Update stats
        await step.do('update-stats-failed', async () => {
          const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
          await updateSequenceStats(db, params.sequenceId);
        });
        return { executionId, status: 'failed', error: stepOutcome.error };
      }

      if (stepOutcome.type === 'error_continued') {
        stepResults[stepOutcome.stepId] = { error: stepOutcome.error };
        continue;
      }

      // Completed step
      stepResults[stepOutcome.stepId] = stepOutcome.result;

      // Handle delay — sleep after step.do() completes (durable, no compute consumed)
      if (stepOutcome.delayMs && stepOutcome.delayMs > 0) {
        await step.sleep(`delay-${i}`, stepOutcome.delayMs);
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Finalize
    // ------------------------------------------------------------------
    await step.do('finalize', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
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
    });

    // Publish completed event
    if (rt) {
      await rt.workflowExecutionEvent(params.workspaceId, executionId, 'completed', {
        executionId,
        duration: Date.now() - executionStartTime,
        stepsCompleted: steps.length,
      });
    }

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
