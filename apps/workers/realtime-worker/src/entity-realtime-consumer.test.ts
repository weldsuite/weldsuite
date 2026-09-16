import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import {
  handleEntityRealtimeMessage,
  handleEntityRealtimeBatch,
  publishEntityEventToWorkspaceHub,
} from './entity-realtime-consumer';

function sampleEvent(overrides: Partial<EntityEventMessage> = {}): EntityEventMessage {
  return {
    id: 'evt_1',
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { id: 'cus_1', name: 'Acme' },
    metadata: {
      workspaceId: 'org_1',
      userId: 'usr_1',
      timestamp: '2026-03-15T12:00:00.000Z',
      source: 'api',
    },
    ...overrides,
  };
}

function mockHubEnv(fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const stubFetch =
    fetchImpl ??
    vi.fn(async () => new Response('ok', { status: 200 }));
  return {
    WORKSPACE_HUB: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({
        fetch: stubFetch,
      })),
    },
    stubFetch,
  };
}

describe('publishEntityEventToWorkspaceHub', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('publishes to WorkspaceHub with entityType/action and pristine data', async () => {
    const { WORKSPACE_HUB, stubFetch } = mockHubEnv();
    await publishEntityEventToWorkspaceHub({ WORKSPACE_HUB } as never, sampleEvent());

    expect(WORKSPACE_HUB.idFromName).toHaveBeenCalledWith('org_1');
    expect(stubFetch).toHaveBeenCalledTimes(1);
    const [, init] = (stubFetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      topic: 'customer',
      event: 'created',
      data: { id: 'cus_1', name: 'Acme' },
      userId: 'usr_1',
    });
  });

  it('stitches _access.userIds when accessUserIds is set (project_member filter)', async () => {
    const { WORKSPACE_HUB, stubFetch } = mockHubEnv();
    await publishEntityEventToWorkspaceHub(
      { WORKSPACE_HUB } as never,
      sampleEvent({
        entityType: 'project_member',
        action: 'added',
        eventType: 'project_member:added',
        accessUserIds: ['usr_a', 'usr_b'],
        data: { id: 'pm_1' },
      }),
    );

    const [, init] = (stubFetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.data).toEqual({
      id: 'pm_1',
      _access: { userIds: ['usr_a', 'usr_b'] },
    });
  });

  it('skips when workspaceId is missing', async () => {
    const { WORKSPACE_HUB, stubFetch } = mockHubEnv();
    await publishEntityEventToWorkspaceHub(
      { WORKSPACE_HUB } as never,
      sampleEvent({
        metadata: {
          workspaceId: '',
          userId: 'usr_1',
          timestamp: '2026-03-15T12:00:00.000Z',
          source: 'api',
        },
      }),
    );
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it('throws when WorkspaceHub returns non-OK so the queue can retry', async () => {
    const { WORKSPACE_HUB } = mockHubEnv(async () => new Response('boom', { status: 500 }));
    await expect(
      publishEntityEventToWorkspaceHub({ WORKSPACE_HUB } as never, sampleEvent()),
    ).rejects.toThrow(/WorkspaceHub publish failed 500/);
  });
});

describe('handleEntityRealtimeBatch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('acks successful messages and retries failures', async () => {
    const stubFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('fail', { status: 503 }));
    const env = {
      WORKSPACE_HUB: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: stubFetch })),
      },
    };

    const ack1 = vi.fn();
    const retry1 = vi.fn();
    const ack2 = vi.fn();
    const retry2 = vi.fn();

    await handleEntityRealtimeBatch(
      {
        queue: 'entity-realtime-test',
        messages: [
          { body: sampleEvent({ id: 'evt_ok' }), ack: ack1, retry: retry1 },
          { body: sampleEvent({ id: 'evt_fail' }), ack: ack2, retry: retry2 },
        ],
      } as never,
      env as never,
    );

    expect(ack1).toHaveBeenCalled();
    expect(retry1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();
    expect(retry2).toHaveBeenCalled();
  });
});

describe('handleEntityRealtimeMessage', () => {
  it('delegates to WorkspaceHub publish', async () => {
    const { WORKSPACE_HUB, stubFetch } = mockHubEnv();
    await handleEntityRealtimeMessage(sampleEvent(), { WORKSPACE_HUB } as never);
    expect(stubFetch).toHaveBeenCalled();
  });
});
