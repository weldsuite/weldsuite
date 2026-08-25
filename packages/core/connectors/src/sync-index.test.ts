import { describe, it, expect } from 'vitest';
import {
  deleteConnectorSyncIndex,
  listDueConnectorSyncIndex,
  setConnectorSyncIndexEnabled,
  upsertConnectorSyncIndex,
  type ConnectorSyncIndexDb,
  type ConnectorSyncIndexRow,
} from './sync-index';

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

class MemoryD1 implements ConnectorSyncIndexDb {
  rows = new Map<string, ConnectorSyncIndexRow>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          this.exec(normalized, values);
        },
        all: async <T = ConnectorSyncIndexRow>() => ({
          results: this.select(normalized, values) as T[],
        }),
      }),
    };
  }

  private exec(sql: string, values: unknown[]) {
    if (sql.startsWith('INSERT INTO connector_sync_index')) {
      const connectionId = String(values[0]);
      const nextDueAt = Number(values[6]);
      const existing = this.rows.get(connectionId);
      const row: ConnectorSyncIndexRow = {
        connection_id: connectionId,
        workspace_id: String(values[1]),
        clerk_org_id: String(values[2]),
        provider: String(values[3]),
        source_kind: 'connector',
        mode: values[4] as ConnectorSyncIndexRow['mode'],
        enabled: Number(values[5]),
        next_due_at: existing && existing.next_due_at > nextDueAt ? existing.next_due_at : nextDueAt,
        interval_minutes: Number(values[7]),
        encrypted_credentials: (values[8] as string | null) ?? null,
        watermarks: String(values[9]),
        enabled_syncs: (values[10] as string | null) ?? null,
        last_webhook_at: existing?.last_webhook_at ?? null,
        last_probe_at: existing?.last_probe_at ?? null,
        last_ingest_at: existing?.last_ingest_at ?? null,
        last_error: Number(values[5]) === 1 ? null : (existing?.last_error ?? null),
        backoff_until: Number(values[5]) === 1 ? null : (existing?.backoff_until ?? null),
        reconcile_fingerprint: existing?.reconcile_fingerprint ?? null,
        next_reconcile_at: existing?.next_reconcile_at ?? Number(values[11]),
        updated_at: Number(values[12]),
      };
      this.rows.set(connectionId, row);
      return;
    }
    if (sql.startsWith('UPDATE connector_sync_index SET enabled')) {
      const enabled = Number(values[0]);
      const now = Number(values[1]);
      const id = String(values[2]);
      const row = this.rows.get(id);
      if (!row) return;
      this.rows.set(id, {
        ...row,
        enabled,
        backoff_until: null,
        last_error: null,
        updated_at: now,
      });
      return;
    }
    if (sql.startsWith('DELETE FROM connector_sync_index')) {
      this.rows.delete(String(values[0]));
    }
  }

  private select(sql: string, values: unknown[]): ConnectorSyncIndexRow[] {
    if (!sql.startsWith('SELECT * FROM connector_sync_index')) return [];
    const now = Number(values[0]);
    const limit = Number(values[3] ?? 50);
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.enabled === 1 &&
          (row.backoff_until == null || row.backoff_until <= now) &&
          (row.next_due_at <= now || (row.next_reconcile_at != null && row.next_reconcile_at <= now)),
      )
      .sort((a, b) => a.next_due_at - b.next_due_at)
      .slice(0, limit);
  }
}

describe('connector_sync_index D1 helpers', () => {
  it('upserts a row on connect so the sweep can find it when due', async () => {
    const d1 = new MemoryD1();
    await upsertConnectorSyncIndex(d1, {
      connectionId: 'conn_1',
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      provider: 'woocommerce',
      enabled: true,
      encryptedCredentialsJson: '{"consumerKey":"enc"}',
      watermarks: { WooProduct: '2026-01-01T00:00:00Z' },
      enabledSyncs: ['products'],
      now: NOW,
    });
    const stored = d1.rows.get('conn_1');
    expect(stored?.enabled).toBe(1);
    expect(stored?.mode).toBe('webhook_catchup');
    expect(stored?.encrypted_credentials).toBe('{"consumerKey":"enc"}');
    expect(stored?.clerk_org_id).toBe('org_1');
    expect(JSON.parse(stored?.watermarks ?? '{}')).toEqual({ WooProduct: '2026-01-01T00:00:00Z' });
    expect(stored?.next_due_at).toBeGreaterThan(NOW);
    expect(await listDueConnectorSyncIndex(d1, NOW)).toEqual([]);
    expect(await listDueConnectorSyncIndex(d1, stored!.next_due_at)).toHaveLength(1);
  });

  it('disables the row on pause so it is not due', async () => {
    const d1 = new MemoryD1();
    await upsertConnectorSyncIndex(d1, {
      connectionId: 'conn_1',
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      provider: 'shopify',
      enabled: true,
      encryptedCredentialsJson: '{"accessToken":"enc"}',
      watermarks: {},
      enabledSyncs: null,
      now: NOW - 7 * 60 * 60_000,
    });
    await setConnectorSyncIndexEnabled(d1, 'conn_1', false, NOW);
    expect(d1.rows.get('conn_1')?.enabled).toBe(0);
    expect(await listDueConnectorSyncIndex(d1, NOW)).toEqual([]);
  });

  it('deletes the row on disconnect', async () => {
    const d1 = new MemoryD1();
    await upsertConnectorSyncIndex(d1, {
      connectionId: 'conn_1',
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      provider: 'woocommerce',
      enabled: true,
      encryptedCredentialsJson: '{"consumerKey":"enc"}',
      watermarks: {},
      enabledSyncs: null,
      now: NOW,
    });
    await deleteConnectorSyncIndex(d1, 'conn_1');
    expect(d1.rows.has('conn_1')).toBe(false);
  });
});
