import { describe, expect, it, vi } from 'vitest';
import { MERGE_AGENT_TOOLS } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { MERGE_TOOLS } from './merge-tools';
import { PLATFORM_TOOLS, type ToolContext } from './tools';

function context(answer: { ok: boolean; result?: unknown; error?: string | null }) {
  const agentTool = vi.fn(async (_envelope: unknown) => ({ ok: answer.ok, result: answer.result ?? null, error: answer.error ?? null }));
  const ctx = {
    db: {} as never,
    agentId: 'agt_1',
    actorUserId: 'user_1',
    workspaceId: 'ws_1',
    env: { MERGE_INTERNAL: { agentTool } },
  } as unknown as ToolContext;
  return { ctx, agentTool };
}

const tool = (name: string) => MERGE_TOOLS.find((t) => t.name === name)!;

describe('WeldAgent merge tools', () => {
  it('cover exactly the tools merge-api answers, and are registered as platform tools', () => {
    expect(MERGE_TOOLS.map((t) => t.name).sort()).toEqual([...MERGE_AGENT_TOOLS].sort());
    for (const t of MERGE_TOOLS) expect(PLATFORM_TOOLS).toContain(t);
  });

  it('call MergeInternal as the person the agent works for, with the agent id', async () => {
    const { ctx, agentTool } = context({ ok: true, result: { issues: [], hasMore: false, cursor: null } });
    const result = await tool('merge_list_issues').execute(ctx, { status: ['todo'], q: 'tabs' });
    expect(result).toEqual({ issues: [], hasMore: false, cursor: null });
    expect(agentTool).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      userId: 'user_1',
      agentId: 'agt_1',
      tool: 'merge_list_issues',
      input: { status: ['todo'], q: 'tabs' },
    });
  });

  it('pass merge-api’s refusal on as an error the agent can read', async () => {
    const { ctx } = context({ ok: false, error: 'The member this call acts for may not change issues (merge_issues:update)' });
    expect(await tool('merge_update_issue').execute(ctx, { issue: 'PLAT-1', status: 'done' })).toEqual({
      error: 'The member this call acts for may not change issues (merge_issues:update)',
    });
  });

  it('say so where WeldMerge is not available', async () => {
    const ctx = { db: {} as never, agentId: 'agt_1', actorUserId: 'user_1', workspaceId: 'ws_1', env: {} } as unknown as ToolContext;
    expect(await tool('merge_get_issue').execute(ctx, { issue: 'PLAT-1' })).toEqual({ error: 'WeldMerge is not available to agents here' });
  });

  it('require the permissions the merge-api route checks', () => {
    expect(tool('merge_create_issue').requiredPermissions).toEqual(['merge_issues:create']);
    expect(tool('merge_comment_on_issue').requiredPermissions).toEqual(['merge_issues:update']);
    expect(tool('merge_get_pull_request').requiredPermissions).toEqual(['merge_pull_requests:read']);
    expect(tool('merge_open_draft_pull_request').requiredPermissions).toEqual(['merge_pull_requests:review', 'merge_connections:read']);
  });

  it('refuse input a tool would not take before calling merge-api', async () => {
    const { ctx, agentTool } = context({ ok: true });
    await expect(tool('merge_create_issue').execute(ctx, { title: 'No team' })).rejects.toThrow();
    await expect(tool('merge_open_draft_pull_request').execute(ctx, { repositoryId: 'mrp_1', title: 't', branch: 'b', commitMessage: 'm', files: [] })).rejects.toThrow();
    expect(agentTool).not.toHaveBeenCalled();
  });
});
