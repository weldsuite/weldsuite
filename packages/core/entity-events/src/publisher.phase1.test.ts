import { describe, it, expect, vi } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

/**
 * Phase 1 originally dual-wrote hub + legacy sinks. Phase 2 cut over to
 * hub-only for audit/analytics/search — these tests keep the Phase 1 file
 * name so prior CI references still resolve, but assert post-cutover behaviour.
 */
describe('publishEntityEventRaw Phase 2 hub cutover', () => {
  it('sends only to ENTITY_EVENTS when bound (no legacy audit/analytics/search)', async () => {
    const ENTITY_EVENTS = mockQueue();
    const AUDIT_EVENTS = mockQueue();
    const ANALYTICS_EVENTS = mockQueue();
    const SEARCH_EVENTS = mockQueue();

    // Legacy bindings may still exist on an old Env object during deploy race;
    // the publisher must not touch them after Phase 2 cutover.
    const env = {
      ENTITY_EVENTS,
      AUDIT_EVENTS,
      ANALYTICS_EVENTS,
      SEARCH_EVENTS,
    } as Parameters<typeof publishEntityEventRaw>[0]['env'] & {
      AUDIT_EVENTS: ReturnType<typeof mockQueue>;
      ANALYTICS_EVENTS: ReturnType<typeof mockQueue>;
      SEARCH_EVENTS: ReturnType<typeof mockQueue>;
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
    expect(AUDIT_EVENTS.send).not.toHaveBeenCalled();
    expect(ANALYTICS_EVENTS.send).not.toHaveBeenCalled();
    expect(SEARCH_EVENTS.send).not.toHaveBeenCalled();

    const hubMsg = ENTITY_EVENTS.send.mock.calls[0]![0] as { id: string; eventType: string };
    expect(hubMsg.id).toMatch(/^evt_/);
    expect(hubMsg.eventType).toBe('customer:created');
  });

  it('no-ops queue fan-out when ENTITY_EVENTS is not bound', async () => {
    const AUDIT_EVENTS = mockQueue();

    const env = {
      AUDIT_EVENTS,
    } as Parameters<typeof publishEntityEventRaw>[0]['env'] & {
      AUDIT_EVENTS: ReturnType<typeof mockQueue>;
    };

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

    expect(AUDIT_EVENTS.send).not.toHaveBeenCalled();
  });
});
