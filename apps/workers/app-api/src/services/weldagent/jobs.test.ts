import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ getTenantDbForWorkspace: vi.fn() }));
vi.mock('./complete-turn', () => ({ finishAcceptedTurn: vi.fn(), loadAcceptedTurn: vi.fn(async () => null) }));
vi.mock('./executor', () => ({ BACKGROUND_RUN_TIMEOUT_MS: 1000 }));
vi.mock('./run', () => ({ executeAgentRun: vi.fn() }));

import { enqueueWeldAgentJob, type WeldAgentJob } from './jobs';
import { loadAcceptedTurn } from './complete-turn';

const turn: WeldAgentJob = {
  kind: 'chat-turn',
  conversationId: 'conv_1',
  userId: 'usr_1',
  workspaceId: 'org_1',
  userMessageId: 'msg_1',
  agentId: 'agt_1',
};

describe('enqueueWeldAgentJob', () => {
  beforeEach(() => {
    vi.mocked(loadAcceptedTurn).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('uses one workflow instance per user turn', async () => {
    const create = vi.fn(async () => ({}));
    await enqueueWeldAgentJob({ WELDAGENT_JOB: { create, get: vi.fn() } } as never, undefined, turn, {} as never);
    expect(create).toHaveBeenCalledWith({ id: 'turn-msg_1', params: turn });
    expect(loadAcceptedTurn).not.toHaveBeenCalled();
  });

  it('does not run a retried turn inline when its instance already exists', async () => {
    const create = vi.fn(async () => {
      throw new Error('instance already exists');
    });
    const get = vi.fn(async () => ({ id: 'turn-msg_1' }));
    await enqueueWeldAgentJob({ WELDAGENT_JOB: { create, get } } as never, undefined, turn, {} as never);
    expect(get).toHaveBeenCalledWith('turn-msg_1');
    expect(loadAcceptedTurn).not.toHaveBeenCalled();
  });

  it('falls back to running inline when the workflow is unavailable', async () => {
    const create = vi.fn(async () => {
      throw new Error('binding error');
    });
    const get = vi.fn(async () => {
      throw new Error('not found');
    });
    await enqueueWeldAgentJob({ WELDAGENT_JOB: { create, get } } as never, undefined, turn, {} as never);
    expect(loadAcceptedTurn).toHaveBeenCalled();
  });
});
