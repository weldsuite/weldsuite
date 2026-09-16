import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';

const runRegisteredWeldAgentDispatch = vi.fn(async () => undefined);
const getTenantDbForWorkspace = vi.fn(async () => ({ mocked: true }));

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return {
    ...actual,
    runRegisteredWeldAgentDispatch: (...args: unknown[]) =>
      runRegisteredWeldAgentDispatch(...args),
  };
});

vi.mock('../db', () => ({
  getTenantDbForWorkspace: (...args: unknown[]) => getTenantDbForWorkspace(...args),
}));

import { handleEntityAgentMessage, handleEntityAgentBatch } from './entity-agents-consumer';

function sampleEvent(id = 'evt_1'): EntityEventMessage {
  return {
    id,
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { id: 'cus_1' },
    metadata: {
      workspaceId: 'org_1',
      userId: 'usr_1',
      timestamp: '2026-03-15T12:00:00.000Z',
      source: 'api',
    },
  };
}

describe('handleEntityAgentMessage', () => {
  beforeEach(() => {
    runRegisteredWeldAgentDispatch.mockClear();
    getTenantDbForWorkspace.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolves tenant DB and dispatches with eventId for idempotency', async () => {
    const env = { AI: {} };
    await handleEntityAgentMessage(sampleEvent('evt_abc'), env as never);

    expect(getTenantDbForWorkspace).toHaveBeenCalledWith(env, 'org_1');
    expect(runRegisteredWeldAgentDispatch).toHaveBeenCalledWith({
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data: { id: 'cus_1' },
      db: { mocked: true },
      env,
      eventId: 'evt_abc',
    });
  });

  it('skips when workspaceId is missing', async () => {
    const event = sampleEvent();
    (event.metadata as { workspaceId: string }).workspaceId = '';
    await handleEntityAgentMessage(event, {} as never);
    expect(getTenantDbForWorkspace).not.toHaveBeenCalled();
    expect(runRegisteredWeldAgentDispatch).not.toHaveBeenCalled();
  });
});

describe('handleEntityAgentBatch', () => {
  beforeEach(() => {
    runRegisteredWeldAgentDispatch.mockClear();
    getTenantDbForWorkspace.mockReset();
    getTenantDbForWorkspace.mockResolvedValue({ mocked: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('acks successful messages and retries failures', async () => {
    getTenantDbForWorkspace
      .mockResolvedValueOnce({ mocked: true })
      .mockRejectedValueOnce(new Error('db down'));

    const ack1 = vi.fn();
    const retry1 = vi.fn();
    const ack2 = vi.fn();
    const retry2 = vi.fn();

    await handleEntityAgentBatch(
      {
        queue: 'entity-agents-test',
        messages: [
          { body: sampleEvent('evt_ok'), ack: ack1, retry: retry1 },
          { body: sampleEvent('evt_fail'), ack: ack2, retry: retry2 },
        ],
      } as never,
      {} as never,
    );

    expect(ack1).toHaveBeenCalled();
    expect(retry1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();
    expect(retry2).toHaveBeenCalled();
  });
});
