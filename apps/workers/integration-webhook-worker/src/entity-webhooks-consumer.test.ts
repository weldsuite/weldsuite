import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';

const dispatchWebhookDeliveries = vi.fn(async () => undefined);
const getTenantDbForWorkspaceById = vi.fn(async () => ({ mocked: true }));

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return {
    ...actual,
    dispatchWebhookDeliveries: (...args: unknown[]) => dispatchWebhookDeliveries(...args),
  };
});

vi.mock('./db', () => ({
  getTenantDbForWorkspaceById: (...args: unknown[]) => getTenantDbForWorkspaceById(...args),
}));

import { handleEntityWebhookMessage, handleEntityWebhookBatch } from './entity-webhooks-consumer';

function sampleEvent(id = 'evt_1'): EntityEventMessage {
  return {
    id,
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { id: 'cus_1' },
    metadata: {
      workspaceId: 'ws_1',
      userId: 'usr_1',
      timestamp: '2026-03-15T12:00:00.000Z',
      source: 'api',
    },
  };
}

describe('handleEntityWebhookMessage', () => {
  beforeEach(() => {
    dispatchWebhookDeliveries.mockClear();
    getTenantDbForWorkspaceById.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolves tenant DB and dispatches with evt_ id and dotted event matching fields', async () => {
    await handleEntityWebhookMessage(sampleEvent('evt_abc'), {} as never);

    expect(getTenantDbForWorkspaceById).toHaveBeenCalledWith({}, 'ws_1');
    expect(dispatchWebhookDeliveries).toHaveBeenCalledWith({
      db: { mocked: true },
      workspaceId: 'ws_1',
      entityType: 'customer',
      action: 'created',
      eventId: 'evt_abc',
      data: { id: 'cus_1' },
    });
  });

  it('skips when workspaceId is missing', async () => {
    const event = sampleEvent();
    (event.metadata as { workspaceId: string }).workspaceId = '';
    await handleEntityWebhookMessage(event, {} as never);
    expect(getTenantDbForWorkspaceById).not.toHaveBeenCalled();
    expect(dispatchWebhookDeliveries).not.toHaveBeenCalled();
  });
});

describe('handleEntityWebhookBatch', () => {
  beforeEach(() => {
    dispatchWebhookDeliveries.mockClear();
    getTenantDbForWorkspaceById.mockReset();
    getTenantDbForWorkspaceById.mockResolvedValue({ mocked: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('acks successful messages and retries failures', async () => {
    getTenantDbForWorkspaceById
      .mockResolvedValueOnce({ mocked: true })
      .mockRejectedValueOnce(new Error('db down'));

    const ack1 = vi.fn();
    const retry1 = vi.fn();
    const ack2 = vi.fn();
    const retry2 = vi.fn();

    await handleEntityWebhookBatch(
      {
        queue: 'entity-webhooks-test',
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
