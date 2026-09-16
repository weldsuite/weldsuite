import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./agents', () => ({
  findAgentsForEvent: vi.fn(),
  createAgentRun: vi.fn(async () => 'run_1'),
}));

vi.mock('./run', () => ({
  executeAgentRun: vi.fn(async () => undefined),
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

import { findAgentsForEvent, createAgentRun } from './agents';
import { executeAgentRun } from './run';
import { dispatchWeldAgentsForEvent } from './dispatch';

const findAgents = vi.mocked(findAgentsForEvent);
const createRun = vi.mocked(createAgentRun);
const executeRun = vi.mocked(executeAgentRun);

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
    findAgents.mockReset();
    createRun.mockClear();
    executeRun.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('skips create/execute when a run already exists for eventId + agent', async () => {
    findAgents.mockResolvedValueOnce([{ id: 'agt_1', createdBy: 'usr_1' }] as never);

    await dispatchWeldAgentsForEvent({} as never, mockDb(true) as never, {
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data: { id: 'cus_1' },
      eventId: 'evt_dup',
    });

    expect(createRun).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('creates a run with eventId in triggerData on first delivery', async () => {
    findAgents.mockResolvedValueOnce([{ id: 'agt_1', createdBy: 'usr_1' }] as never);

    await dispatchWeldAgentsForEvent({} as never, mockDb(false) as never, {
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data: { id: 'cus_1' },
      eventId: 'evt_new',
    });

    expect(createRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agt_1',
        triggerType: 'event',
        triggerData: expect.objectContaining({ eventId: 'evt_new' }),
      }),
    );
    expect(executeRun).toHaveBeenCalled();
  });
});
