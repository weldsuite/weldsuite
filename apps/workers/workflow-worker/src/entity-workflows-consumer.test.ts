import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';

const matchAndDispatchWorkflowTriggers = vi.fn(async () => undefined);
const getTenantDbForWorkspace = vi.fn(async () => ({ mocked: true }));

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return {
    ...actual,
    matchAndDispatchWorkflowTriggers: (...args: unknown[]) =>
      matchAndDispatchWorkflowTriggers(...args),
  };
});

vi.mock('./db', () => ({
  getTenantDbForWorkspace: (...args: unknown[]) => getTenantDbForWorkspace(...args),
}));

import { handleEntityWorkflowMessage, handleEntityWorkflowBatch } from './entity-workflows-consumer';

function sampleEvent(id = 'evt_1'): EntityEventMessage {
  return {
    id,
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { id: 'cus_1' },
    changes: { status: { old: 'a', new: 'b' } },
    metadata: {
      workspaceId: 'org_1',
      userId: 'usr_1',
      timestamp: '2026-03-15T12:00:00.000Z',
      source: 'api',
    },
  };
}

describe('handleEntityWorkflowMessage', () => {
  beforeEach(() => {
    matchAndDispatchWorkflowTriggers.mockClear();
    getTenantDbForWorkspace.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolves tenant DB and dispatches with eventId for idempotency', async () => {
    const env = { EXECUTE_WORKFLOW: { create: vi.fn() } };
    await handleEntityWorkflowMessage(sampleEvent('evt_abc'), env as never);

    expect(getTenantDbForWorkspace).toHaveBeenCalledWith(env, 'org_1');
    expect(matchAndDispatchWorkflowTriggers).toHaveBeenCalledWith({
      env,
      db: { mocked: true },
      workspaceId: 'org_1',
      userId: 'usr_1',
      entityType: 'customer',
      entityId: 'cus_1',
      action: 'created',
      data: { id: 'cus_1' },
      changes: { status: { old: 'a', new: 'b' } },
      eventId: 'evt_abc',
    });
  });

  it('skips when workspaceId is missing', async () => {
    const event = sampleEvent();
    (event.metadata as { workspaceId: string }).workspaceId = '';
    await handleEntityWorkflowMessage(event, { EXECUTE_WORKFLOW: { create: vi.fn() } } as never);
    expect(getTenantDbForWorkspace).not.toHaveBeenCalled();
    expect(matchAndDispatchWorkflowTriggers).not.toHaveBeenCalled();
  });

  it('skips when EXECUTE_WORKFLOW is missing', async () => {
    await handleEntityWorkflowMessage(sampleEvent(), {} as never);
    expect(getTenantDbForWorkspace).not.toHaveBeenCalled();
    expect(matchAndDispatchWorkflowTriggers).not.toHaveBeenCalled();
  });
});

describe('handleEntityWorkflowBatch', () => {
  beforeEach(() => {
    matchAndDispatchWorkflowTriggers.mockClear();
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
    const env = { EXECUTE_WORKFLOW: { create: vi.fn() } };

    await handleEntityWorkflowBatch(
      {
        queue: 'entity-workflows-test',
        messages: [
          { body: sampleEvent('evt_ok'), ack: ack1, retry: retry1 },
          { body: sampleEvent('evt_fail'), ack: ack2, retry: retry2 },
        ],
      } as never,
      env as never,
    );

    expect(ack1).toHaveBeenCalled();
    expect(retry1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();
    expect(retry2).toHaveBeenCalled();
  });
});
