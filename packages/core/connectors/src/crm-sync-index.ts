/**
 * D1 crm_sync_index — schedule CRM OAuth connections without scanning tenants.
 *
 * Tokens stay on the tenant row. The sync worker only reads due rows here, then
 * calls app-api (which opens that one Neon). Quiet ticks touch D1 only.
 */

export interface CrmSyncIndexRow {
  connection_id: string;
  workspace_id: string;
  clerk_org_id: string;
  provider: string;
  enabled: number;
  next_due_at: number;
  interval_minutes: number;
  renew_watch_at: number | null;
  last_triggered_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export interface CrmSyncIndexDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = CrmSyncIndexRow>(): Promise<{ results: T[] }>;
    };
  };
}

export interface UpsertCrmSyncIndexInput {
  connectionId: string;
  workspaceId: string;
  clerkOrgId: string;
  provider: string;
  enabled: boolean;
  intervalMinutes?: number;
  renewWatchAt?: number | null;
  /** When true, schedule immediately (initial connect). */
  dueNow?: boolean;
  now?: number;
}

export const DEFAULT_CRM_INTERVAL_MINUTES = 6 * 60;
export const MIN_CRM_INTERVAL_MINUTES = 60;

export function normalizeCrmIntervalMinutes(hours?: number | null): number {
  const h = typeof hours === 'number' && Number.isFinite(hours) ? hours : DEFAULT_CRM_INTERVAL_MINUTES / 60;
  return Math.max(MIN_CRM_INTERVAL_MINUTES, Math.round(h * 60));
}

export async function upsertCrmSyncIndex(
  d1: CrmSyncIndexDb,
  input: UpsertCrmSyncIndexInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  const intervalMinutes = input.intervalMinutes ?? DEFAULT_CRM_INTERVAL_MINUTES;
  const nextDue = input.dueNow ? now : now + intervalMinutes * 60_000;
  const renewWatchAt = input.renewWatchAt === undefined ? null : input.renewWatchAt;

  await d1
    .prepare(
      `INSERT INTO crm_sync_index (
         connection_id, workspace_id, clerk_org_id, provider, enabled,
         next_due_at, interval_minutes, renew_watch_at, last_triggered_at,
         last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         clerk_org_id = excluded.clerk_org_id,
         provider = excluded.provider,
         enabled = excluded.enabled,
         interval_minutes = excluded.interval_minutes,
         renew_watch_at = COALESCE(excluded.renew_watch_at, crm_sync_index.renew_watch_at),
         next_due_at = CASE
           WHEN excluded.enabled = 0 THEN crm_sync_index.next_due_at
           WHEN ? = 1 THEN excluded.next_due_at
           ELSE crm_sync_index.next_due_at
         END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.connectionId,
      input.workspaceId,
      input.clerkOrgId,
      input.provider,
      input.enabled ? 1 : 0,
      nextDue,
      intervalMinutes,
      renewWatchAt,
      now,
      input.dueNow ? 1 : 0,
    )
    .run();
}

export async function setCrmSyncIndexEnabled(
  d1: CrmSyncIndexDb,
  connectionId: string,
  enabled: boolean,
  now = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `UPDATE crm_sync_index
       SET enabled = ?, updated_at = ?,
           next_due_at = CASE WHEN ? = 1 THEN ? ELSE next_due_at END
       WHERE connection_id = ?`,
    )
    .bind(enabled ? 1 : 0, now, enabled ? 1 : 0, now, connectionId)
    .run();
}

export async function deleteCrmSyncIndex(d1: CrmSyncIndexDb, connectionId: string): Promise<void> {
  await d1.prepare(`DELETE FROM crm_sync_index WHERE connection_id = ?`).bind(connectionId).run();
}

export async function listDueCrmSyncIndex(
  d1: CrmSyncIndexDb,
  now = Date.now(),
  limit = 50,
): Promise<CrmSyncIndexRow[]> {
  const result = await d1
    .prepare(
      `SELECT * FROM crm_sync_index
       WHERE enabled = 1 AND next_due_at <= ?
       ORDER BY next_due_at ASC
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<CrmSyncIndexRow>();
  return result.results ?? [];
}

export async function markCrmSyncIndexTriggered(
  d1: CrmSyncIndexDb,
  args: {
    connectionId: string;
    intervalMinutes: number;
    renewWatchAt?: number | null;
    error?: string | null;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  await d1
    .prepare(
      `UPDATE crm_sync_index
       SET next_due_at = ?,
           last_triggered_at = ?,
           last_error = ?,
           renew_watch_at = COALESCE(?, renew_watch_at),
           updated_at = ?
       WHERE connection_id = ?`,
    )
    .bind(
      now + args.intervalMinutes * 60_000,
      now,
      args.error ?? null,
      args.renewWatchAt ?? null,
      now,
      args.connectionId,
    )
    .run();
}
