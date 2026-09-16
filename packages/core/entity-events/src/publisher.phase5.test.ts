import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEntityEventRaw } from './publisher';
import { registerWeldAgentEventRunner } from './agent-dispatch';

function mockQueue() {
  return {
    send: vi.fn(async () => undefined),
  };
}

describe('publishEntityEventRaw Phase 5 WeldAgent cutover', () => {
  beforeEach(() => {
    registerWeldAgentEventRunner(null);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does not invoke the registered WeldAgent runner on the publish path', async () => {
    const ENTITY_EVENTS = mockQueue();
    const runner = vi.fn(async () => undefined);
    registerWeldAgentEventRunner(runner);

    await publishEntityEventRaw({
      env: {
        ENTITY_EVENTS: ENTITY_EVENTS as unknown as Queue,
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
    expect(runner).not.toHaveBeenCalled();
  });
});
