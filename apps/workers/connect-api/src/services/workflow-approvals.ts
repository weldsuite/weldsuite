/**
 * Approval steps (`manual_step`) — the decision side.
 *
 * A run that reaches an approval parks on `waiting_for_input`; its step row
 * (`workflow_execution_steps`, status `waiting_for_input`) carries what the
 * engine's handler returned: title, description and `approverIds`
 * (workflow-worker engine/actions/interactive.ts). Deciding records the
 * decision on that row and sends the `resume-step` event to the run's
 * Cloudflare Workflow instance, which carries on after the step with the
 * decision as the step's output (engine/wait-for-input.ts).
 *
 * Who may decide: the listed approvers; when none are listed, any member with
 * `workflow-executions:update` (checked by the route, passed in here).
 *
 * Exactly one decision per waiting step: it is claimed with a conditional
 * update on the step row before the event is sent, so two people clicking at
 * once cannot both resume the run (a second event would otherwise stay
 * buffered and resume the next approval in the same run unseen).
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const { workflowExecutions, workflowExecutionSteps, workspaceMembers } = schema;

/** The Cloudflare Workflow event a waiting run resumes on (workflow-worker engine/wait-for-input.ts). */
export const RESUME_EVENT_TYPE = 'resume-step';

export type ApprovalDecision = 'approved' | 'rejected';

/** What the run's approval step outputs (and the event carries). */
export interface ApprovalDecisionPayload {
  stepId: string;
  approved: boolean;
  decision: ApprovalDecision;
  comment: string | null;
  decidedBy: string;
  decidedByName: string | null;
  decidedAt: string;
}

/** The approval a run is waiting on, as the run page needs it. */
export interface PendingApproval {
  stepRowId: string;
  stepId: string;
  title: string | null;
  description: string | null;
  /** Listed approvers; empty = members with `workflow-executions:update` decide. */
  approverIds: string[];
}

type StepRow = typeof workflowExecutionSteps.$inferSelect;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

function toPendingApproval(row: StepRow): PendingApproval {
  const output = (row.output ?? {}) as Record<string, unknown>;
  return {
    stepRowId: row.id,
    stepId: row.stepId,
    title: typeof output.title === 'string' ? output.title : row.stepName,
    description: typeof output.description === 'string' ? output.description : null,
    approverIds: stringList(output.approverIds),
  };
}

/** The approval step a run is waiting on, or null. */
export async function getPendingApproval(db: Database, executionId: string): Promise<PendingApproval | null> {
  const [row] = await db
    .select()
    .from(workflowExecutionSteps)
    .where(
      and(
        eq(workflowExecutionSteps.executionId, executionId),
        eq(workflowExecutionSteps.status, 'waiting_for_input'),
        eq(workflowExecutionSteps.stepType, 'manual_step'),
      ),
    )
    .orderBy(desc(workflowExecutionSteps.stepIndex))
    .limit(1);
  return row ? toPendingApproval(row) : null;
}

/** Whether a member may decide on this approval. */
export function canDecide(approval: PendingApproval, userId: string, mayUpdateRuns: boolean): boolean {
  return approval.approverIds.length > 0 ? approval.approverIds.includes(userId) : mayUpdateRuns;
}

export interface DecideInput {
  executionId: string;
  userId: string;
  decision: ApprovalDecision;
  comment?: string | null;
  /** The caller holds `workflow-executions:update` (decides when no approvers are listed). */
  mayUpdateRuns: boolean;
  now?: Date;
}

export type DecideResult =
  | { kind: 'decided'; workflowId: string; payload: ApprovalDecisionPayload }
  | { kind: 'not_found' }
  | { kind: 'not_waiting'; status: string }
  | { kind: 'forbidden' }
  | { kind: 'already_decided' }
  | { kind: 'runtime_unavailable' };

/** Minimal shape of the EXECUTE_WORKFLOW binding this needs. */
export interface ResumableWorkflows {
  get(id: string): Promise<{ sendEvent(event: { type: string; payload: unknown }): Promise<void> }>;
}

async function memberName(db: Database, userId: string): Promise<string | null> {
  const [member] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  return member?.name || member?.email || null;
}

/**
 * Approve or reject the approval a run is waiting on, and resume the run.
 * A failed resume releases the claim again, so the decision can be retried.
 */
export async function decideApproval(
  db: Database,
  executeWorkflow: ResumableWorkflows | undefined,
  input: DecideInput,
): Promise<DecideResult> {
  const [execution] = await db
    .select({
      id: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      status: workflowExecutions.status,
      cfWorkflowInstanceId: workflowExecutions.cfWorkflowInstanceId,
    })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, input.executionId))
    .limit(1);
  if (!execution) return { kind: 'not_found' };
  if (execution.status !== 'waiting_for_input') return { kind: 'not_waiting', status: execution.status };

  const approval = await getPendingApproval(db, execution.id);
  if (!approval) return { kind: 'not_waiting', status: execution.status };
  if (!canDecide(approval, input.userId, input.mayUpdateRuns)) return { kind: 'forbidden' };
  if (!executeWorkflow || !execution.cfWorkflowInstanceId) return { kind: 'runtime_unavailable' };

  const comment = input.comment?.trim() ? input.comment.trim().slice(0, 2000) : null;
  const payload: ApprovalDecisionPayload = {
    stepId: approval.stepId,
    approved: input.decision === 'approved',
    decision: input.decision,
    comment,
    decidedBy: input.userId,
    decidedByName: await memberName(db, input.userId),
    decidedAt: (input.now ?? new Date()).toISOString(),
  };

  // Claim the decision: only one caller gets the row while it is undecided.
  const steps = workflowExecutionSteps;
  const claimed = await db
    .update(steps)
    .set({ output: sql`coalesce(${steps.output}, '{}'::jsonb) || ${JSON.stringify({ decision: payload })}::jsonb` })
    .where(
      and(
        eq(steps.id, approval.stepRowId),
        eq(steps.status, 'waiting_for_input'),
        sql`(${steps.output} -> 'decision') is null`,
      ),
    )
    .returning({ id: steps.id });
  if (claimed.length === 0) return { kind: 'already_decided' };

  try {
    const instance = await executeWorkflow.get(execution.cfWorkflowInstanceId);
    await instance.sendEvent({ type: RESUME_EVENT_TYPE, payload });
  } catch (err) {
    // Release the claim so the decision can be made again.
    await db
      .update(steps)
      .set({ output: sql`${steps.output} - 'decision'` })
      .where(and(eq(steps.id, approval.stepRowId), eq(steps.status, 'waiting_for_input')))
      .catch((releaseErr) => console.error('[workflow-approvals] could not release the decision:', releaseErr));
    throw err;
  }

  return { kind: 'decided', workflowId: execution.workflowId, payload };
}
