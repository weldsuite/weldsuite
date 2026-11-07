import { describe, it, expect, vi } from 'vitest';
import { handleMergeCommentOnIssue, handleMergeCreateIssue, handleMergeUpdateIssue } from './merge';
import { actionHandlers } from './index';
import { makeActionContext } from '../../test/ctx';
import type { WorkflowEnv } from '../types';

const owned = { workspaceId: 'ws_1', userId: 'system', ownerUserId: 'owner_1' };

function mergeInternal(result: Record<string, unknown>) {
  const workflowAction = vi.fn(async (_envelope: unknown) => ({
    ok: true,
    issueId: null,
    issueKey: null,
    commentId: null,
    error: null,
    ...result,
  }));
  return { env: { MERGE_INTERNAL: { workflowAction } } as unknown as WorkflowEnv, workflowAction };
}

describe('merge.* actions', () => {
  it('are registered with the engine', () => {
    for (const type of ['merge.create_issue', 'merge.update_issue', 'merge.comment_on_issue']) {
      expect(actionHandlers[type]).toBeTypeOf('function');
    }
  });

  it('create the issue as the workflow owner, with the run chain depth', async () => {
    const { env, workflowAction } = mergeInternal({ issueId: 'mis_1', issueKey: 'PLAT-1' });
    const res = await handleMergeCreateIssue(
      { teamId: 'mtm_1', title: 'Customer asked for export' },
      makeActionContext({ env, tenant: owned, chainDepth: 2 }),
    );
    expect(res).toEqual({ issueId: 'mis_1', issueKey: 'PLAT-1', commentId: null, url: '/weldmerge/issues/PLAT-1' });
    expect(workflowAction).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      userId: 'owner_1',
      action: 'merge.create_issue',
      input: { teamId: 'mtm_1', title: 'Customer asked for export' },
      chainDepth: 2,
    });
  });

  it('update and comment return what merge-api answered', async () => {
    const { env } = mergeInternal({ issueId: 'mis_1', issueKey: 'PLAT-1', commentId: 'mcm_1' });
    const ctx = makeActionContext({ env, tenant: owned });
    expect(await handleMergeUpdateIssue({ issue: 'PLAT-1', status: 'done' }, ctx)).toMatchObject({ issueKey: 'PLAT-1' });
    expect(await handleMergeCommentOnIssue({ issue: 'PLAT-1', body: 'Shipped' }, ctx)).toMatchObject({ commentId: 'mcm_1' });
  });

  it('fail the step without retrying when merge-api refuses', async () => {
    const { env } = mergeInternal({ ok: false, error: 'The member this call acts for may not create issues (merge_issues:create)' });
    const err = await handleMergeCreateIssue({ teamId: 'mtm_1', title: 'x' }, makeActionContext({ env, tenant: owned })).then(() => new Error("resolved"), (e: Error) => e);
    expect(err.name).toBe('NonRetryableStepError');
    expect(err.message).toContain('merge_issues:create');
  });

  it('fail clearly without the binding or without an owner', async () => {
    const noBinding = await handleMergeCreateIssue({ teamId: 'a', title: 'b' }, makeActionContext({ tenant: owned })).then(() => new Error("resolved"), (e: Error) => e);
    expect(noBinding.message).toContain('not available');
    const { env } = mergeInternal({});
    const noOwner = await handleMergeCreateIssue({ teamId: 'a', title: 'b' }, makeActionContext({ env })).then(() => new Error("resolved"), (e: Error) => e);
    expect(noOwner.message).toContain('no owner');
  });
});
