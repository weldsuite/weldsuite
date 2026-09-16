import { describe, it, expect, vi } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 1 hub dual-write', () => {
  it('sends to ENTITY_EVENTS hub in addition to legacy sinks when bound', async () => {
    const ENTITY_EVENTS = mockQueue();
    const AUDIT_EVENTS = mockQueue();
    const ANALYTICS_EVENTS = mockQueue();
    const SEARCH_EVENTS = mockQueue();

    await publishEntityEventRaw({
      env: {
        ENTITY_EVENTS,
        AUDIT_EVENTS,
        ANALYTICS_EVENTS,
        SEARCH_EVENTS,
      },
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
    expect(AUDIT_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(ANALYTICS_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(SEARCH_EVENTS.send).toHaveBeenCalledTimes(1);

    const hubMsg = ENTITY_EVENTS.send.mock.calls[0]![0] as { id: string; eventType: string };
    const auditMsg = AUDIT_EVENTS.send.mock.calls[0]![0] as { id: string; eventType: string };
    expect(hubMsg.id).toBe(auditMsg.id);
    expect(hubMsg.eventType).toBe('customer:created');
  });

  it('still works when ENTITY_EVENTS is not bound (legacy-only)', async () => {
    const AUDIT_EVENTS = mockQueue();

    await publishEntityEventRaw({
      env: { AUDIT_EVENTS },
      db: {} as never,
      workspaceId: '',
      userId: 'user_test',
      entityType: 'customer',
      action: 'updated',
      entityId: 'cus_test',
      data: { id: 'cus_test' },
    });

    expect(AUDIT_EVENTS.send).toHaveBeenCalledTimes(1);
  });
});
