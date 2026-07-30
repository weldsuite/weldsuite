import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_SYNCABLE_PROVIDERS,
  MIN_INTERVAL_HOURS,
  dueSyncRows,
  dueWatchRenewals,
  markSyncDispatched,
  parseWatchExpiry,
  removeSyncIndex,
  setSyncIndexEnabled,
  syncIndexRowId,
  syncUpsertSyncIndex,
  upsertSyncIndex,
  type SyncIndexD1,
  type SyncIndexRow,
} from './sync-index';

/**
 * These tests are about the SQL contract, not SQLite behaviour.
 *
 * What matters and is easy to get wrong: the due-row predicate has to treat a
 * never-run row as due, the upsert must not reset `next_run_at` on conflict, and
 * `markSyncDispatched` has to clamp the interval. Each of those has a specific
 * failure — a connection that never imports, a save that re-triggers a sync, or a
 * tenant configuring a 5-minute interval and hammering a provider.
 */

interface Recorded {
  query: string;
  values: unknown[];
}

function fakeD1(results: SyncIndexRow[] = []) {
  const calls: Recorded[] = [];
  const d1: SyncIndexD1 = {
    prepare(query: string) {
      const statement = {
        bind(...values: unknown[]) {
          return {
            async run() {
              calls.push({ query, values });
              return undefined;
            },
            async all<T>() {
              calls.push({ query, values });
              return { results: results as unknown as T[] };
            },
          };
        },
        async run() {
          calls.push({ query, values: [] });
          return undefined;
        },
        async all<T>() {
          calls.push({ query, values: [] });
          return { results: results as unknown as T[] };
        },
      };
      return statement;
    },
  };
  return { d1, calls };
}

function row(overrides: Partial<SyncIndexRow> = {}): SyncIndexRow {
  return {
    row_id: 'ccn_1:customer',
    workspace_id: 'org_1',
    engine: 'connector',
    connection_id: 'ccn_1',
    entity_type: 'customer',
    provider: 'moneybird',
    owner_id: 'user_1',
    interval_hours: 6,
    next_run_at: null,
    last_run_at: null,
    watch_expires_at: null,
    is_enabled: 1,
    updated_at: 0,
    ...overrides,
  };
}

describe('syncIndexRowId', () => {
  it('keys connector rows per entity type', () => {
    // Each entity is dispatched as its own queue message, so they need distinct
    // rows or one entity's dispatch would advance the other's timer.
    expect(syncIndexRowId('connector', 'ccn_1', 'customer')).toBe('ccn_1:customer');
    expect(syncIndexRowId('connector', 'ccn_1', 'invoice')).toBe('ccn_1:invoice');
  });

  it('keys legacy rows per connection', () => {
    // The legacy engine syncs a connection as a unit.
    expect(syncIndexRowId('legacy', 'intc_1')).toBe('intc_1');
    expect(syncIndexRowId('legacy', 'intc_1', 'customer')).toBe('intc_1');
  });
});

describe('upsertSyncIndex', () => {
  it('inserts with next_run_at NULL so a new connection syncs on the next tick', async () => {
    const { d1, calls } = fakeD1();
    await upsertSyncIndex(d1, {
      engine: 'connector',
      workspaceId: 'org_1',
      connectionId: 'ccn_1',
      entityType: 'customer',
      provider: 'moneybird',
      isEnabled: true,
    });

    const insert = calls[0];
    expect(insert?.query).toContain('INSERT INTO sync_index');
    expect(insert?.query).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)');
  });

  it('leaves next_run_at alone on conflict', async () => {
    // The regression this guards: re-saving a connection would otherwise make it
    // immediately due, so repeatedly editing it would hammer the provider.
    const { d1, calls } = fakeD1();
    await upsertSyncIndex(d1, {
      engine: 'connector',
      workspaceId: 'org_1',
      connectionId: 'ccn_1',
      entityType: 'customer',
      provider: 'moneybird',
      isEnabled: true,
    });

    const query = calls[0]?.query ?? '';
    expect(query).toContain('ON CONFLICT(row_id) DO UPDATE SET');
    expect(query).not.toMatch(/DO UPDATE SET[\s\S]*next_run_at/);
  });

  it('clamps the interval to the floor', async () => {
    const { d1, calls } = fakeD1();
    await upsertSyncIndex(d1, {
      engine: 'legacy',
      workspaceId: 'org_1',
      connectionId: 'intc_1',
      provider: 'hubspot',
      intervalHours: 0,
      isEnabled: true,
    });

    // interval_hours is the 8th bound value.
    expect(calls[0]?.values[7]).toBe(MIN_INTERVAL_HOURS);
  });

  it('defaults the interval when none is given', async () => {
    const { d1, calls } = fakeD1();
    await upsertSyncIndex(d1, {
      engine: 'legacy',
      workspaceId: 'org_1',
      connectionId: 'intc_1',
      provider: 'hubspot',
      isEnabled: true,
    });
    expect(calls[0]?.values[7]).toBe(6);
  });

  it('stores entity_type as NULL for legacy rows', async () => {
    const { d1, calls } = fakeD1();
    await upsertSyncIndex(d1, {
      engine: 'legacy',
      workspaceId: 'org_1',
      connectionId: 'intc_1',
      provider: 'attio',
      isEnabled: true,
    });
    expect(calls[0]?.values[4]).toBeNull();
  });
});

describe('dueSyncRows', () => {
  it('treats a never-run row as due', async () => {
    // `next_run_at IS NULL` is how a freshly connected integration imports without
    // waiting a full interval. Dropping it from the predicate would mean a new
    // connection silently does nothing until its first cycle elapses.
    const { d1, calls } = fakeD1([row()]);
    const rows = await dueSyncRows(d1, 1_000);

    expect(rows).toHaveLength(1);
    expect(calls[0]?.query).toContain('next_run_at IS NULL OR next_run_at <= ?');
  });

  it('only considers enabled rows', async () => {
    const { d1, calls } = fakeD1([]);
    await dueSyncRows(d1, 1_000);
    expect(calls[0]?.query).toContain('is_enabled = 1');
  });

  it('returns an empty array when D1 reports no results', async () => {
    const d1: SyncIndexD1 = {
      prepare: () => ({
        bind: () => ({ run: async () => undefined, all: async () => ({}) }),
        run: async () => undefined,
        all: async () => ({}),
      }),
    };
    expect(await dueSyncRows(d1, 0)).toEqual([]);
  });
});

describe('dueWatchRenewals', () => {
  it('looks ahead by the renewal buffer', async () => {
    // Renewing only once expired is too late — the channel is already dead and
    // inbound webhooks have stopped.
    const { d1, calls } = fakeD1([row({ watch_expires_at: 5_000 })]);
    await dueWatchRenewals(d1, 1_000, 10_000);

    expect(calls[0]?.values[0]).toBe(11_000);
    expect(calls[0]?.query).toContain('watch_expires_at IS NOT NULL');
  });

  it('ignores rows with no watch channel', async () => {
    const { d1, calls } = fakeD1([]);
    await dueWatchRenewals(d1, 0);
    // NULL means "no renewal applies", which is every non-Google row.
    expect(calls[0]?.query).toContain('watch_expires_at IS NOT NULL');
  });
});

describe('markSyncDispatched', () => {
  it('pushes next_run_at forward by the interval', async () => {
    const { d1, calls } = fakeD1();
    await markSyncDispatched(d1, 'ccn_1:customer', 6, 1_000);

    expect(calls[0]?.values[0]).toBe(1_000 + 6 * 60 * 60 * 1000);
    expect(calls[0]?.values[1]).toBe(1_000);
  });

  it('clamps a too-small interval', async () => {
    // Without this a tenant could set a 1-minute cadence and the sweep would
    // dispatch on every tick.
    const { d1, calls } = fakeD1();
    await markSyncDispatched(d1, 'r', 0, 0);
    expect(calls[0]?.values[0]).toBe(MIN_INTERVAL_HOURS * 60 * 60 * 1000);
  });
});

describe('setSyncIndexEnabled / removeSyncIndex', () => {
  it('disables every row for a connection without dropping them', async () => {
    // Pausing keeps the interval and last_run_at so resuming does not re-import
    // from scratch.
    const { d1, calls } = fakeD1();
    await setSyncIndexEnabled(d1, 'ccn_1', false);

    expect(calls[0]?.query).toContain('UPDATE sync_index SET is_enabled = ?');
    expect(calls[0]?.query).toContain('WHERE connection_id = ?');
    expect(calls[0]?.values[0]).toBe(0);
  });

  it('removes every row for a connection', async () => {
    const { d1, calls } = fakeD1();
    await removeSyncIndex(d1, 'ccn_1');
    expect(calls[0]?.query).toContain('DELETE FROM sync_index');
    expect(calls[0]?.values[0]).toBe('ccn_1');
  });
});

describe('best-effort wrappers', () => {
  it('no-ops when D1 is unbound', async () => {
    // Local dev and any env without the binding must still be able to connect an
    // integration; it just will not auto-sync until a rebuild.
    await expect(
      syncUpsertSyncIndex(undefined, {
        engine: 'connector',
        connectionId: 'ccn_1',
        provider: 'moneybird',
        isEnabled: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('no-ops when the workspace is unknown', async () => {
    // A row with no workspace id could never be dispatched — the sweep needs it to
    // resolve the tenant database.
    const { d1, calls } = fakeD1();
    await syncUpsertSyncIndex(
      { d1, workspaceId: undefined },
      { engine: 'connector', connectionId: 'ccn_1', provider: 'moneybird', isEnabled: true },
    );
    expect(calls).toHaveLength(0);
  });

  it('swallows a D1 failure rather than failing the caller’s save', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d1: SyncIndexD1 = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    };

    await expect(
      syncUpsertSyncIndex(
        { d1, workspaceId: 'org_1' },
        { engine: 'connector', connectionId: 'ccn_1', provider: 'moneybird', isEnabled: true },
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parseWatchExpiry', () => {
  it('reads the expiration out of Google watch JSON', () => {
    expect(parseWatchExpiry('{"id":"c1","expiration":"1790000000000"}')).toBe(1790000000000);
  });

  it('returns null for a plain HMAC secret', () => {
    // Every non-Google provider stores a bare secret in the same column, so this
    // is the normal case rather than an error.
    expect(parseWatchExpiry('a3f9c2e1b4d8')).toBeNull();
  });

  it('returns null for absent, empty or unparseable input', () => {
    expect(parseWatchExpiry(null)).toBeNull();
    expect(parseWatchExpiry(undefined)).toBeNull();
    expect(parseWatchExpiry('')).toBeNull();
    expect(parseWatchExpiry('{"id":"c1"}')).toBeNull();
    expect(parseWatchExpiry('{"expiration":"not-a-number"}')).toBeNull();
  });
});

describe('LEGACY_SYNCABLE_PROVIDERS', () => {
  it('covers the legacy engine’s sync providers', () => {
    for (const provider of ['attio', 'hubspot', 'salesforce', 'pipedrive', 'google_calendar']) {
      expect(LEGACY_SYNCABLE_PROVIDERS.has(provider)).toBe(true);
    }
  });

  it('excludes mcp_server', () => {
    // `integration_connections` also holds MCP server rows, which have no sync at
    // all — indexing them would put permanently-due rows in the table.
    expect(LEGACY_SYNCABLE_PROVIDERS.has('mcp_server')).toBe(false);
  });
});
