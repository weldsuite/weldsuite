import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 3 webhook cutover', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does not call dispatchWebhookDeliveries on the publish path', async () => {
    const ENTITY_EVENTS = mockQueue();
    // Provide a workspaceId so the old inline path would have run.
    const db = {
      select: vi.fn(() => {
        throw new Error('publisher must not touch tenant DB for webhooks after Phase 3');
      }),
    };

    await publishEntityEventRaw({
      env: { ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue },
      db: db as never,
      workspaceId: 'ws_1',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test', name: 'Acme' },
    });

    expect(ENTITY_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
  });
});
