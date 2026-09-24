import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./agents', () => ({
  findAgentsForEvent: vi.fn(),
  createAgentRun: vi.fn(async () => 'run_1'),
}));

vi.mock('./parity', () => ({
  findEventRoutines: vi.fn(async () => []),
  createRoutineRun: vi.fn(async () => 'rrn_1'),
  markRoutineScheduled: vi.fn(async () => undefined),
}));

vi.mock('./jobs', () => ({
  enqueueWeldAgentJob: vi.fn(async () => undefined),
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
import { findEventRoutines } from './parity';
import { dispatchWeldAgentsForEvent } from './dispatch';

const findAgents = vi.mocked(findAgentsForEvent);
const createRun = vi.mocked(createAgentRun);
const findRoutines = vi.mocked(findEventRoutines);
const executeRun = vi.fn(async () => undefined);

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
    findRoutines.mockClear();
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
    }, executeRun);

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
    }, executeRun);

    expect(createRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agt_1',
        triggerType: 'event',
        triggerData: expect.objectContaining({ eventId: 'evt_new' }),
      }),
    );
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent-run', agentId: 'agt_1', runId: 'run_1' }),
    );
  });

  it('ignores events caused by an agent (no agent → event → agent loops)', async () => {
    findAgents.mockResolvedValue([{ id: 'agt_1', createdBy: 'usr_1' }] as never);

    await dispatchWeldAgentsForEvent({} as never, mockDb(false) as never, {
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'ticket',
      action: 'created',
      entityId: 'tkt_1',
      data: { id: 'tkt_1', triggeredByAgentId: 'agt_1' },
      eventId: 'evt_loop',
    }, executeRun);

    expect(findAgents).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('schedules event routines listening for the event key', async () => {
    findAgents.mockResolvedValue([] as never);
    findRoutines.mockResolvedValueOnce([
      { id: 'rtn_1', agentId: 'agt_2', name: 'Triage', instructions: 'Tag it', requireApproval: false, createdBy: 'usr_1' },
    ] as never);

    await dispatchWeldAgentsForEvent({} as never, mockDb(false) as never, {
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'ticket',
      action: 'created',
      entityId: 'tkt_1',
      data: { id: 'tkt_1' },
    }, executeRun);

    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent-run', agentId: 'agt_2', routineRunId: 'rrn_1' }),
    );
  });
});
