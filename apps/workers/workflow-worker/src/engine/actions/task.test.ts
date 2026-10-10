import { describe, it, expect, vi } from 'vitest';
import { handleCreateTask } from './task';
import { makeActionContext } from '../../test/ctx';
import type { WorkflowEnv } from '../types';

function connectInternal(response: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(response), { status }));
  return { env: { CONNECT_INTERNAL: { fetch } } as unknown as WorkflowEnv, fetch };
}

const owned = { workspaceId: 'ws_1', userId: 'system', ownerUserId: 'owner_1' };
const ok = {
  success: true,
  task: { id: 'task_1', number: 42, projectId: 'proj_1', title: 'Ship the thing' },
};

describe('create_task', () => {
  it('sends the task with the owner as actor and returns its id', async () => {
    const { env, fetch } = connectInternal(ok);
    const res = await handleCreateTask(
      {
        projectId: 'proj_1',
        title: 'Ship the thing',
        description: 'Get it out the door',
        priority: 'high',
        assigneeIds: ['member_1', 'member_2'],
        tags: 'launch, , urgent',
        dueDate: '2026-11-01T00:00:00.000Z',
      },
      makeActionContext({ env, tenant: owned, chainDepth: 1 }),
    );

    expect(res).toEqual({
      taskId: 'task_1',
      number: 42,
      key: '42',
      projectId: 'proj_1',
      title: 'Ship the thing',
      url: '/weldflow/task/task_1',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/workflow-actions/create-task');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: 'ws_1',
      ownerUserId: 'owner_1',
      triggeredBy: 'system',
      chainDepth: 1,
      projectId: 'proj_1',
      task: {
        title: 'Ship the thing',
        description: 'Get it out the door',
        priority: 'high',
        assigneeIds: ['member_1', 'member_2'],
        tags: ['launch', 'urgent'],
        dueDate: '2026-11-01T00:00:00.000Z',
      },
    });
  });

  it('turns a relative due date into an absolute one at run time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { env, fetch } = connectInternal(ok);
      await handleCreateTask(
        { projectId: 'proj_1', title: 'Follow up', dueDate: 'in 3 days' },
        makeActionContext({ env, tenant: owned }),
      );
      const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(body.task.dueDate).toBe('2026-01-04T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['today', '2026-01-01T00:00:00.000Z'],
    ['tomorrow', '2026-01-02T00:00:00.000Z'],
    ['in 1 week', '2026-01-08T00:00:00.000Z'],
  ])('resolves the "%s" quick pick', async (quickPick, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { env, fetch } = connectInternal(ok);
      await handleCreateTask(
        { projectId: 'proj_1', title: 'Follow up', dueDate: quickPick },
        makeActionContext({ env, tenant: owned }),
      );
      const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(body.task.dueDate).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails without retrying when the run has no owner', async () => {
    const { env } = connectInternal(ok);
    await expect(
      handleCreateTask(
        { projectId: 'proj_1', title: 'X' },
        makeActionContext({ env, tenant: { workspaceId: 'ws_1', userId: 'u' } }),
      ),
    ).rejects.toMatchObject({ name: 'NonRetryableStepError', message: expect.stringMatching(/no owner/) });
  });

  it('needs a project and a title', async () => {
    const { env } = connectInternal(ok);
    await expect(handleCreateTask({ title: 'X' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /project/,
    );
    await expect(handleCreateTask({ projectId: 'proj_1' }, makeActionContext({ env, tenant: owned }))).rejects.toThrow(
      /title/,
    );
  });

  it("turns the owner's missing permission into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner doesn't have permission to create tasks (tasks:create)" },
      403,
    );
    await expect(
      handleCreateTask({ projectId: 'proj_1', title: 'X' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({
      name: 'NonRetryableStepError',
      message: expect.stringMatching(/permission to create tasks/),
    });
  });

  it("turns a denied project write access into a step failure that is not retried", async () => {
    const { env } = connectInternal(
      { success: false, error: "The workflow's owner does not have write access to this project" },
      403,
    );
    await expect(
      handleCreateTask({ projectId: 'proj_1', title: 'X' }, makeActionContext({ env, tenant: owned })),
    ).rejects.toMatchObject({
      name: 'NonRetryableStepError',
      message: expect.stringMatching(/write access to this project/),
    });
  });
});
