/**
 * workflow_complete chaining — when a workflow finishes, start any downstream
 * workflows whose `workflow_complete` trigger points at it.
 *
 * The matcher is a pure function (unit-tested); `fireWorkflowCompleteTriggers`
 * loads candidates from the db and dispatches via the EXECUTE_WORKFLOW binding.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../db';
import type { WorkflowDb, WorkflowEnv } from './types';

export const MAX_CHAIN_DEPTH = 10;

export interface WorkflowCandidate {
  id: string;
  name?: string;
  triggers?: Array<{ type: string; isEnabled?: boolean; config?: Record<string, unknown> }> | null;
  _source: 'task' | 'helpdesk';
}

export interface ChainDispatch {
  workflowId: string;
  source: 'task' | 'helpdesk';
  passOutput: boolean;
}

/**
 * Pure matcher: which candidates should fire given the completed workflow id
 * and whether it succeeded. Excludes the completed workflow itself.
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
    for (const trigger of candidate.triggers ?? []) {
      if (trigger.type !== 'workflow_complete' || !trigger.isEnabled) continue;
      const config = trigger.config as
        | { sourceWorkflowId?: string; triggerOn?: string; passOutput?: boolean }
        | undefined;
      if (config?.sourceWorkflowId !== completedWorkflowId) continue;
      if (config?.triggerOn !== 'both' && config?.triggerOn !== status) continue;
      out.push({
        workflowId: candidate.id,
        source: candidate._source,
        passOutput: config?.passOutput === true,
      });
    }
  }
  return out;
}

export async function fireWorkflowCompleteTriggers(
  env: WorkflowEnv,
  db: WorkflowDb,
  completedWorkflowId: string,
  workspaceId: string,
  userId: string,
  succeeded: boolean,
  output: Record<string, unknown>,
  chainDepth: number,
): Promise<void> {
  try {
    if (chainDepth >= MAX_CHAIN_DEPTH) {
      console.warn(`Workflow chain depth limit reached (${MAX_CHAIN_DEPTH}), skipping`);
      return;
    }

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
      ...(taskWorkflows as any[]).map((w) => ({ ...w, _source: 'task' as const })),
      ...(helpdeskList as any[]).map((w) => ({ ...w, _source: 'helpdesk' as const })),
    ];

    const dispatches = matchWorkflowCompleteTriggers(candidates, completedWorkflowId, succeeded);
    const status = succeeded ? 'success' : 'failure';

    for (const d of dispatches) {
      await env.EXECUTE_WORKFLOW?.create({
        params: {
          workspaceId,
          userId,
          workflowId: d.workflowId,
          triggerType: 'workflow_complete',
          source: d.source,
          triggerData: {
            sourceWorkflowId: completedWorkflowId,
            status,
            ...(d.passOutput ? { output } : {}),
          },
          chainDepth: chainDepth + 1,
        },
      });
    }
  } catch (err) {
    console.error(`Failed to fire workflow_complete triggers: ${err}`);
  }
}
