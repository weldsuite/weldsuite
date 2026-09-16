import { describe, it, expect, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { defineEntityEventSubscribers } from '@weldsuite/entity-events';
import { fanOutHubMessage } from './hub';

function mockQueue() {
  return { send: vi.fn(async () => undefined) };
}

function sampleMessage(eventType = 'customer:created'): EntityEventMessage {
  const [entityType, action] = eventType.split(':') as [string, string];
  return {
    id: 'evt_test01',
    eventType: eventType as `${string}:${string}`,
    entityType,
    entityId: 'cus_1',
    action,
    data: { id: 'cus_1' },
    metadata: {
      workspaceId: 'ws_1',
      userId: 'usr_1',
      timestamp: new Date().toISOString(),
      source: 'system',
    },
  };
}

describe('fanOutHubMessage', () => {
  it('enqueues to all matching Phase 1–3 subscribers and reports success', async () => {
    const SUB_AUDIT = mockQueue();
    const SUB_ANALYTICS = mockQueue();
    const SUB_SEARCH = mockQueue();
    const SUB_WEBHOOKS = mockQueue();
    const message = sampleMessage();

    const result = await fanOutHubMessage(message, {
      SUB_AUDIT,
      SUB_ANALYTICS,
      SUB_SEARCH,
      SUB_WEBHOOKS,
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded.sort()).toEqual(['analytics', 'audit', 'search-index', 'webhooks']);
    expect(SUB_AUDIT.send).toHaveBeenCalledWith(message);
    expect(SUB_ANALYTICS.send).toHaveBeenCalledWith(message);
    expect(SUB_SEARCH.send).toHaveBeenCalledWith(message);
    expect(SUB_WEBHOOKS.send).toHaveBeenCalledWith(message);
    // Same id preserved
    expect(SUB_WEBHOOKS.send.mock.calls[0]![0].id).toBe('evt_test01');
  });

  it('reports failure when one enqueue throws (caller should retry/not ack)', async () => {
    const SUB_AUDIT = mockQueue();
    const SUB_ANALYTICS = {
      send: vi.fn(async () => {
        throw new Error('analytics unavailable');
      }),
    };
    const SUB_SEARCH = mockQueue();
    const SUB_WEBHOOKS = mockQueue();

    const result = await fanOutHubMessage(sampleMessage(), {
      SUB_AUDIT,
      SUB_ANALYTICS,
      SUB_SEARCH,
      SUB_WEBHOOKS,
    });

    expect(result.succeeded.sort()).toEqual(['audit', 'search-index', 'webhooks']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('analytics');
  });

  it('fails a subscriber when its queue binding is missing', async () => {
    const SUB_AUDIT = mockQueue();
    // SUB_ANALYTICS + SUB_SEARCH + SUB_WEBHOOKS intentionally omitted

    const result = await fanOutHubMessage(sampleMessage(), { SUB_AUDIT });

    expect(result.succeeded).toEqual(['audit']);
    expect(result.failed.map((f) => f.id).sort()).toEqual([
      'analytics',
      'search-index',
      'webhooks',
    ]);
  });

  it('respects topic filters on a custom registry', async () => {
    const SUB_AUDIT = mockQueue();
    const SUB_ANALYTICS = mockQueue();
    const subscribers = defineEntityEventSubscribers([
      { id: 'orders', topics: ['order:*'], queueBinding: 'SUB_AUDIT' },
      { id: 'all', topics: ['*'], queueBinding: 'SUB_ANALYTICS' },
    ] as const);

    const orderResult = await fanOutHubMessage(
      sampleMessage('order:created'),
      { SUB_AUDIT, SUB_ANALYTICS },
      subscribers,
    );
    expect(orderResult.succeeded.sort()).toEqual(['all', 'orders']);

    const custResult = await fanOutHubMessage(
      sampleMessage('customer:created'),
      { SUB_AUDIT, SUB_ANALYTICS },
      subscribers,
    );
    expect(custResult.succeeded).toEqual(['all']);
    expect(SUB_AUDIT.send).toHaveBeenCalledTimes(1);
  });
});
