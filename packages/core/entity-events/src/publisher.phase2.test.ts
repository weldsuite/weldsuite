import { describe, it, expect, vi } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 2 cutover', () => {
  it('EntityEventPublisherEnv only declares ENTITY_EVENTS (+ workflow types)', () => {
    const env: import('./publisher').EntityEventPublisherEnv = {
      ENTITY_EVENTS: mockQueue() as unknown as Queue,
    };
    expect('AUDIT_EVENTS' in env).toBe(false);
    expect('ANALYTICS_EVENTS' in env).toBe(false);
    expect('SEARCH_EVENTS' in env).toBe(false);
    expect('REALTIME' in env).toBe(false);
    expect('ENTITY_EVENTS' in env).toBe(true);
  });

  it('preserves evt_ id on the hub message for subscriber idempotency', async () => {
    const ENTITY_EVENTS = mockQueue();

    await publishEntityEventRaw({
      env: { ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue },
      db: {} as never,
      workspaceId: '',
      userId: 'user_test',
      entityType: 'lead',
      action: 'created',
      entityId: 'lead_1',
      data: { id: 'lead_1' },
    });

    const msg = ENTITY_EVENTS.send.mock.calls[0]![0] as { id: string };
    expect(msg.id.startsWith('evt_')).toBe(true);
    expect(msg.id.length).toBeGreaterThan(4);
  });
});
