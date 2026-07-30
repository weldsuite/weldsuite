/**
 * D1 sync index — the always-on timing layer for integration and connector syncs.
 *
 * **Why this exists.** The sweep used to load every workspace from the master DB
 * and open every tenant's Neon database on every tick, just to ask whether
 * anything was due. A tenant with no integrations at all was still woken 48 times
 * a day. Neon's idle timeout is 5 minutes, so a 30-minute cron does not *pin* a
 * database awake — but it does pay a cold start and a query per tenant per tick
 * forever. This table holds the timing so the sweep reads one always-on store and
 * a tenant DB is opened only when there is real work to do.
 *
 * `schedule_index` in workflow-worker solved the same problem for scheduled
 * workflow triggers first; this is deliberately the same shape.
 *
 * **Why it lives here rather than being copied per worker.** `schedule_index` is
 * duplicated between workflow-worker and app-api because those two share no
 * package. app-api and integration-sync-worker both already depend on
 * `@weldsuite/connectors`, so there is a real home and no copy to keep in step.
 *
 * **Source of truth.** The tenant row stays authoritative for configuration and
 * history; this index is authoritative only for *when to fire*. That split is
 * what makes drift safe: a stale row causes at worst one needless dispatch, which
 * the queue consumer already acks and discards when the connection is gone or
 * paused. A missing row is repaired by the rebuild backfill.
 *
 * Every write is best-effort. A D1 hiccup must never fail a tenant's save — the
 * index self-heals from the rebuild endpoint.
 */

/** Which dispatch path a row takes. */
export type SyncIndexEngine =
  /** WeldConnect connector — enqueued onto the connector-sync queue. */
  | 'connector'
  /** Legacy integration engine — dispatched via app-api's internal /sync route. */
  | 'legacy';

/** One row of the `sync_index` D1 table (SQLite: booleans/timestamps as INTEGER). */
export interface SyncIndexRow {
  row_id: string;
  workspace_id: string;
  engine: SyncIndexEngine;
  connection_id: string;
  entity_type: string | null;
  provider: string;
  owner_id: string | null;
  interval_hours: number;
  next_run_at: number | null;
  last_run_at: number | null;
  watch_expires_at: number | null;
  is_enabled: number;
  updated_at: number;
}

/** Minimal D1 surface used here, so callers need no Workers types at the boundary. */
export interface SyncIndexD1 {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T>(): Promise<{ results?: T[] }>;
    };
    run(): Promise<unknown>;
    all<T>(): Promise<{ results?: T[] }>;
  };
}

/** Floor on how often we will hit a provider, whatever a tenant configures. */
export const MIN_INTERVAL_HOURS = 1;

/**
 * Legacy-engine providers the scheduler can auto-sync.
 *
 * Exported so the sweep and app-api's write side agree: a provider indexed here
 * but absent from the sweep's filter would sit permanently due and never fire,
 * and the reverse would never be indexed at all. `integration_connections` also
 * holds `mcp_server` rows, which have no sync at all.
 */
export const LEGACY_SYNCABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'attio',
  'hubspot',
  'salesforce',
  'pipedrive',
  'google_calendar',
]);

/**
 * Google Calendar stashes its watch-channel JSON in `webhookSecret`.
 *
 * Returns the channel expiry as epoch ms, or null when the column holds something
 * else — several providers use it for a plain HMAC secret, so a parse failure is
 * expected rather than exceptional.
 */
export function parseWatchExpiry(webhookSecret: string | null | undefined): number | null {
  if (!webhookSecret) return null;
  try {
    const watch = JSON.parse(webhookSecret) as { expiration?: string | number };
    const parsed = watch.expiration === undefined ? NaN : Number(watch.expiration);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Composite key.
 *
 * Connector rows are per entity type because each is dispatched as its own queue
 * message; legacy rows are one per connection because the legacy engine syncs a
 * connection as a unit.
 */
export function syncIndexRowId(
  engine: SyncIndexEngine,
  connectionId: string,
  entityType?: string | null,
): string {
  return engine === 'connector' && entityType ? `${connectionId}:${entityType}` : connectionId;
}

export interface UpsertSyncIndexInput {
  engine: SyncIndexEngine;
  workspaceId: string;
  connectionId: string;
  entityType?: string | null;
  provider: string;
  ownerId?: string | null;
  intervalHours?: number | null;
  /** Google Calendar watch expiry, epoch ms. Legacy google_calendar only. */
  watchExpiresAt?: number | null;
  isEnabled: boolean;
}

/**
 * Upsert a row, leaving `next_run_at` alone on conflict.
 *
 * Preserving it matters: a connection edited mid-cycle must not become due
 * immediately, or repeatedly saving a connection would hammer the provider. A
 * genuinely new row gets `next_run_at = NULL`, which the sweep reads as "due
 * now" so a freshly connected integration imports without waiting a full cycle.
 */
export async function upsertSyncIndex(
  d1: SyncIndexD1,
  input: UpsertSyncIndexInput,
): Promise<void> {
  const rowId = syncIndexRowId(input.engine, input.connectionId, input.entityType);
  const interval = Math.max(input.intervalHours ?? 6, MIN_INTERVAL_HOURS);

  await d1
    .prepare(
      `INSERT INTO sync_index
         (row_id, workspace_id, engine, connection_id, entity_type, provider, owner_id,
          interval_hours, next_run_at, last_run_at, watch_expires_at, is_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
       ON CONFLICT(row_id) DO UPDATE SET
         workspace_id     = excluded.workspace_id,
         engine           = excluded.engine,
         connection_id    = excluded.connection_id,
         entity_type      = excluded.entity_type,
         provider         = excluded.provider,
         owner_id         = excluded.owner_id,
         interval_hours   = excluded.interval_hours,
         watch_expires_at = excluded.watch_expires_at,
         is_enabled       = excluded.is_enabled,
         updated_at       = excluded.updated_at`,
    )
    .bind(
      rowId,
      input.workspaceId,
      input.engine,
      input.connectionId,
      input.entityType ?? null,
      input.provider,
      input.ownerId ?? null,
      interval,
      input.watchExpiresAt ?? null,
      input.isEnabled ? 1 : 0,
      Date.now(),
    )
    .run();
}

/**
 * Flip every row for a connection on or off.
 *
 * Disabling rather than deleting on pause keeps `last_run_at` and the interval, so
 * resuming does not re-import from scratch or lose the tenant's cadence.
 */
export async function setSyncIndexEnabled(
  d1: SyncIndexD1,
  connectionId: string,
  isEnabled: boolean,
): Promise<void> {
  await d1
    .prepare(`UPDATE sync_index SET is_enabled = ?, updated_at = ? WHERE connection_id = ?`)
    .bind(isEnabled ? 1 : 0, Date.now(), connectionId)
    .run();
}

/** Drop every row for a connection — on disconnect or delete. */
export async function removeSyncIndex(d1: SyncIndexD1, connectionId: string): Promise<void> {
  await d1
    .prepare(`DELETE FROM sync_index WHERE connection_id = ?`)
    .bind(connectionId)
    .run();
}

/** Rows due to sync. `next_run_at IS NULL` means never run, so due immediately. */
export async function dueSyncRows(d1: SyncIndexD1, now: number): Promise<SyncIndexRow[]> {
  const res = await d1
    .prepare(
      `SELECT * FROM sync_index
        WHERE is_enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY next_run_at ASC`,
    )
    .bind(now)
    .all<SyncIndexRow>();
  return res.results ?? [];
}

/**
 * Legacy Google Calendar rows whose watch channel needs renewing.
 *
 * Renewed 24 hours before expiry: a lapsed channel stops inbound calendar
 * webhooks silently, and the tenant only finds out when events stop appearing.
 */
export async function dueWatchRenewals(
  d1: SyncIndexD1,
  now: number,
  bufferMs = 24 * 60 * 60 * 1000,
): Promise<SyncIndexRow[]> {
  const res = await d1
    .prepare(
      `SELECT * FROM sync_index
        WHERE is_enabled = 1 AND watch_expires_at IS NOT NULL AND watch_expires_at <= ?
        ORDER BY watch_expires_at ASC`,
    )
    .bind(now + bufferMs)
    .all<SyncIndexRow>();
  return res.results ?? [];
}

/**
 * Move a row's next run forward.
 *
 * Called at **dispatch** time, not on completion. Two reasons: the sweep does not
 * wait for the sync (connector rows go onto a queue), and a sync that keeps
 * failing must not stay permanently due — that would re-dispatch it every tick
 * and hammer a provider that is already unhappy.
 */
export async function markSyncDispatched(
  d1: SyncIndexD1,
  rowId: string,
  intervalHours: number,
  now: number,
): Promise<void> {
  const interval = Math.max(intervalHours, MIN_INTERVAL_HOURS);
  await d1
    .prepare(
      `UPDATE sync_index SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE row_id = ?`,
    )
    .bind(now + interval * 60 * 60 * 1000, now, now, rowId)
    .run();
}

/** Record a renewed watch channel's new expiry. */
export async function markWatchRenewed(
  d1: SyncIndexD1,
  rowId: string,
  watchExpiresAt: number | null,
): Promise<void> {
  await d1
    .prepare(`UPDATE sync_index SET watch_expires_at = ?, updated_at = ? WHERE row_id = ?`)
    .bind(watchExpiresAt, Date.now(), rowId)
    .run();
}

// ============================================================================
// Best-effort wrappers for the app-api write path
// ============================================================================

/**
 * The write side, as app-api uses it: never throws, never blocks a save.
 *
 * A connection saved without its index row simply will not auto-sync until the
 * next rebuild — recoverable. A save that fails because D1 was briefly unhappy is
 * a broken feature the tenant sees immediately.
 */
export interface SyncIndexSync {
  d1?: SyncIndexD1;
  workspaceId?: string;
}

export async function syncUpsertSyncIndex(
  sync: SyncIndexSync | undefined,
  input: Omit<UpsertSyncIndexInput, 'workspaceId'>,
): Promise<void> {
  if (!sync?.d1 || !sync.workspaceId) return;
  try {
    await upsertSyncIndex(sync.d1, { ...input, workspaceId: sync.workspaceId });
  } catch (err) {
    console.warn(`[sync-index] upsert failed for ${input.connectionId}:`, err);
  }
}

export async function syncSetSyncIndexEnabled(
  sync: SyncIndexSync | undefined,
  connectionId: string,
  isEnabled: boolean,
): Promise<void> {
  if (!sync?.d1) return;
  try {
    await setSyncIndexEnabled(sync.d1, connectionId, isEnabled);
  } catch (err) {
    console.warn(`[sync-index] enable(${isEnabled}) failed for ${connectionId}:`, err);
  }
}

export async function syncRemoveSyncIndex(
  sync: SyncIndexSync | undefined,
  connectionId: string,
): Promise<void> {
  if (!sync?.d1) return;
  try {
    await removeSyncIndex(sync.d1, connectionId);
  } catch (err) {
    console.warn(`[sync-index] remove failed for ${connectionId}:`, err);
  }
}
