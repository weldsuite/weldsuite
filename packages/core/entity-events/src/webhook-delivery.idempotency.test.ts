import { describe, it, expect, vi, beforeEach } from 'vitest';

const hasExisting = vi.fn();
const insertValues = vi.fn(async () => undefined);
const selectFromWebhooks = vi.fn();

vi.mock('@weldsuite/db/schema', () => ({
  externalWebhooks: {
    id: 'external_webhooks.id',
    status: 'external_webhooks.status',
    deletedAt: 'external_webhooks.deleted_at',
    events: 'external_webhooks.events',
    totalDeliveries: 'external_webhooks.total_deliveries',
    totalFailures: 'external_webhooks.total_failures',
    consecutiveFailures: 'external_webhooks.consecutive_failures',
  },
  webhookDeliveries: {
    id: 'webhook_deliveries.id',
    webhookId: 'webhook_deliveries.webhook_id',
    eventId: 'webhook_deliveries.event_id',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    sql: actual.sql,
  };
});

// We test hasExistingWebhookDelivery + deliverWebhookEvent skip via a focused
// unit test that mocks the db chain rather than importing the full module's
// fetch path. Import after mocks.

describe('webhook delivery Phase 3 idempotency helpers', () => {
  beforeEach(() => {
    hasExisting.mockReset();
    insertValues.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('hasExistingWebhookDelivery returns true when a row exists', async () => {
    const { hasExistingWebhookDelivery } = await import('./webhook-delivery');

    const limit = vi.fn(async () => [{ id: 'whd_existing' }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    await expect(hasExistingWebhookDelivery(db, 'whk_1', 'evt_1')).resolves.toBe(true);
    expect(select).toHaveBeenCalled();
  });

  it('hasExistingWebhookDelivery returns false when no row exists', async () => {
    const { hasExistingWebhookDelivery } = await import('./webhook-delivery');

    const limit = vi.fn(async () => []);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as never;

    await expect(hasExistingWebhookDelivery(db, 'whk_1', 'evt_new')).resolves.toBe(false);
  });

  it('deliverWebhookEvent skips HTTP when a delivery row already exists', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const { deliverWebhookEvent } = await import('./webhook-delivery');

    // First select = hasExisting → row found
    const limit = vi.fn(async () => [{ id: 'whd_existing' }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const insert = vi.fn(() => ({
      values: vi.fn(async () => undefined),
    }));
    const db = { select, insert } as never;

    const result = await deliverWebhookEvent({
      db,
      webhook: {
        id: 'whk_1',
        url: 'https://example.com/hook',
        secret: 'sec',
        headers: null,
        consecutiveFailures: 0,
        status: 'active',
      } as never,
      eventId: 'evt_dup',
      eventType: 'customer.created',
      workspaceId: 'ws_1',
      data: { id: 'cus_1' },
    });

    expect(result.delivered).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
