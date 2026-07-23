/**
 * Cloudflare Workflow entrypoint for WeldConnect executions.
 *
 * The durable shell around the runtime-agnostic engine: it adapts the
 * Cloudflare `WorkflowStep` to the engine's `StepRuntime` port, loads the
 * workflow + tenant db, runs `executeWorkflowSteps`, handles waiting-for-input
 * resume, and finalizes. All step orchestration logic lives in `src/engine/`.
 *
 * NOTE: this wires the `task` source. helpdesk-source table parity is completed
 * during integration (only the execution/step/variable table set differs).
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { and, eq, isNull, or } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { getTenantDbForWorkspace, schema, type Database } from './db';
import { generateId } from './lib/id';
import type {
  TriggerType,
  WorkflowEnv,
  StepRuntime,
  WorkflowDefinition,
  WorkflowRunContext,
} from './engine/types';
import { executeWorkflowSteps } from './engine/execute-steps';
import { executeAction } from './engine/actions';
import { buildExecutionHooks, type RealtimeLike } from './engine/persistence';
import { updateWorkflowStats } from './engine/stats';
import { fireWorkflowCompleteTriggers } from './engine/workflow-complete';
import { runWorkflowScheduleSweep } from './cron/schedule-sweep';
import { runGatewayCreditRollup } from './cron/gateway-credit-rollup';
import { rebuildScheduleIndex } from './schedule-index';

export interface ExecuteWorkflowParams {
  workspaceId: string;
  userId: string;
  workflowId: string;
  triggerId?: string;
  triggerType: TriggerType;
  triggerData?: Record<string, unknown>;
  chainDepth?: number;
  source?: 'task' | 'helpdesk';
}

export type Env = WorkflowEnv;

type LoadResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      name: string;
      version: number;
      steps: WorkflowDefinition['steps'];
      variables: Record<string, unknown>;
    };

/** Adapts a Cloudflare `WorkflowStep` to the engine's `StepRuntime` port. */
export function makeStepRuntime(step: WorkflowStep): StepRuntime {
  return {
    do: (name: string, fn: () => Promise<unknown>) => step.do(name, fn as () => Promise<never>),
    sleep: (name: string, ms: number) => step.sleep(name, ms),
    waitForEvent: (name: string, opts: { type: string; timeoutMs?: number }) =>
      step.waitForEvent(name, { type: opts.type, timeout: opts.timeoutMs }),
  } as StepRuntime;
}

export class ExecuteWorkflowWorkflow extends WorkflowEntrypoint<Env, ExecuteWorkflowParams> {
  async run(event: WorkflowEvent<ExecuteWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    const params = event.payload;
    const rt = (this.env.REALTIME ? new RealtimePublisher(this.env.REALTIME) : null) as RealtimeLike | null;

    // 1. Load workflow + variables. (CF wraps step.do results in Serializable<T>;
    // we annotate the callback loosely and cast the result back to LoadResult.)
    const loadResult = (await step.do('load-workflow', async (): Promise<any> => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const [workflow] = await db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, params.workflowId), isNull(schema.workflows.deletedAt)))
        .limit(1);
      if (!workflow) throw new Error(`Workflow ${params.workflowId} not found`);
      if (workflow.status !== 'active') return { skipped: true, reason: 'Workflow not active' } as const;

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

      return {
        skipped: false as const,
        name: workflow.name,
        version: workflow.version,
        steps: (workflow.steps || []) as WorkflowDefinition['steps'],
        variables,
      };
    })) as LoadResult;

    if (loadResult.skipped) {
      return { skipped: true, reason: loadResult.reason };
    }
    const { name: workflowName, version, steps, variables } = loadResult;

    // 2. Create execution record + publish started.
    const executionId = await step.do('create-execution', async () => {
      const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const execId = generateId('wex');
      const now = new Date();
      await db.insert(schema.workflowExecutions).values({
        id: execId,
        workflowId: params.workflowId,
        workflowVersion: version,
        workflowName,
        status: 'running',
        triggeredBy: params.userId,
        triggerType: params.triggerType || 'manual',
        triggerId: params.triggerId,
        triggerData: params.triggerData as Record<string, unknown>,
        startedAt: now,
        totalSteps: steps.length,
        currentStepIndex: 0,
        cfWorkflowInstanceId: event.instanceId,
        createdAt: now,
        updatedAt: now,
      });
      await rt?.workflowExecutionEvent(params.workspaceId, execId, 'started', {
        executionId: execId,
        workflowId: params.workflowId,
        workflowName,
        totalSteps: steps.length,
      });
      return execId;
    });

    const enrichedTriggerData = {
      ...(typeof params.triggerData === 'object' && params.triggerData !== null
        ? params.triggerData
        : { data: params.triggerData }),
      userId: params.userId,
      workspaceId: params.workspaceId,
      triggerType: params.triggerType || 'manual',
      workflowId: params.workflowId,
      workflowName,
      executionId,
    };

    // 3. Run the engine (durable via the step runtime; persistence via hooks).
    const db = await getTenantDbForWorkspace(this.env, params.workspaceId);
    const runtime = makeStepRuntime(step);
    const hooks = buildExecutionHooks({
      db,
      rt,
      workspaceId: params.workspaceId,
      executionId,
      totalSteps: steps.length,
    });
    const context: WorkflowRunContext = {
      tenant: { workspaceId: params.workspaceId, userId: params.userId },
      executionId,
      db: db as Database,
      env: this.env,
      triggerData: enrichedTriggerData,
      variables,
      contactData: {},
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
          .where(eq(schema.workflowExecutions.id, executionId));
      });
      const seedOutput = { ...result.output, [waitingStepId]: resumeEvent.payload ?? {} };
      result = await executeWorkflowSteps(
        workflow,
        context,
        { runtime, executeAction, hooks },
        { startIndex: waitingIndex + 1, seedOutput },
      );
    }

    // 5. Finalize.
    await step.do('finalize', async () => {
      const finalizeDb = await getTenantDbForWorkspace(this.env, params.workspaceId);
      const succeeded = result.status === 'completed';
      await finalizeDb
        .update(schema.workflowExecutions)
        .set({
          status: succeeded ? 'completed' : 'failed',
          completedAt: new Date(),
          output: result.output,
          error: result.error ? { message: result.error.message, stepId: result.error.stepId } : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.workflowExecutions.id, executionId));
      await updateWorkflowStats(finalizeDb, params.workflowId, succeeded, params.source);
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
    });

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
