import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./agents', () => ({ getAgent: vi.fn() }));
vi.mock('./complete-turn', () => ({
  APPROVAL_OUTCOME_KIND: 'approval_outcome',
  persistAssistantMessage: vi.fn(async () => ({})),
}));
vi.mock('../chat/post-agent-message', () => ({ postAgentChatMessage: vi.fn(async () => ({})) }));

import { schema } from '../../db';
import { getAgent } from './agents';
import { persistAssistantMessage } from './complete-turn';
import { postAgentChatMessage } from '../chat/post-agent-message';
import { executeDecidedApproval } from './approvals';
import { PLATFORM_TOOLS } from './tools';

/** Fake tenant DB: `from(table)` decides whether the origin lookup finds a row. */
function fakeDb(found: 'conversation' | 'channel' | 'none') {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schema.weldagentConversations) return found === 'conversation' ? [{ id: 'conv_1' }] : [];
            if (table === schema.chatChannels) return found === 'channel' ? [{ id: 'ch_1' }] : [];
            return [];
          },
        }),
      }),
    }),
  };
}

const agent = {
  id: 'agt_1',
  name: 'Helper',
  permissions: ['tasks:create'],
  enabledTools: [] as string[],
};

function approval(overrides: Partial<{ status: string; conversationId: string | null; toolName: string }> = {}) {
  return {
    id: 'apr_1',
    agentId: 'agt_1',
    conversationId: 'conv_1',
    toolName: 'create_task',
    args: { title: 'Follow up' },
    status: 'approved',
    ...overrides,
  };
}

describe('executeDecidedApproval', () => {
  const createTask = PLATFORM_TOOLS.find((t) => t.name === 'create_task')!;

  beforeEach(() => {
    vi.mocked(getAgent).mockResolvedValue(agent as never);
    vi.mocked(persistAssistantMessage).mockClear();
    vi.mocked(postAgentChatMessage).mockClear();
  });

  it('runs the approved call and posts the outcome as an approval note', async () => {
    const spy = vi.spyOn(createTask, 'execute').mockResolvedValueOnce({ id: 'task_1', title: 'Follow up' });
    const res = await executeDecidedApproval({
      db: fakeDb('conversation') as never,
      env: {} as never,
      workspaceId: 'org_1',
      approval: approval(),
      deciderUserId: 'usr_1',
      deciderPermissions: ['tasks:create'],
    });
    expect(res).toMatchObject({ ran: true, ok: true });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'usr_1', conversationId: 'conv_1' }),
      { title: 'Follow up' },
    );
    expect(persistAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_1',
        metadata: { kind: 'approval_outcome', approvalId: 'apr_1' },
      }),
    );
  });

  it('refuses when the approver lacks the permission the tool needs', async () => {
    const spy = vi.spyOn(createTask, 'execute');
    spy.mockClear();
    const res = await executeDecidedApproval({
      db: fakeDb('conversation') as never,
      env: {} as never,
      workspaceId: 'org_1',
      approval: approval(),
      deciderUserId: 'usr_2',
      deciderPermissions: ['tasks:read'],
    });
    expect(res).toMatchObject({ ran: false, ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a failing tool without throwing', async () => {
    vi.spyOn(createTask, 'execute').mockRejectedValueOnce(new Error('db down'));
    const res = await executeDecidedApproval({
      db: fakeDb('conversation') as never,
      env: {} as never,
      workspaceId: 'org_1',
      approval: approval(),
      deciderUserId: 'usr_1',
      deciderPermissions: ['*'],
    });
    expect(res).toEqual({ ran: true, ok: false, error: 'db down' });
    expect(persistAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('failed: db down') }),
    );
  });

  it('posts room-originated outcomes back into the WeldChat channel', async () => {
    vi.spyOn(createTask, 'execute').mockResolvedValueOnce({ id: 'task_2', title: 'X' });
    await executeDecidedApproval({
      db: fakeDb('channel') as never,
      env: {} as never,
      workspaceId: 'org_1',
      approval: approval({ conversationId: 'ch_1' }),
      deciderUserId: 'usr_1',
      deciderPermissions: ['*'],
    });
    expect(persistAssistantMessage).not.toHaveBeenCalled();
    expect(postAgentChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'ch_1', agentId: 'agt_1' }),
      expect.objectContaining({ content: expect.stringContaining('Approved and done') }),
    );
  });

  it('does not run anything for a rejection', async () => {
    const spy = vi.spyOn(createTask, 'execute');
    spy.mockClear();
    const res = await executeDecidedApproval({
      db: fakeDb('conversation') as never,
      env: {} as never,
      workspaceId: 'org_1',
      approval: approval({ status: 'rejected' }),
      deciderUserId: 'usr_1',
      deciderPermissions: ['*'],
    });
    expect(res).toEqual({ ran: false, ok: true });
    expect(spy).not.toHaveBeenCalled();
    expect(persistAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('rejected') }),
    );
  });
});
