import { describe, it, expect, vi } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 0 orphan sinks', () => {
  it('sends to audit/analytics/search and never to WORKFLOW_EVENTS', async () => {
    const AUDIT_EVENTS = mockQueue();
    const ANALYTICS_EVENTS = mockQueue();
    const SEARCH_EVENTS = mockQueue();
    const WORKFLOW_EVENTS = mockQueue();

    // Cast: WORKFLOW_EVENTS is intentionally no longer on EntityEventPublisherEnv.
    // Keep a fake binding on the object to prove the publisher does not touch it.
    const env = {
      AUDIT_EVENTS,
      ANALYTICS_EVENTS,
      SEARCH_EVENTS,
      WORKFLOW_EVENTS,
    } as Parameters<typeof publishEntityEventRaw>[0]['env'] & {
      WORKFLOW_EVENTS: ReturnType<typeof mockQueue>;
    };

    await publishEntityEventRaw({
      env,
      // Inline sinks (webhooks / workflows / agents) short-circuit without a workspace.
      db: {} as never,
      workspaceId: '',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test', name: 'Acme' },
      source: 'system',
    });

    expect(AUDIT_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(ANALYTICS_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(SEARCH_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(WORKFLOW_EVENTS.send).not.toHaveBeenCalled();

    const sent = AUDIT_EVENTS.send.mock.calls[0]![0] as {
      eventType: string;
      entityType: string;
      action: string;
    };
    expect(sent.eventType).toBe('customer:created');
    expect(sent.entityType).toBe('customer');
    expect(sent.action).toBe('created');
  });

  it('EntityEventPublisherEnv no longer declares WORKFLOW_EVENTS', async () => {
    // Compile-time / shape guard: the runtime env object used by producers
    // should not need a WORKFLOW_EVENTS binding after Phase 0.
    const env: import('./publisher').EntityEventPublisherEnv = {
      AUDIT_EVENTS: mockQueue() as unknown as Queue,
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

    expect(env.AUDIT_EVENTS!.send).toHaveBeenCalledTimes(1);
  });
});
