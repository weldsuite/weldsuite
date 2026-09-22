import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';

const dispatchWebhookDeliveries = vi.fn(async () => ({ matched: 0, failed: 0 }));
const resolveWorkspaceById = vi.fn(async () => ({
  clerkOrgId: 'org_1',
  db: { mocked: true },
}));
const resolveWorkspaceByClerkOrg = vi.fn(async () => ({
  id: 'ws_internal',
  db: { mocked: true },
}));
const upsertTenantWorkIndex = vi.fn(async () => undefined);

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return {
    ...actual,
    dispatchWebhookDeliveries: (...args: unknown[]) => dispatchWebhookDeliveries(...args),
  };
});

vi.mock('@weldsuite/connectors', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/connectors')>(
    '@weldsuite/connectors',
  );
  return {
    ...actual,
    upsertTenantWorkIndex: (...args: unknown[]) => upsertTenantWorkIndex(...args),
  };
});

vi.mock('./db', () => ({
  resolveWorkspaceById: (...args: unknown[]) => resolveWorkspaceById(...args),
  resolveWorkspaceByClerkOrg: (...args: unknown[]) => resolveWorkspaceByClerkOrg(...args),
}));

import { handleEntityWebhookMessage, handleEntityWebhookBatch } from './entity-webhooks-consumer';

function sampleEvent(id = 'evt_1', workspaceId = 'ws_1'): EntityEventMessage {
  return {
    id,
    eventType: 'customer:created',
    entityType: 'customer',
    entityId: 'cus_1',
    action: 'created',
    data: { id: 'cus_1' },
    metadata: {
      workspaceId,
      userId: 'usr_1',
      timestamp: '2026-03-15T12:00:00.000Z',
      source: 'api',
    },
  };
}

describe('handleEntityWebhookMessage', () => {
  beforeEach(() => {
    dispatchWebhookDeliveries.mockClear();
    dispatchWebhookDeliveries.mockResolvedValue({ matched: 0, failed: 0 });
    resolveWorkspaceById.mockClear();
    resolveWorkspaceByClerkOrg.mockClear();
    upsertTenantWorkIndex.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('resolves tenant DB by internal id and dispatches with dotted event fields', async () => {
    await handleEntityWebhookMessage(sampleEvent('evt_abc', 'ws_1'), {} as never);

    expect(resolveWorkspaceById).toHaveBeenCalledWith({}, 'ws_1');
    expect(dispatchWebhookDeliveries).toHaveBeenCalledWith({
      db: { mocked: true },
      workspaceId: 'org_1',
      entityType: 'customer',
      action: 'created',
      eventId: 'evt_abc',
      data: { id: 'cus_1' },
    });
    expect(upsertTenantWorkIndex).not.toHaveBeenCalled();
  });

  it('resolves Clerk org ids and schedules webhook_retry when a delivery fails', async () => {
    dispatchWebhookDeliveries.mockResolvedValueOnce({ matched: 1, failed: 1 });

    await handleEntityWebhookMessage(sampleEvent('evt_fail', 'org_abc'), {
      CONNECTOR_SYNC_INDEX: {},
    } as never);

    expect(resolveWorkspaceByClerkOrg).toHaveBeenCalledWith(
      expect.objectContaining({ CONNECTOR_SYNC_INDEX: {} }),
      'org_abc',
    );
    expect(upsertTenantWorkIndex).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: 'ws_internal',
        clerkOrgId: 'org_abc',
        kind: 'webhook_retry',
      }),
    );
  });

  it('skips when workspaceId is missing', async () => {
    const event = sampleEvent();
    (event.metadata as { workspaceId: string }).workspaceId = '';
    await handleEntityWebhookMessage(event, {} as never);
    expect(resolveWorkspaceById).not.toHaveBeenCalled();
    expect(dispatchWebhookDeliveries).not.toHaveBeenCalled();
  });
});

describe('handleEntityWebhookBatch', () => {
  beforeEach(() => {
    dispatchWebhookDeliveries.mockClear();
    dispatchWebhookDeliveries.mockResolvedValue({ matched: 0, failed: 0 });
    resolveWorkspaceById.mockReset();
    resolveWorkspaceById.mockResolvedValue({ clerkOrgId: 'org_1', db: { mocked: true } });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('acks successful messages and retries failures', async () => {
    resolveWorkspaceById
      .mockResolvedValueOnce({ clerkOrgId: 'org_1', db: { mocked: true } })
      .mockRejectedValueOnce(new Error('db down'));

    const ack1 = vi.fn();
    const retry1 = vi.fn();
    const ack2 = vi.fn();
    const retry2 = vi.fn();

    await handleEntityWebhookBatch(
      {
        queue: 'entity-webhooks-test',
        messages: [
          { body: sampleEvent('evt_ok'), ack: ack1, retry: retry1 },
          { body: sampleEvent('evt_fail'), ack: ack2, retry: retry2 },
        ],
      } as never,
      {} as never,
    );

    expect(ack1).toHaveBeenCalled();
    expect(retry1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();
    expect(retry2).toHaveBeenCalled();
  });
});
