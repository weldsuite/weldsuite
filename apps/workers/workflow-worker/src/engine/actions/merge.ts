/**
 * WeldMerge actions: merge.create_issue, merge.update_issue, merge.comment_on_issue.
 *
 * Like the CRM and WeldFlow actions these never write the tenant tables
 * directly: they call merge-api over its `MergeInternal` entrypoint
 * (`MERGE_INTERNAL.workflowAction`), which checks the workflow OWNER's WeldMerge
 * permissions as they are now (CONN-004), goes through the same issue services
 * as the member routes and publishes the same entity events, with the run's
 * chain depth so the events cannot retrigger workflows forever.
 *
 * A refusal from merge-api (no permission, unknown issue, bad input) comes back
 * as `ok: false` and fails the step without retrying: asking again cannot
 * change the answer.
 */

import type { MergeWorkflowAction } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { ActionContext, ActionHandler } from '../types';
import { NonRetryableStepError } from '../errors';
import { workflowActor } from './helpers';

async function runMergeAction(action: MergeWorkflowAction, inputs: Record<string, unknown>, ctx: ActionContext) {
  const binding = ctx.env.MERGE_INTERNAL;
  if (!binding) throw new NonRetryableStepError('WeldMerge actions are not available on this deployment');
  const actor = workflowActor(ctx);
  const result = await binding.workflowAction({
    workspaceId: actor.workspaceId,
    userId: actor.ownerUserId,
    action,
    input: inputs,
    chainDepth: actor.chainDepth,
  });
  if (!result.ok) throw new NonRetryableStepError(`${action} failed: ${result.error ?? 'WeldMerge refused the action'}`);
  return {
    issueId: result.issueId,
    issueKey: result.issueKey,
    commentId: result.commentId,
    url: result.issueKey ? `/weldmerge/issues/${result.issueKey}` : null,
  };
}

export const handleMergeCreateIssue: ActionHandler = (inputs, ctx) => runMergeAction('merge.create_issue', inputs, ctx);
export const handleMergeUpdateIssue: ActionHandler = (inputs, ctx) => runMergeAction('merge.update_issue', inputs, ctx);
export const handleMergeCommentOnIssue: ActionHandler = (inputs, ctx) =>
  runMergeAction('merge.comment_on_issue', inputs, ctx);
