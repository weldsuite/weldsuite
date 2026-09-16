import { describe, it, expect, vi } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 0 orphan sinks', () => {
  it('never sends to WORKFLOW_EVENTS even when a fake binding is present', async () => {
    const ENTITY_EVENTS = mockQueue();
    const WORKFLOW_EVENTS = mockQueue();

    // Cast: WORKFLOW_EVENTS is intentionally no longer on EntityEventPublisherEnv.
    const env = {
      ENTITY_EVENTS,
      WORKFLOW_EVENTS,
    } as Parameters<typeof publishEntityEventRaw>[0]['env'] & {
      WORKFLOW_EVENTS: ReturnType<typeof mockQueue>;
    };

    await publishEntityEventRaw({
      env,
      db: {} as never,
      workspaceId: '',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test', name: 'Acme' },
      source: 'system',
    });

    expect(ENTITY_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(WORKFLOW_EVENTS.send).not.toHaveBeenCalled();

    const sent = ENTITY_EVENTS.send.mock.calls[0]![0] as {
      eventType: string;
      entityType: string;
      action: string;
    };
    expect(sent.eventType).toBe('customer:created');
    expect(sent.entityType).toBe('customer');
    expect(sent.action).toBe('created');
  });

  it('EntityEventPublisherEnv no longer declares WORKFLOW_EVENTS', async () => {
    const env: import('./publisher').EntityEventPublisherEnv = {
      ENTITY_EVENTS: mockQueue() as unknown as Queue,
    };
    expect('WORKFLOW_EVENTS' in env).toBe(false);

    await publishEntityEventRaw({
      env,
      db: {} as never,
      workspaceId: '',
      userId: 'user_test',
      entityType: 'customer',
      action: 'updated',
      entityId: 'cus_test',
      data: { id: 'cus_test' },
    });

    expect(env.ENTITY_EVENTS!.send).toHaveBeenCalledTimes(1);
  });
});
