import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 6 realtime cutover', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does not call REALTIME service binding on the publish path', async () => {
    const ENTITY_EVENTS = mockQueue();
    const realtimeFetch = vi.fn(async () => new Response('ok'));

    await publishEntityEventRaw({
      env: {
        ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue,
        // Extra binding may still exist on worker Env for chat/notifications;
        // publisher must not touch it for entity events after Phase 6.
        REALTIME: { fetch: realtimeFetch },
      } as never,
      db: {} as never,
      workspaceId: 'org_1',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test', name: 'Acme' },
      accessUserIds: ['usr_a'],
    });

    expect(ENTITY_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(realtimeFetch).not.toHaveBeenCalled();

    const msg = ENTITY_EVENTS.send.mock.calls[0]![0] as {
      accessUserIds?: string[];
      data: Record<string, unknown>;
    };
    expect(msg.accessUserIds).toEqual(['usr_a']);
    expect(msg.data._access).toBeUndefined();
  });

  it('omits accessUserIds from the hub message when not provided', async () => {
    const ENTITY_EVENTS = mockQueue();

    await publishEntityEventRaw({
      env: { ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue },
      db: {} as never,
      workspaceId: 'org_1',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test' },
    });

    const msg = ENTITY_EVENTS.send.mock.calls[0]![0] as { accessUserIds?: string[] };
    expect(msg.accessUserIds).toBeUndefined();
  });
});
