import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return {
    ...actual,
    runRegisteredWeldAgentDispatch: vi.fn(async () => undefined),
  };
});

vi.mock('../db', () => ({
  getTenantDbForWorkspace: vi.fn(async () => ({ mocked: true })),
}));

import { runRegisteredWeldAgentDispatch } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from '../db';
import { handleEntityAgentMessage, handleEntityAgentBatch } from './entity-agents-consumer';

const runDispatch = vi.mocked(runRegisteredWeldAgentDispatch);
const getTenantDb = vi.mocked(getTenantDbForWorkspace);

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
    runDispatch.mockClear();
    getTenantDb.mockClear();
    getTenantDb.mockResolvedValue({ mocked: true } as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolves tenant DB and dispatches with eventId for idempotency', async () => {
    const env = { AI: {} };
    await handleEntityAgentMessage(sampleEvent('evt_abc'), env as never);

    expect(getTenantDb).toHaveBeenCalledWith(env, 'org_1');
    expect(runDispatch).toHaveBeenCalledWith({
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
    expect(getTenantDb).not.toHaveBeenCalled();
    expect(runDispatch).not.toHaveBeenCalled();
  });
});

describe('handleEntityAgentBatch', () => {
  beforeEach(() => {
    runDispatch.mockClear();
    getTenantDb.mockReset();
    getTenantDb.mockResolvedValue({ mocked: true } as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('acks successful messages and retries failures', async () => {
    getTenantDb
      .mockResolvedValueOnce({ mocked: true } as never)
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
