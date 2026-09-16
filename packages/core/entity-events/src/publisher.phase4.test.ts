import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEntityEventRaw } from './publisher';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 4 WeldConnect cutover', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does not call EXECUTE_WORKFLOW on the publish path', async () => {
    const ENTITY_EVENTS = mockQueue();
    const create = vi.fn(async () => undefined);

    await publishEntityEventRaw({
      env: {
        ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue,
        EXECUTE_WORKFLOW: { create },
      },
      db: {} as never,
      workspaceId: 'org_1',
      userId: 'user_test',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_test',
      data: { id: 'cus_test', name: 'Acme' },
    });

    expect(ENTITY_EVENTS.send).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});
