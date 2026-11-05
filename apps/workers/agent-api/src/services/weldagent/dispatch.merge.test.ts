import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@weldsuite/agent-domain/agents', () => ({
  findAgentsForEvent: vi.fn(async () => []),
  createAgentRun: vi.fn(async () => 'run_1'),
  getAgent: vi.fn(),
}));

vi.mock('@weldsuite/agent-domain/parity', () => ({
  findEventRoutines: vi.fn(async () => []),
  hasRoutineRunForTrigger: vi.fn(async () => false),
  createRoutineRun: vi.fn(async () => 'rrn_1'),
  markRoutineScheduled: vi.fn(async () => undefined),
}));

vi.mock('@weldsuite/agent-domain/jobs', () => ({
  enqueueWeldAgentJob: vi.fn(async () => undefined),
}));

vi.mock('@weldsuite/worker-kit/db', () => ({
  schema: {
    weldagentAgentRuns: {
      id: 'weldagent_agent_runs.id',
      agentId: 'weldagent_agent_runs.agent_id',
      triggerData: 'weldagent_agent_runs.trigger_data',
    },
  },
}));

import { createAgentRun, getAgent } from '@weldsuite/agent-domain/agents';
import { dispatchWeldAgentsForEvent } from './dispatch';

const getAgentMock = vi.mocked(getAgent);
const createRun = vi.mocked(createAgentRun);
const schedule = vi.fn(async (_job: unknown) => undefined);

const noExistingRun = {
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })) })),
};

const assigned = (data: Record<string, unknown>) => ({
  workspaceId: 'org_1',
  userId: 'user_member',
  entityType: 'merge_issue',
  action: 'agent_assigned',
  entityId: 'mis_1',
  data: { id: 'mis_1', key: 'PLAT-209', title: 'Tabs flicker', agentId: 'agt_1', ...data },
  eventId: 'evt_1',
});

describe('merge_issue.agent_assigned dispatch', () => {
  beforeEach(() => {
    getAgentMock.mockReset();
    createRun.mockClear();
    schedule.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('runs the assigned agent with the issue as its task, as the member who assigned it', async () => {
    getAgentMock.mockResolvedValueOnce({ id: 'agt_1', status: 'active', createdBy: 'user_owner' } as never);
    await dispatchWeldAgentsForEvent({} as never, noExistingRun as never, assigned({}), schedule);

    expect(createRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: 'agt_1', triggerType: 'event' }));
    expect(schedule).toHaveBeenCalledTimes(1);
    const job = schedule.mock.calls[0]![0] as Record<string, unknown>;
    expect(job).toMatchObject({ kind: 'agent-run', agentId: 'agt_1', actorUserId: 'user_member', runId: 'run_1', triggerType: 'event' });
    expect(String(job.userMessage)).toContain('PLAT-209');
    expect(String(job.userMessage)).toContain('merge_get_issue');
    expect(job.triggerData).toMatchObject({ eventKey: 'merge_issue.agent_assigned', entityId: 'mis_1', eventId: 'evt_1' });
  });

  it('ignores a paused or missing agent, and an event an agent caused', async () => {
    getAgentMock.mockResolvedValueOnce({ id: 'agt_1', status: 'paused' } as never);
    await dispatchWeldAgentsForEvent({} as never, noExistingRun as never, assigned({}), schedule);
    getAgentMock.mockResolvedValueOnce(null);
    await dispatchWeldAgentsForEvent({} as never, noExistingRun as never, assigned({}), schedule);
    await dispatchWeldAgentsForEvent({} as never, noExistingRun as never, assigned({ triggeredByAgentId: 'agt_2' }), schedule);
    expect(schedule).not.toHaveBeenCalled();
  });
});
