/**
 * D1 index of calendar replan timing (`calendar_replan_index`).
 *
 * The daily calendar replan sweep used to open every tenant Neon DB just to
 * find auto-scheduled events whose start slipped into the past. The index
 * keeps, per workspace, the earliest start time of an auto-scheduled event
 * that the replan would pick up once it is in the past, in the always-on
 * schedule-index D1 database (SCHEDULE_INDEX). The sweep opens only tenants
 * whose time has come.
 *
 * The tenant DB stays the source of truth. Every write re-derives the
 * workspace's row from calendar_events + tasks, so a missed or failed write is
 * repaired by the next one, and the sweep re-indexes every workspace it opens.
 * All writes are best-effort: a D1 hiccup logs and never fails the user's save.
 * Table DDL: workflow-worker/migrations/d1/0003_calendar_replan_index.sql.
 *
 * Only app-api writes auto-scheduled events (task create / update / status /
 * delete, and the calendar-events routes), so those two routers carry
 * `calendarReplanIndexMiddleware()`.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { schema } from '../db';
import type { Env, Variables } from '../types';

type TenantDb = Variables['tenantDb'];
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export interface CalendarReplanIndexSync {
  d1?: D1Database;
  workspaceId?: string;
}

export function calendarReplanIndexSync(
  env: Pick<Env, 'SCHEDULE_INDEX'> | undefined,
  workspaceId: string | undefined,
): CalendarReplanIndexSync {
  return { d1: env?.SCHEDULE_INDEX, workspaceId };
}

/**
 * Earliest start of an event the replan would reschedule once it is past:
 * auto-scheduled, confirmed, undeleted, on an undeleted task that isn't done
 * or cancelled. Mirrors replanStaleAutoScheduledEvents in
 * @weldsuite/db/lib/calendar-sync. Null when there is none.
 */
export async function computeCalendarReplanDueAt(db: TenantDb): Promise<Date | null> {
  const { calendarEvents, tasks } = schema;
  const [row] = await db
    .select({
      dueAt: sql<Date | null>`min(${calendarEvents.startTime})`.mapWith(calendarEvents.startTime),
    })
    .from(calendarEvents)
    .innerJoin(tasks, eq(calendarEvents.sourceId, tasks.id))
    .where(
      and(
        isNull(calendarEvents.deletedAt),
        eq(calendarEvents.autoScheduled, true),
        eq(calendarEvents.status, 'confirmed'),
        isNull(tasks.deletedAt),
        notInArray(tasks.status, ['done', 'cancelled']),
      ),
    );
  return row?.dueAt ?? null;
}

/** Store (or clear, when null) a workspace's next due time. Throws on failure. */
export async function writeCalendarReplanIndex(
  d1: D1Database,
  workspaceId: string,
  dueAt: Date | null,
): Promise<void> {
  if (!dueAt) {
    await d1.prepare('DELETE FROM calendar_replan_index WHERE workspace_id = ?').bind(workspaceId).run();
    return;
  }
  await d1
    .prepare(
      `INSERT INTO calendar_replan_index (workspace_id, next_due_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         next_due_at = excluded.next_due_at,
         updated_at  = excluded.updated_at`,
    )
    .bind(workspaceId, dueAt.getTime(), Date.now())
    .run();
}

/** Re-derive a workspace's index row from its tenant DB. Best-effort: false on failure. */
export async function reindexWorkspaceCalendarReplan(
  sync: CalendarReplanIndexSync | undefined,
  db: TenantDb,
): Promise<boolean> {
  if (!sync?.d1 || !sync.workspaceId) return false;
  try {
    await writeCalendarReplanIndex(sync.d1, sync.workspaceId, await computeCalendarReplanDueAt(db));
    return true;
  } catch (err) {
    console.warn(`[calendar-replan-index] reindex workspace ${sync.workspaceId} failed:`, err);
    return false;
  }
}

/** Workspaces with an event to replan at `asOf`. Throws when D1 is unreachable or the table is missing. */
export async function listWorkspacesWithDueCalendarReplan(
  d1: D1Database,
  asOf: number,
  limit = 500,
): Promise<string[]> {
  const result = await d1
    .prepare('SELECT workspace_id FROM calendar_replan_index WHERE next_due_at <= ? ORDER BY next_due_at LIMIT ?')
    .bind(asOf, limit)
    .all<{ workspace_id: string }>();
  return (result.results ?? []).map((r) => r.workspace_id);
}

// ── Request glue ─────────────────────────────────────────────────────────

/** Calendar writes a request started, keyed by the raw request. */
const pendingCalendarWrites = new WeakMap<Request, Promise<unknown>[]>();

/**
 * Record that this request changed (or is changing, via `work`) auto-scheduled
 * calendar state. Background `work` is handed to waitUntil, and the index
 * refresh in `calendarReplanIndexMiddleware` waits for it to settle so it
 * never reads the pre-write state. Pass `work` already `.catch`-ed.
 */
export function trackCalendarWrite(c: AppContext, work?: Promise<unknown>): void {
  const writes = pendingCalendarWrites.get(c.req.raw) ?? [];
  if (work) {
    writes.push(work);
    c.executionCtx.waitUntil(work);
  }
  pendingCalendarWrites.set(c.req.raw, writes);
}

/**
 * After a successful request, refresh the workspace's replan index row in the
 * background. By default only requests that called `trackCalendarWrite`
 * refresh; `everyWrite` refreshes after any successful non-GET request.
 */
export function calendarReplanIndexMiddleware(
  options: { everyWrite?: boolean } = {},
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    await next();
    const writes = pendingCalendarWrites.get(c.req.raw);
    pendingCalendarWrites.delete(c.req.raw);
    if (c.res.status >= 400) return;
    const isWrite = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (!writes && !(options.everyWrite && isWrite)) return;

    const db = c.get('tenantDb');
    if (!db) return;
    const sync = calendarReplanIndexSync(c.env, c.get('workspaceId'));
    c.executionCtx.waitUntil(
      Promise.allSettled(writes ?? []).then(() => reindexWorkspaceCalendarReplan(sync, db)),
    );
  };
}
