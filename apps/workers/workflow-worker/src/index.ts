/**
 * Cloudflare Workflow entrypoint for WeldConnect executions.
 *
 * The durable shell around the runtime-agnostic engine: it adapts the
 * Cloudflare `WorkflowStep` to the engine's `StepRuntime` port, loads the
 * workflow + tenant db, runs `executeWorkflowSteps`, handles waiting-for-input
 * resume, and finalizes. All step orchestration logic lives in `src/engine/`.
 *
 * NOTE: this wires the `weldconnect` source. helpdesk-source table parity is completed
 * during integration (only the execution/step/variable table set differs).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { cancelQueuedExecutionRow, startExecutionRow } from './engine/execution-row';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { getTenantDbForWorkspace, schema, type Database } from './db';
import { generateId } from './lib/id';
import type { TriggerType, WorkflowEnv, WorkflowDefinition, WorkflowRunContext } from './engine/types';
import { makeStepRuntime } from './engine/step-runtime';
import { notifyRunFinished } from './engine/run-notifications';
import { executeWorkflowSteps } from './engine/execute-steps';
import { buildTriggerData } from './engine/trigger-data';
import { executeAction } from './engine/actions';
import { buildExecutionHooks, type RealtimeLike } from './engine/persistence';
import { updateWorkflowStats } from './engine/stats';
import { fireWorkflowCompleteTriggers } from './engine/workflow-complete';
import { runWorkflowScheduleSweep } from './cron/schedule-sweep';
import { runGatewayCreditRollup } from './cron/gateway-credit-rollup';
import { rebuildScheduleIndex } from './schedule-index';
import { handleEntityWorkflowBatch } from './entity-workflows-consumer';
import type { EntityEventMessage } from '@weldsuite/entity-events';

export interface ExecuteWorkflowParams {
  workspaceId: string;
  userId: string;
  workflowId: string;
  triggerId?: string;
  triggerType: TriggerType;
  triggerData?: Record<string, unknown>;
  chainDepth?: number;
  source?: 'weldconnect' | 'helpdesk';
  /**
   * Set by the editor's "Test" button (app-api POST /workflows/:id/test): run
   * the workflow even though it isn't active yet, so it can be tried before
   * publishing. Every other dispatcher leaves this unset, and those runs are
   * skipped for non-active workflows.
   */
  isTest?: boolean;
  /**
   * A `workflow_executions` row the dispatcher already created (status
   * `queued`) so it can hand its id to the caller right away (retry and Test
   * runs). `create-execution` then upgrades that row instead of inserting a
   * new one; without it the worker generates the id itself.
   */
  executionId?: string;
}

export type Env = WorkflowEnv;

type LoadResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      name: string;
      version: number;
      /** The workflow's owner (`created_by`); actions run with their permissions. */
      createdBy: string | null;
      steps: WorkflowDefinition['steps'];
      variables: Record<string, unknown>;
      /** `settings.maxCreditsPerRun`, validated — `null` when unset or invalid. */
      maxCreditsPerRun: number | null;
    };

export class ExecuteWorkflowWorkflow extends WorkflowEntrypoint<Env, ExecuteWorkflowParams> {
  async run(event: WorkflowEvent<ExecuteWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload;
    const publisher = this.env.REALTIME ? new RealtimePublisher(this.env.REALTIME) : null;
    const rt = publisher as RealtimeLike | null;

    // 1. Load workflow + variables. (CF wraps step.do results in Serializable<T>;
    // we annotate the callback loosely and cast the result back to LoadResult.)
    const loadResult = (await step.do('load-workflow', async (): Promise<any> => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const [workflow] = await db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, params.workflowId), isNull(schema.workflows.deletedAt)))
        .limit(1);
      // Skipped (not thrown): a deleted workflow never becomes valid, and a throw
      // here is retried by Cloudflare for ~5 minutes before the run is dropped.
      if (!workflow) return { skipped: true, reason: `Workflow ${params.workflowId} not found` } as const;
      if (workflow.status !== 'active' && !params.isTest) {
        return { skipped: true, reason: 'Workflow not active' } as const;
      }

      const variableRecords = await db
        .select()
        .from(schema.workflowVariables)
        .where(
          and(
            or(
              eq(schema.workflowVariables.workflowId, params.workflowId),
              isNull(schema.workflowVariables.workflowId),
            ),
            isNull(schema.workflowVariables.deletedAt),
          ),
        );
      const variables: Record<string, unknown> = {};
      for (const v of variableRecords) variables[v.name] = v.value;

      // Validated the same way the connect-api settings route does (sane
      // positive integer, else no cap) — an older row can hold a value that's
      // no longer valid (the field used to accept e.g. -5).
      const rawCap = (workflow.settings as { maxCreditsPerRun?: unknown } | null)?.maxCreditsPerRun;
      const maxCreditsPerRun = Number.isInteger(rawCap) && (rawCap as number) >= 1 ? (rawCap as number) : null;

      return {
        skipped: false as const,
        name: workflow.name,
        createdBy: workflow.createdBy ?? null,
        version: workflow.version,
        steps: (workflow.steps || []) as WorkflowDefinition['steps'],
        variables,
        maxCreditsPerRun,
      };
    })) as LoadResult;

    if (loadResult.skipped) {
      // A dispatcher-created row must not sit on `queued` forever.
      if (params.executionId) {
        const skippedId = params.executionId;
        await step.do('cancel-skipped-execution', async () => {
          const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
          await cancelQueuedExecutionRow(db, skippedId, loadResult.reason);
        });
      }
      return { skipped: true, reason: loadResult.reason };
    }
    const { name: workflowName, version, steps, variables, maxCreditsPerRun } = loadResult;
    const ownerUserId = loadResult.createdBy ?? undefined;

    // 2. Create (or upgrade the dispatcher's queued) execution record + publish started.
    const executionId = await step.do('create-execution', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const execId = params.executionId ?? generateId('wex');
      await startExecutionRow(db, {
        id: execId,
        workflowId: params.workflowId,
        workflowVersion: version,
        workflowName,
        triggeredBy: params.userId,
        triggerType: params.triggerType,
        triggerId: params.triggerId,
        triggerData: params.triggerData,
        totalSteps: steps.length,
        cfWorkflowInstanceId: event.instanceId,
        isTest: params.isTest,
      });
      await rt?.workflowExecutionEvent(params.workspaceId, execId, 'started', {
        executionId: execId,
        workflowId: params.workflowId,
        workflowName,
        totalSteps: steps.length,
      });
      return execId;
    });

    const enrichedTriggerData = buildTriggerData(params.triggerType || 'manual', params.triggerData, {
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowId: params.workflowId,
      workflowName,
      executionId,
      startedAt: event.timestamp,
    });

    // 3. Run the engine (durable via the step runtime; persistence via hooks).
    const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
    const runtime = makeStepRuntime(step, NonRetryableError);
    const hooks = buildExecutionHooks({
      db,
      rt,
      workspaceId: params.workspaceId,
      executionId,
      totalSteps: steps.length,
      workflowId: params.workflowId,
    });
    const context: WorkflowRunContext = {
      tenant: { workspaceId: params.workspaceId, userId: params.userId, ownerUserId },
      executionId,
      db: db as Database,
      env: this.env,
      triggerData: enrichedTriggerData,
      variables,
      contactData: {},
      chainDepth: params.chainDepth ?? 0,
      maxCreditsPerRun,
    };
    const workflow: WorkflowDefinition = { id: params.workflowId, name: workflowName, version, steps };

    let result = await executeWorkflowSteps(workflow, context, { runtime, executeAction, hooks });

    // 4. Waiting-for-input resume loop.
    while (result.status === 'waiting_for_input' && result.waiting) {
      const waitingStepId = result.waiting.stepId;
      const waitingIndex = steps.findIndex((s) => s.id === waitingStepId);
      const resumeEvent = (await step.waitForEvent(`wait-input-${waitingIndex}`, {
        type: 'resume-step',
        timeout: '7 days',
      })) as { payload?: Record<string, unknown> };
      await step.do(`resume-${waitingIndex}`, async () => {
        await db
          .update(schema.workflowExecutions)
          .set({ status: 'running', updatedAt: new Date() })
          .where(and(eq(schema.workflowExecutions.id, executionId), ne(schema.workflowExecutions.status, 'cancelled')));
      });
      // The step that waited for input has now finished: count it in the progress.
      await hooks.markFinished(waitingIndex);
      const seedOutput = { ...result.output, [waitingStepId]: resumeEvent.payload ?? {} };
      result = await executeWorkflowSteps(
        workflow,
        context,
        { runtime, executeAction, hooks },
        { startIndex: waitingIndex + 1, seedOutput },
      );
    }

    // 5. Finalize.
    const finalized = (await step.do('finalize', async () => {
      const finalizeDb = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const succeeded = result.status === 'completed';
      const completedAt = new Date();

      // Duration is measured on the row itself (its startedAt is when the
      // worker picked the run up), and the row also says whether this is a test run.
      const [row] = await finalizeDb
        .select({
          status: schema.workflowExecutions.status,
          startedAt: schema.workflowExecutions.startedAt,
          executionContext: schema.workflowExecutions.executionContext,
        })
        .from(schema.workflowExecutions)
        .where(eq(schema.workflowExecutions.id, executionId))
        .limit(1);
      // Cancelled from the UI while the last step was finishing: the cancel
      // stands, and a cancelled run neither counts nor chains nor notifies.
      if (row?.status === 'cancelled') return { cancelled: true };
      const duration = row?.startedAt ? Math.max(0, completedAt.getTime() - row.startedAt.getTime()) : null;
      const isTest = params.isTest === true || row?.executionContext?.isTest === true;

      await finalizeDb
        .update(schema.workflowExecutions)
        .set({
          status: succeeded ? 'completed' : 'failed',
          completedAt,
          duration,
          // A completed run has finished every step, whatever the live counter says.
          ...(succeeded ? { currentStepIndex: steps.length } : {}),
          output: result.output,
          error: result.error ? { message: result.error.message, stepId: result.error.stepId } : null,
          updatedAt: completedAt,
        })
        .where(and(eq(schema.workflowExecutions.id, executionId), ne(schema.workflowExecutions.status, 'cancelled')));

      // Test runs stay out of the workflow's counters and notifications.
      if (!isTest) await updateWorkflowStats(finalizeDb, params.workflowId, succeeded, params.source);
      await fireWorkflowCompleteTriggers(
        this.env,
        finalizeDb,
        params.workflowId,
        params.workspaceId,
        params.userId,
        succeeded,
        result.output,
        params.chainDepth ?? 0,
      );

      if (!isTest && params.source !== 'helpdesk') {
        const [owner] = await finalizeDb
          .select({ createdBy: schema.workflows.createdBy, settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(eq(schema.workflows.id, params.workflowId))
          .limit(1);
        await notifyRunFinished({
          db: finalizeDb,
          rt: publisher,
          workspaceId: params.workspaceId,
          executionId,
          workflowName,
          settings: owner?.settings,
          createdBy: owner?.createdBy,
          triggeredBy: params.userId,
          succeeded,
          errorMessage: result.error?.message,
        });
      }
      return { cancelled: false };
    })) as { cancelled: boolean };

    if (finalized.cancelled) {
      return { success: false, cancelled: true, executionId };
    }

    await rt?.workflowExecutionEvent(
      params.workspaceId,
      executionId,
      result.status === 'completed' ? 'completed' : 'failed',
      { executionId, ...(result.error ? { error: result.error.message } : {}) },
    );

    return { success: result.status === 'completed', executionId, results: result.output };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // One-time / manual backfill of the D1 schedule index from existing tenant
    // schedules. The only fan-out path across all tenants — run once after
    // deploy, never on a timer. Bearer-guarded by INTERNAL_API_SECRET.
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/internal/schedule-index/rebuild') {
      const auth = req.headers.get('Authorization');
      if (!env.INTERNAL_API_SECRET || auth !== `Bearer ${env.INTERNAL_API_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const indexed = await rebuildScheduleIndex(env);
        return Response.json({ ok: true, indexed });
      } catch (err) {
        console.error('[ScheduleIndex] rebuild failed:', err);
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }
    return new Response('workflow-worker: use the EXECUTE_WORKFLOW binding', { status: 404 });
  },

  async queue(batch: MessageBatch<EntityEventMessage>, env: Env): Promise<void> {
    if (batch.queue.startsWith('entity-workflows')) {
      await handleEntityWorkflowBatch(batch, env);
      return;
    }
    console.warn(`[workflow-worker] no consumer registered for queue "${batch.queue}"`);
  },

  // Cron Trigger: workflow schedule sweep (every minute — see wrangler.toml
  // [triggers] per env). Moved here from the obsolete apps/api-worker, which
  // declared the sweep but never registered a cron trigger to run it.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '* * * * *') {
      ctx.waitUntil(
        runWorkflowScheduleSweep(env).catch((err) => {
          console.error('[ScheduleSweep] Failed:', err);
        }),
      );
      // AI gateway credit rollup — this worker owns the only cron in the fleet,
      // so it is the single writer of the credit snapshot every worker routes on.
      // Independent of the sweep: neither should be able to fail the other.
      ctx.waitUntil(
        runGatewayCreditRollup(env).catch((err) => {
          console.error('[GatewayCreditRollup] Failed:', err);
        }),
      );
    }
  },
};
