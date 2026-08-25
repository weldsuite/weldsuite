import { describe, it, expect, vi } from 'vitest';
import {
  backoffUntil,
  ConnectorApiError,
  type ConnectorSyncIndexRow,
  type ConnectorSyncSettingKey,
} from '@weldsuite/connectors';
import { processConnectorCatchupRow, type ConnectorCatchupStore } from './connector-catchup';

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

function row(overrides: Partial<ConnectorSyncIndexRow> = {}): ConnectorSyncIndexRow {
  return {
    connection_id: 'conn_1',
    workspace_id: 'ws_1',
    clerk_org_id: 'org_1',
    provider: 'woocommerce',
    source_kind: 'connector',
    mode: 'webhook_catchup',
    enabled: 1,
    next_due_at: NOW - 1_000,
    interval_minutes: 360,
    encrypted_credentials: '{"consumerKey":"enc"}',
    watermarks: '{}',
    enabled_syncs: null,
    last_webhook_at: null,
    last_probe_at: null,
    last_ingest_at: null,
    last_error: null,
    backoff_until: null,
    reconcile_fingerprint: null,
    next_reconcile_at: NOW + 86_400_000,
    updated_at: NOW,
    ...overrides,
  };
}

function memoryStore(): ConnectorCatchupStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async markProbed(id) {
      calls.push(`probed:${id}`);
    },
    async markIngested(args) {
      calls.push(`ingested:${args.connectionId}`);
    },
    async markReconciled(id) {
      calls.push(`reconciled:${id}`);
    },
    async markBackoff(id, error) {
      calls.push(`backoff:${id}:${error}`);
    },
  };
}

describe('processConnectorCatchupRow', () => {
  it('does not call catch-up when the probe is empty', async () => {
    const store = memoryStore();
    const catchUp = vi.fn(async () => ({ ok: true, status: 200, watermarks: {} }));
    const outcome = await processConnectorCatchupRow(row(), {
      now: NOW,
      store,
      decryptCredentials: async () => ({ consumerKey: 'ck' }),
      probe: async () => ({ hasUpdates: false, resources: [] }),
      fingerprint: async () => ({ products: 1 }),
      catchUp,
    });
    expect(outcome).toBe('probed');
    expect(catchUp).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['probed:conn_1']);
  });

  it('calls catch-up once when the probe hits', async () => {
    const store = memoryStore();
    const catchUp = vi.fn(async () => ({
      ok: true,
      status: 200,
      watermarks: { WooProduct: '2026-08-24T12:00:00Z' },
    }));
    const outcome = await processConnectorCatchupRow(row(), {
      now: NOW,
      store,
      decryptCredentials: async () => ({ consumerKey: 'ck' }),
      probe: async () => ({ hasUpdates: true, resources: ['products'] as const }),
      fingerprint: async () => ({ products: 1 }),
      catchUp,
    });
    expect(outcome).toBe('ingested');
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual(['ingested:conn_1']);
  });

  it('skips catch-up when a webhook landed recently', async () => {
    const store = memoryStore();
    const catchUp = vi.fn(async () => ({ ok: true, status: 200, watermarks: {} }));
    const probe = vi.fn(
      async (): Promise<{ hasUpdates: boolean; resources: ConnectorSyncSettingKey[] }> => ({
        hasUpdates: true,
        resources: ['products'],
      }),
    );
    const outcome = await processConnectorCatchupRow(row({ last_webhook_at: NOW - 10 * 60_000 }), {
      now: NOW,
      store,
      decryptCredentials: async () => ({ consumerKey: 'ck' }),
      probe,
      fingerprint: async () => ({ products: 1 }),
      catchUp,
    });
    expect(outcome).toBe('skipped');
    expect(probe).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['probed:conn_1']);
  });

  it('backs off in D1 when the store returns an auth error', async () => {
    const store = memoryStore();
    const outcome = await processConnectorCatchupRow(row(), {
      now: NOW,
      store,
      decryptCredentials: async () => ({ consumerKey: 'ck' }),
      probe: async () => {
        throw new ConnectorApiError({ message: 'rejected', status: 401, kind: 'auth' });
      },
      fingerprint: async () => ({ products: 1 }),
      catchUp: async () => ({ ok: true, status: 200, watermarks: {} }),
    });
    expect(outcome).toBe('backed_off');
    expect(store.calls[0]).toMatch(/^backoff:conn_1:/);
    expect(backoffUntil('auth', NOW)).toBeGreaterThan(NOW);
  });

  it('backs off in D1 on rate-limit without opening the tenant', async () => {
    const store = memoryStore();
    const catchUp = vi.fn(async () => ({ ok: true, status: 200, watermarks: {} }));
    const outcome = await processConnectorCatchupRow(row(), {
      now: NOW,
      store,
      decryptCredentials: async () => ({ consumerKey: 'ck' }),
      probe: async () => {
        throw new ConnectorApiError({
          message: 'slow down',
          status: 429,
          kind: 'rate_limit',
          retryAfterSeconds: 30,
        });
      },
      fingerprint: async () => ({ products: 1 }),
      catchUp,
    });
    expect(outcome).toBe('backed_off');
    expect(catchUp).not.toHaveBeenCalled();
    expect(store.calls[0]).toMatch(/^backoff:conn_1:/);
    expect(backoffUntil('rate_limit', NOW, 30)).toBe(NOW + 30_000);
  });

  it('opens the tenant for reconcile only when remote counts drift', async () => {
    const store = memoryStore();
    const catchUp = vi.fn(async () => ({ ok: true, status: 200, watermarks: {} }));
    const outcome = await processConnectorCatchupRow(
      row({
        next_due_at: NOW + 60_000,
        next_reconcile_at: NOW - 1,
        last_webhook_at: NOW - 10 * 60_000,
        reconcile_fingerprint: JSON.stringify({ products: 4, orders: 2, customers: 1 }),
      }),
      {
        now: NOW,
        store,
        decryptCredentials: async () => ({ consumerKey: 'ck' }),
        probe: async () => ({ hasUpdates: true, resources: ['products'] as const }),
        fingerprint: async () => ({ products: 3, orders: 2, customers: 1 }),
        catchUp,
      },
    );
    expect(outcome).toBe('ingested');
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  it('does not ingest when reconcile counts match', async () => {
    const store = memoryStore();
    const catchUp = vi.fn(async () => ({ ok: true, status: 200, watermarks: {} }));
    const outcome = await processConnectorCatchupRow(
      row({
        next_due_at: NOW + 60_000,
        next_reconcile_at: NOW - 1,
        last_webhook_at: NOW - 10 * 60_000,
        reconcile_fingerprint: JSON.stringify({ products: 4 }),
      }),
      {
        now: NOW,
        store,
        decryptCredentials: async () => ({ consumerKey: 'ck' }),
        probe: async () => ({ hasUpdates: true, resources: ['products'] as const }),
        fingerprint: async () => ({ products: 4 }),
        catchUp,
      },
    );
    expect(outcome).toBe('probed');
    expect(catchUp).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['reconciled:conn_1']);
  });
});
