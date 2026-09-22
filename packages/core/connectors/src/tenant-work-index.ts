/**
 * D1 tenant_work_index — schedule per-workspace jobs (webhook retry, workflow poll)
 * without opening every tenant Neon on each cron tick.
 *
 * Idle workspaces must leave the index (`nextDueAt: null` / `enabled = 0`). A
 * perpetual 10-minute "pulse" that re-opens every Neon defeats autosuspend.
 * Re-enter only from write paths (failed webhook delivery, active poll trigger).
 */

export type TenantWorkKind = 'webhook_retry' | 'workflow_poll';

/** Cadence for workspaces that still have real poll/retry work. */
export const TENANT_WORK_INTERVAL_MS = 10 * 60_000;

/** Integration poll triggers that require the workflow_poll D1 pulse. */
export const WORKFLOW_POLL_TRIGGER_EVENTS = [
  { provider: 'google_sheets', event: 'google_sheets.new_row' },
  { provider: 'gmail', event: 'gmail.new_email' },
  { provider: 'google_calendar', event: 'google_calendar.new_event' },
  { provider: 'airtable', event: 'airtable.new_record' },
] as const;

/**
 * True when `triggers` JSON includes at least one enabled integration_event
 * that the integration-webhook-worker polls on a timer.
 */
export function triggersIncludeWorkflowPoll(triggers: unknown): boolean {
  if (!Array.isArray(triggers)) return false;
  for (const raw of triggers) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (t.isEnabled === false) continue;
    const cfg = (t.config && typeof t.config === 'object' ? t.config : {}) as Record<
      string,
      unknown
    >;
    const type = t.type ?? cfg.type;
    if (type !== 'integration_event') continue;
    const provider = String(t.provider ?? cfg.provider ?? '');
    const event = String(t.event ?? cfg.event ?? '');
    if (
      WORKFLOW_POLL_TRIGGER_EVENTS.some((p) => p.provider === provider && p.event === event)
    ) {
      return true;
    }
  }
  return false;
}

export interface TenantWorkIndexRow {
  id: string;
  workspace_id: string;
  clerk_org_id: string;
  kind: TenantWorkKind;
  enabled: number;
  next_due_at: number;
  metadata: string | null;
  last_run_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export interface TenantWorkIndexDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = TenantWorkIndexRow>(): Promise<{ results: T[] }>;
    };
  };
}

export interface UpsertTenantWorkIndexInput {
  workspaceId: string;
  clerkOrgId: string;
  kind: TenantWorkKind;
  enabled?: boolean;
  /** Epoch ms. Defaults to now (due immediately). */
  nextDueAt?: number;
  metadata?: Record<string, unknown> | null;
  now?: number;
}

function workId(workspaceId: string, kind: TenantWorkKind): string {
  return `${kind}:${workspaceId}`;
}

export async function upsertTenantWorkIndex(
  d1: TenantWorkIndexDb,
  input: UpsertTenantWorkIndexInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  const nextDueAt = input.nextDueAt ?? now;
  const enabled = input.enabled === false ? 0 : 1;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  const id = workId(input.workspaceId, input.kind);

  await d1
    .prepare(
      `INSERT INTO tenant_work_index (
         id, workspace_id, clerk_org_id, kind, enabled, next_due_at,
         metadata, last_run_at, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(workspace_id, kind) DO UPDATE SET
         clerk_org_id = excluded.clerk_org_id,
         enabled = excluded.enabled,
         next_due_at = MIN(tenant_work_index.next_due_at, excluded.next_due_at),
         metadata = COALESCE(excluded.metadata, tenant_work_index.metadata),
         updated_at = excluded.updated_at`,
    )
    .bind(id, input.workspaceId, input.clerkOrgId, input.kind, enabled, nextDueAt, metadata, now)
    .run();
}

export async function setTenantWorkIndexEnabled(
  d1: TenantWorkIndexDb,
  workspaceId: string,
  kind: TenantWorkKind,
  enabled: boolean,
  now = Date.now(),
): Promise<void> {
  await d1
    .prepare(
      `UPDATE tenant_work_index
       SET enabled = ?, updated_at = ?,
           next_due_at = CASE WHEN ? = 1 THEN ? ELSE next_due_at END
       WHERE workspace_id = ? AND kind = ?`,
    )
    .bind(enabled ? 1 : 0, now, enabled ? 1 : 0, now, workspaceId, kind)
    .run();
}

export async function deleteTenantWorkIndex(
  d1: TenantWorkIndexDb,
  workspaceId: string,
  kind: TenantWorkKind,
): Promise<void> {
  await d1
    .prepare(`DELETE FROM tenant_work_index WHERE workspace_id = ? AND kind = ?`)
    .bind(workspaceId, kind)
    .run();
}

export async function listDueTenantWorkIndex(
  d1: TenantWorkIndexDb,
  kind: TenantWorkKind,
  now = Date.now(),
  limit = 50,
): Promise<TenantWorkIndexRow[]> {
  const result = await d1
    .prepare(
      `SELECT * FROM tenant_work_index
       WHERE enabled = 1 AND kind = ? AND next_due_at <= ?
       ORDER BY next_due_at ASC
       LIMIT ?`,
    )
    .bind(kind, now, limit)
    .all<TenantWorkIndexRow>();
  return result.results ?? [];
}

export async function markTenantWorkIndexRan(
  d1: TenantWorkIndexDb,
  args: {
    workspaceId: string;
    kind: TenantWorkKind;
    /** Next due epoch ms. Pass null to disable until re-upserted. */
    nextDueAt: number | null;
    error?: string | null;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  if (args.nextDueAt == null) {
    await d1
      .prepare(
        `UPDATE tenant_work_index
         SET enabled = 0, last_run_at = ?, last_error = ?, updated_at = ?
         WHERE workspace_id = ? AND kind = ?`,
      )
      .bind(now, args.error ?? null, now, args.workspaceId, args.kind)
      .run();
    return;
  }
  await d1
    .prepare(
      `UPDATE tenant_work_index
       SET next_due_at = ?, last_run_at = ?, last_error = ?, enabled = 1, updated_at = ?
       WHERE workspace_id = ? AND kind = ?`,
    )
    .bind(args.nextDueAt, now, args.error ?? null, now, args.workspaceId, args.kind)
    .run();
}
