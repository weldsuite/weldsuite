/**
 * D1 workspace due index (`workspace_due_index`) — keeps the *timing* of
 * per-workspace sweeps in the always-on schedule-index D1 database
 * (SCHEDULE_INDEX), so a cron sweep opens only the tenant Neon DBs that have
 * work due instead of every tenant on every tick (AGENTS.md: "Never
 * periodically wake tenant databases"). Table DDL:
 * apps/workers/workflow-worker/migrations/d1/0004_workspace_due_index.sql.
 *
 * The tenant DB stays the source of truth; a row only says "look at this
 * workspace at or after next_due_at". Two kinds of writer:
 *
 * - Write paths (a route that snoozes a mail, schedules a task, buys a domain)
 *   call `markWorkspaceDue`, which can only pull the due time earlier. Calling
 *   it too often costs one extra tenant visit; it can never hide work.
 * - The sweep (`runDueIndexSweep`) does the work, re-derives when the
 *   workspace next has work and stores exactly that — guarded by the row's
 *   `version`, so a write that lands while the tenant is being processed is
 *   never overwritten (the row simply stays due and is re-derived next tick).
 *
 * Writes from request paths are best-effort: a D1 hiccup logs and never fails
 * the user's action. Reads in the sweep throw, and the sweep skips the tick —
 * never fall back to a tenant fan-out.
 */

export type DueIndexKind = 'mail_snooze' | 'calendar_replan' | 'domain_renew';

/** A due row as listed by the sweep; `version` is the compare-and-set token. */
export interface DueIndexRow {
  workspaceId: string;
  nextDueAt: number;
  version: number;
}

type Time = Date | number;

function toMs(time: Time): number {
  return time instanceof Date ? time.getTime() : time;
}

/** Statements per D1 batch when seeding — keeps each batch small and quick. */
const MARK_BATCH_SIZE = 50;

function markStatement(d1: D1Database, kind: DueIndexKind, workspaceId: string, at: number, now: number) {
  return d1
    .prepare(
      `INSERT INTO workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(kind, workspace_id) DO UPDATE SET
         next_due_at = MIN(workspace_due_index.next_due_at, excluded.next_due_at),
         updated_at  = excluded.updated_at,
         version     = workspace_due_index.version + 1`,
    )
    .bind(kind, workspaceId, at, now);
}

/**
 * Make sure the sweep looks at this workspace no later than `at` (default:
 * the next tick). Never pushes an existing due time later. Best-effort.
 */
export async function markWorkspaceDue(
  d1: D1Database | undefined,
  kind: DueIndexKind,
  workspaceId: string | null | undefined,
  at: Time = Date.now(),
): Promise<void> {
  if (!d1 || !workspaceId) return;
  try {
    await markStatement(d1, kind, workspaceId, toMs(at), Date.now()).run();
  } catch (err) {
    console.warn(`[due-index] mark ${kind} for ${workspaceId} failed:`, err);
  }
}

/**
 * `markWorkspaceDue` with the time derived from the tenant, for write paths
 * that have the tenant open anyway and can't tell the due time from their own
 * inputs. `derive` runs only when there is an index to write; `null` (nothing
 * due) leaves the row alone. Best-effort, like `markWorkspaceDue`.
 */
export async function syncWorkspaceDue(
  d1: D1Database | undefined,
  kind: DueIndexKind,
  workspaceId: string | null | undefined,
  derive: () => Promise<Time | null>,
): Promise<void> {
  if (!d1 || !workspaceId) return;
  try {
    const next = await derive();
    if (next != null) await markStatement(d1, kind, workspaceId, toMs(next), Date.now()).run();
  } catch (err) {
    console.warn(`[due-index] sync ${kind} for ${workspaceId} failed:`, err);
  }
}

/** `markWorkspaceDue` for many workspaces at once (the sweep's one-time seed). Throws. */
export async function markWorkspacesDue(
  d1: D1Database,
  kind: DueIndexKind,
  workspaceIds: string[],
  at: Time = Date.now(),
): Promise<void> {
  const dueAt = toMs(at);
  const now = Date.now();
  for (let i = 0; i < workspaceIds.length; i += MARK_BATCH_SIZE) {
    const chunk = workspaceIds.slice(i, i + MARK_BATCH_SIZE);
    await d1.batch(chunk.map((id) => markStatement(d1, kind, id, dueAt, now)));
  }
}

/** Workspaces whose `kind` work is due at `asOf`, earliest first. Throws when D1 fails. */
export async function listDueWorkspaces(
  d1: D1Database,
  kind: DueIndexKind,
  asOf: number,
  limit: number,
): Promise<DueIndexRow[]> {
  const result = await d1
    .prepare(
      `SELECT workspace_id, next_due_at, version FROM workspace_due_index
       WHERE kind = ? AND next_due_at <= ?
       ORDER BY next_due_at ASC
       LIMIT ?`,
    )
    .bind(kind, asOf, limit)
    .all<{ workspace_id: string; next_due_at: number; version: number }>();
  return (result.results ?? []).map((r) => ({
    workspaceId: r.workspace_id,
    nextDueAt: r.next_due_at,
    version: r.version,
  }));
}

/**
 * Store the re-derived due time of a listed row (`null`: nothing left, drop
 * the row) — unless a write path touched the row since it was listed, in
 * which case it is left due and re-derived on the next tick. Returns whether
 * the write applied.
 */
export async function settleWorkspaceDue(
  d1: D1Database,
  kind: DueIndexKind,
  row: DueIndexRow,
  next: Time | null,
): Promise<boolean> {
  const statement =
    next == null
      ? d1
          .prepare('DELETE FROM workspace_due_index WHERE kind = ? AND workspace_id = ? AND version = ?')
          .bind(kind, row.workspaceId, row.version)
      : d1
          .prepare(
            `UPDATE workspace_due_index
             SET next_due_at = ?, updated_at = ?, version = version + 1
             WHERE kind = ? AND workspace_id = ? AND version = ?`,
          )
          .bind(toMs(next), Date.now(), kind, row.workspaceId, row.version);
  const result = await statement.run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface DueIndexSweepOptions {
  d1: D1Database | undefined;
  /** Holds the one-time seed flag. */
  kv: KVNamespace;
  kind: DueIndexKind;
  /** Log prefix, e.g. `[SnoozeSweep]`. */
  label: string;
  /**
   * One-time seed when the index is introduced: every workspace that may
   * already have this kind of work is marked due once, so the regular sweep
   * visits each of them (in `limit`-sized ticks) and stores its real due time.
   * `key` is the KV flag; bump its version to seed again.
   */
  seed: { key: string; listWorkspaces: () => Promise<string[]> };
  /**
   * Do the due work for one workspace and return when it next has work
   * (`null`: none). Thrown errors are logged and the row is retried.
   */
  process: (workspaceId: string, now: Date) => Promise<Time | null>;
  /** After a failed `process`, retry no sooner than this. Default: next tick. */
  retryAfterMs?: number;
  /** Checked before each workspace; true ends the tick (e.g. a per-sweep cap). */
  shouldStop?: () => boolean;
  /** Workspaces per tick. Unprocessed due rows stay due for the next tick. */
  limit?: number;
  now?: number;
}

export interface DueIndexSweepResult {
  /** Due rows listed this tick. */
  due: number;
  processed: number;
  failed: number;
  /** Workspaces seeded this tick (0 once the seed flag is set). */
  seeded: number;
}

/**
 * Run one tick of a due-index sweep: seed once, list due rows from D1, process
 * each due workspace and store when it is next due. Never opens a tenant that
 * isn't listed, and never falls back to a fan-out when D1 is unavailable.
 */
export async function runDueIndexSweep(opts: DueIndexSweepOptions): Promise<DueIndexSweepResult> {
  const result: DueIndexSweepResult = { due: 0, processed: 0, failed: 0, seeded: 0 };
  const { d1, kind, label } = opts;
  if (!d1) {
    console.warn(`${label} SCHEDULE_INDEX binding missing; skipping sweep`);
    return result;
  }

  const now = opts.now ?? Date.now();

  if (!(await opts.kv.get(opts.seed.key))) {
    try {
      const ids = await opts.seed.listWorkspaces();
      await markWorkspacesDue(d1, kind, ids, now);
      await opts.kv.put(opts.seed.key, new Date(now).toISOString());
      result.seeded = ids.length;
      console.log(`${label} seeded ${ids.length} workspace(s) into the due index (one-time)`);
    } catch (err) {
      console.error(`${label} seeding the due index failed; skipping tick:`, err);
      return result;
    }
  }

  let rows: DueIndexRow[];
  try {
    rows = await listDueWorkspaces(d1, kind, now, opts.limit ?? 200);
  } catch (err) {
    // Deliberately no fallback to a tenant fan-out: skip this tick instead.
    console.error(`${label} D1 due index unavailable; skipping tick:`, err);
    return result;
  }
  result.due = rows.length;

  for (const row of rows) {
    if (opts.shouldStop?.()) break;
    try {
      const next = await opts.process(row.workspaceId, new Date(now));
      result.processed += 1;
      await settleWorkspaceDue(d1, kind, row, next);
    } catch (err) {
      result.failed += 1;
      console.error(`${label} workspace ${row.workspaceId} failed:`, err);
      if (opts.retryAfterMs) {
        await settleWorkspaceDue(d1, kind, row, now + opts.retryAfterMs).catch((settleErr) => {
          console.warn(`${label} could not back off workspace ${row.workspaceId}:`, settleErr);
        });
      }
    }
  }

  return result;
}
