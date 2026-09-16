import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 7 hub collapse', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('EntityEventPublisherEnv only declares ENTITY_EVENTS', () => {
    const env: import('./publisher').EntityEventPublisherEnv = {
      ENTITY_EVENTS: mockQueue() as unknown as Queue,
    };
    expect(Object.keys(env).sort()).toEqual(['ENTITY_EVENTS']);
    expect('EXECUTE_WORKFLOW' in env).toBe(false);
    expect('REALTIME' in env).toBe(false);
    expect('AUDIT_EVENTS' in env).toBe(false);
    expect('WORKFLOW_EVENTS' in env).toBe(false);
  });

  it('sends only to ENTITY_EVENTS (ignores leftover legacy bindings)', async () => {
    const ENTITY_EVENTS = mockQueue();
    const AUDIT_EVENTS = mockQueue();
    const WORKFLOW_EVENTS = mockQueue();
    const realtimeFetch = vi.fn(async () => new Response('ok'));
    const create = vi.fn(async () => undefined);

    await publishEntityEventRaw({
      env: {
        ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue,
        AUDIT_EVENTS,
        WORKFLOW_EVENTS,
        REALTIME: { fetch: realtimeFetch },
        EXECUTE_WORKFLOW: { create },
      } as never,
      workspaceId: 'org_1',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test' },
    });

    expect(ENTITY_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(AUDIT_EVENTS.send).not.toHaveBeenCalled();
    expect(WORKFLOW_EVENTS.send).not.toHaveBeenCalled();
    expect(realtimeFetch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    const msg = ENTITY_EVENTS.send.mock.calls[0]![0] as { id: string; eventType: string };
    expect(msg.id).toMatch(/^evt_/);
    expect(msg.eventType).toBe('customer:created');
  });

  it('warns and no-ops when ENTITY_EVENTS is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await publishEntityEventRaw({
      env: {},
      workspaceId: 'org_1',
      userId: 'user_test',
      entityType: 'customer',
      action: 'updated',
      entityId: 'cus_test',
      data: { id: 'cus_test' },
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('No ENTITY_EVENTS binding available'),
    );
  });
});
