/**
 * workflow_complete chaining — when a workflow finishes, start any downstream
 * workflows whose `workflow_complete` trigger ("After another workflow
 * finishes") points at it.
 *
 * The matcher is a pure function (unit-tested); `fireWorkflowCompleteTriggers`
 * loads candidates from the db and dispatches via the EXECUTE_WORKFLOW binding.
 *
 * The editor stores the trigger's settings flat on the trigger
 * (`{ type, sourceWorkflowId, triggerOn, passOutput }`); older payloads nest
 * them under `config`. Both are read, flat first — the same rule the
 * activation gate in connect-api (services/weldconnect-mvp.ts) applies.
 *
 * Who calls this: the durable shell's finalize step (src/index.ts), only for a
 * run that really finished. A cancelled run returns before it, and a Test run
 * (`isTest`) never chains: testing workflow A must not start workflow B for real.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../db';
import type { WorkflowDb, WorkflowEnv } from './types';

export const MAX_CHAIN_DEPTH = 10;

/** `triggerOn` values; `both` = whatever the outcome. */
export const WORKFLOW_COMPLETE_OUTCOMES = ['success', 'failure', 'both'] as const;
export type WorkflowCompleteOutcome = (typeof WORKFLOW_COMPLETE_OUTCOMES)[number];

export interface WorkflowCandidate {
  id: string;
  name?: string;
  triggers?: Array<Record<string, unknown> & { type: string; isEnabled?: boolean; config?: Record<string, unknown> }> | null;
  _source: 'weldconnect' | 'helpdesk';
}

export interface ChainDispatch {
  workflowId: string;
  source: 'weldconnect' | 'helpdesk';
  passOutput: boolean;
}

type CandidateTrigger = NonNullable<WorkflowCandidate['triggers']>[number];

/** A trigger setting stored flat on the trigger (editor) or under `config` (older payloads). */
function triggerSetting(trigger: CandidateTrigger, key: string): unknown {
  const flat = trigger[key];
  if (flat !== undefined && flat !== null && flat !== '') return flat;
  const config = trigger.config;
  return config && typeof config === 'object' ? config[key] : undefined;
}

/** The outcome a trigger waits for; a trigger saved without one fires on success (the editor's default). */
export function workflowCompleteOutcome(trigger: CandidateTrigger): WorkflowCompleteOutcome {
  const value = triggerSetting(trigger, 'triggerOn');
  return (WORKFLOW_COMPLETE_OUTCOMES as readonly unknown[]).includes(value) ? (value as WorkflowCompleteOutcome) : 'success';
}

/** Whether an enabled workflow_complete trigger targets the completed workflow and outcome. */
function triggerMatches(trigger: CandidateTrigger, completedWorkflowId: string, status: 'success' | 'failure'): boolean {
  // Disabled only when explicitly switched off, like every other trigger type.
  if (trigger.type !== 'workflow_complete' || trigger.isEnabled === false) return false;
  if (triggerSetting(trigger, 'sourceWorkflowId') !== completedWorkflowId) return false;
  const outcome = workflowCompleteOutcome(trigger);
  return outcome === 'both' || outcome === status;
}

/**
 * Pure matcher: which candidates should fire given the completed workflow id
 * and whether it succeeded. Excludes the completed workflow itself, and a
 * workflow fires at most once per completed run even with several matching triggers.
 */
export function matchWorkflowCompleteTriggers(
  candidates: WorkflowCandidate[],
  completedWorkflowId: string,
  succeeded: boolean,
): ChainDispatch[] {
  const status = succeeded ? 'success' : 'failure';
  const out: ChainDispatch[] = [];

  for (const candidate of candidates) {
    if (candidate.id === completedWorkflowId) continue;
    const matching = (candidate.triggers ?? []).filter((trigger) =>
      triggerMatches(trigger, completedWorkflowId, status),
    );
    if (matching.length === 0) continue;
    out.push({
      workflowId: candidate.id,
      source: candidate._source,
      passOutput: matching.some((trigger) => triggerSetting(trigger, 'passOutput') === true),
    });
  }
  return out;
}

export interface CompletedRun {
  workflowId: string;
  workflowName?: string;
  executionId: string;
  workspaceId: string;
  /** Who caused the completed run; the chained run is attributed to them too. */
  userId: string;
  succeeded: boolean;
  output: Record<string, unknown>;
  chainDepth: number;
}

/**
 * `{{trigger.*}}` of a chained run: which run finished, how, and (when the
 * trigger asks for it) that run's step outputs keyed by step id.
 */
export function chainedTriggerData(run: CompletedRun, passOutput: boolean): Record<string, unknown> {
  return {
    sourceWorkflowId: run.workflowId,
    ...(run.workflowName ? { sourceWorkflowName: run.workflowName } : {}),
    sourceExecutionId: run.executionId,
    status: run.succeeded ? 'success' : 'failure',
    ...(passOutput ? { output: run.output } : {}),
  };
}

/**
 * Instance id of a chained run: one per (completed run, downstream workflow),
 * so a finalize step that Cloudflare retries cannot start the same chain twice
 * (the second `create` with that id is refused).
 */
export function chainInstanceId(executionId: string, workflowId: string): string {
  return `${executionId}-then-${workflowId}`.slice(0, 100);
}

export async function fireWorkflowCompleteTriggers(
  env: WorkflowEnv,
  db: WorkflowDb,
  run: CompletedRun,
): Promise<ChainDispatch[]> {
  if (run.chainDepth >= MAX_CHAIN_DEPTH) {
    console.warn(`Workflow chain depth limit reached (${MAX_CHAIN_DEPTH}), skipping`);
    return [];
  }

  let dispatches: ChainDispatch[];
  try {
    const [taskWorkflows, helpdeskList] = await Promise.all([
      db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.status, 'active'), isNull(schema.workflows.deletedAt))),
      db
        .select()
        .from(schema.helpdeskWorkflows)
        .where(
          and(eq(schema.helpdeskWorkflows.status, 'active'), isNull(schema.helpdeskWorkflows.deletedAt)),
        ),
    ]);

    const candidates: WorkflowCandidate[] = [
      ...taskWorkflows.map((w) => ({
        id: w.id,
        name: w.name,
        triggers: w.triggers as WorkflowCandidate['triggers'],
        _source: 'weldconnect' as const,
      })),
      ...helpdeskList.map((w) => ({
        id: w.id,
        name: w.name,
        triggers: w.triggers as WorkflowCandidate['triggers'],
        _source: 'helpdesk' as const,
      })),
    ];
    dispatches = matchWorkflowCompleteTriggers(candidates, run.workflowId, run.succeeded);
  } catch (err) {
    console.error(`Failed to load workflow_complete triggers: ${err}`);
    return [];
  }

  await Promise.all(
    dispatches.map(async (d) => {
      // One failed (or already started) dispatch must not stop the others.
      try {
        await env.EXECUTE_WORKFLOW?.create({
          id: chainInstanceId(run.executionId, d.workflowId),
          params: {
            workspaceId: run.workspaceId,
            userId: run.userId,
            workflowId: d.workflowId,
            triggerType: 'workflow_complete',
            source: d.source,
            triggerData: chainedTriggerData(run, d.passOutput),
            chainDepth: run.chainDepth + 1,
          },
        });
      } catch (err) {
        console.warn(`Could not start chained workflow ${d.workflowId}: ${err}`);
      }
    }),
  );
  return dispatches;
}
