import { describe, it, expect, vi, beforeEach } from 'vitest';

const findAgentsForEvent = vi.fn();
const createAgentRun = vi.fn(async () => 'run_1');
const executeAgentRun = vi.fn(async () => undefined);

vi.mock('./agents', () => ({
  findAgentsForEvent: (...args: unknown[]) => findAgentsForEvent(...args),
  createAgentRun: (...args: unknown[]) => createAgentRun(...args),
}));

vi.mock('./run', () => ({
  executeAgentRun: (...args: unknown[]) => executeAgentRun(...args),
}));

vi.mock('../../db', () => ({
  schema: {
    weldagentAgentRuns: {
      id: 'weldagent_agent_runs.id',
      agentId: 'weldagent_agent_runs.agent_id',
      triggerData: 'weldagent_agent_runs.trigger_data',
    },
  },
}));

import { dispatchWeldAgentsForEvent } from './dispatch';

function mockDb(existing: boolean) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (existing ? [{ id: 'run_existing' }] : [])),
        })),
      })),
    })),
  };
}

describe('dispatchWeldAgentsForEvent idempotency', () => {
  beforeEach(() => {
    findAgentsForEvent.mockReset();
    createAgentRun.mockClear();
    executeAgentRun.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('skips create/execute when a run already exists for eventId + agent', async () => {
    findAgentsForEvent.mockResolvedValueOnce([
      { id: 'agt_1', createdBy: 'usr_1' },
    ]);

    await dispatchWeldAgentsForEvent({} as never, mockDb(true) as never, {
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data: { id: 'cus_1' },
      eventId: 'evt_dup',
    });

    expect(createAgentRun).not.toHaveBeenCalled();
    expect(executeAgentRun).not.toHaveBeenCalled();
  });

  it('creates a run with eventId in triggerData on first delivery', async () => {
    findAgentsForEvent.mockResolvedValueOnce([
      { id: 'agt_1', createdBy: 'usr_1' },
    ]);

    await dispatchWeldAgentsForEvent({} as never, mockDb(false) as never, {
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data: { id: 'cus_1' },
      eventId: 'evt_new',
    });

    expect(createAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agt_1',
        triggerType: 'event',
        triggerData: expect.objectContaining({ eventId: 'evt_new' }),
      }),
    );
    expect(executeAgentRun).toHaveBeenCalled();
  });
});
