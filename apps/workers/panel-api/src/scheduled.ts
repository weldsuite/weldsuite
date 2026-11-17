/**
 * panel-api's cron (`*\/10 * * * *`, every env block of wrangler.toml): runs
 * the alerts, scheduled reports and raw exports that are due, and polls
 * Cloudflare for custom collector domains still pending.
 *
 * Due work comes from the master `panel_schedule_registry`, so no tenant
 * database is opened unless something in it is due (DATA-009):
 *
 * 1. Claim: one statement takes at most 50 rows with `next_run_at <= now`
 *    whose lock is free or expired, and locks them for 10 minutes
 *    (`FOR UPDATE SKIP LOCKED`, services/schedule.ts), so two invocations
 *    never take the same row and a run that dies frees its rows on its own.
 * 2. Group the rows by workspace and open each tenant database once.
 * 3. Run each item with the tenant row as the source of truth (a row deleted,
 *    disabled or paused since is dropped from the registry), and hand the row
 *    back with its next run, only while the lock is still ours.
 *
 * Work is bounded: 50 rows per invocation, and no new item starts after 8
 * minutes (items not started stay due for the next invocation). An item that
 * throws is retried in 10 minutes; one never stops the others.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getMasterDb, getWorkspaceContextForOrg, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import type { PanelScheduleRegistryRow } from '@weldsuite/db/schema/master';
import type { Env } from './types';
import { claimDue, MAX_CLAIM, releaseSchedule } from './services/schedule';
import { alertEventData, getAlert, nextCheckOf, runAlertCheck } from './services/alerts';
import { getSubscription, nextRunOf as nextSubscriptionRunOf, sendSubscription } from './services/subscriptions';
import { exportContext, getExport, nextRunOf as nextExportRunOf, runExport, sendExportFailingMail } from './services/exports';
import { deliver, type DeliveryContext } from './services/delivery';
import { domainEventData, domainsToPoll, refreshDomain, removeDomain, saasConfig } from './services/domains';
import { basinExecutor } from './services/query-engine';
import { queryRunDeps, runCachedQuery } from './services/query-run';

const MINUTE = 60_000;
/** No new item starts after this much of an invocation. */
export const RUN_BUDGET_MS = 8 * MINUTE;
/** When an item that threw is tried again. */
export const RETRY_MS = 10 * MINUTE;
/** Custom domains polled per invocation. */
export const DOMAINS_PER_RUN = 20;

export interface WorkspaceHandle {
  db: Database;
  /** `workspaces.id`. */
  workspaceId: string;
  clerkOrgId: string;
  suspended: boolean;
}

export interface ScheduledDeps {
  env: Env;
  now?: Date;
  masterDb?: AnyMasterDatabase;
  /** Opens a workspace's tenant database (tests hand pglite back). */
  openWorkspace?: (workspaceId: string) => Promise<WorkspaceHandle>;
  /** Replaces the item runner (tests of the claim and release logic). */
  runItem?: (ws: WorkspaceHandle, row: PanelScheduleRegistryRow, now: Date, deadline: number) => Promise<Date | null>;
  /** Wall-clock budget; default {@link RUN_BUDGET_MS}. */
  budgetMs?: number;
  /** Delivery overrides (tests). */
  delivery?: Pick<DeliveryContext, 'transport' | 'fetch' | 'senders'>;
}

export interface ScheduledSummary {
  claimed: number;
  ran: number;
  failed: number;
  deferred: number;
  domains: number;
}

async function defaultOpen(env: Env, workspaceId: string): Promise<WorkspaceHandle> {
  const ws = await getWorkspaceContextForOrg(env, workspaceId);
  return { db: ws.db, workspaceId: ws.id, clerkOrgId: ws.clerkOrgId ?? ws.id, suspended: ws.suspended };
}

/** Runs one due item and says when it is next due (null: drop it from the registry). */
export async function runScheduleItem(deps: ScheduledDeps, ws: WorkspaceHandle, row: PanelScheduleRegistryRow, now: Date, deadline: number): Promise<Date | null> {
  const { env } = deps;
  const { db } = ws;
  const run = async (spec: Parameters<typeof runCachedQuery>[1]) => (await runCachedQuery(queryRunDeps(env, db, ws.workspaceId), spec)).result;
  const send = (actorUserId: string) => (target: Parameters<typeof deliver>[1], message: Parameters<typeof deliver>[2]) =>
    deliver({ env, db, workspaceId: ws.workspaceId, clerkOrgId: ws.clerkOrgId, actorUserId, ...deps.delivery }, target, message);

  if (row.kind === 'alert') {
    const alert = await getAlert(db, row.objectId);
    if (!alert || !alert.enabled) return null;
    const result = await runAlertCheck(
      {
        db,
        now,
        run,
        deliver: send(alert.ownerUserId),
        publish: (a, action) =>
          publishEntityEventRaw({
            env,
            workspaceId: ws.clerkOrgId,
            userId: a.ownerUserId,
            entityType: 'panel_alert',
            action,
            entityId: a.id,
            data: alertEventData(a),
          }),
      },
      alert,
    );
    return nextCheckOf(result.alert, result.timezone, now);
  }

  if (row.kind === 'subscription') {
    const sub = await getSubscription(db, row.objectId);
    if (!sub || !sub.enabled) return null;
    const result = await sendSubscription({ db, now, run, deliver: send(sub.ownerUserId) }, sub, { schedule: true });
    return result.subscription.nextRunAt ?? nextSubscriptionRunOf(sub, now);
  }

  const exp = await getExport(db, row.objectId);
  if (!exp || exp.status === 'paused') return null;
  const masterDb = deps.masterDb ?? getMasterDb(env);
  const result = await runExport(
    {
      db,
      env,
      now,
      deadline,
      execute: basinExecutor(env),
      context: () => exportContext(env, masterDb, ws.workspaceId, exp.projectId, now),
      notifyFailing: async (failing, error) => {
        await sendExportFailingMail({ env, db, clerkOrgId: ws.clerkOrgId, transport: deps.delivery?.transport }, failing, error);
      },
    },
    exp,
  );
  const next = nextExportRunOf(result.export, now);
  if (!next) return null;
  // More windows waiting (a backfill, or the run stopped at its limit): carry on with the next invocation.
  if (!result.caughtUp && !result.error) return now;
  if (result.error) return new Date(Math.min(next.getTime(), now.getTime() + 60 * MINUTE));
  return next;
}

/** Refreshes pending custom domains and retries removals Cloudflare refused. */
async function pollDomains(env: Env, masterDb: AnyMasterDatabase, now: Date): Promise<number> {
  const cfg = saasConfig(env);
  if (!cfg) return 0;
  const rows = await domainsToPoll(masterDb, now, DOMAINS_PER_RUN);
  for (const domain of rows) {
    try {
      if (domain.status === 'deleting') {
        const { removed, domain: after } = await removeDomain(masterDb, cfg, domain, now);
        if (removed) {
          await publishEntityEventRaw({ env, workspaceId: domain.workspaceId, userId: domain.createdByUserId, entityType: 'panel_custom_domain', action: 'deleted', entityId: domain.id, data: domainEventData(after) });
        }
        continue;
      }
      const fresh = await refreshDomain(masterDb, cfg, domain, now);
      if (fresh.status !== domain.status) {
        await publishEntityEventRaw({ env, workspaceId: domain.workspaceId, userId: domain.createdByUserId, entityType: 'panel_custom_domain', action: 'updated', entityId: domain.id, data: domainEventData(fresh) });
      }
    } catch (err) {
      console.error(`[panel-api] custom domain ${domain.id} poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return rows.length;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface RowRun {
  masterDb: AnyMasterDatabase;
  runItem: NonNullable<ScheduledDeps['runItem']>;
  now: Date;
  deadline: number;
  summary: ScheduledSummary;
}

/** Runs one claimed row (or defers it) and hands it back with its next run. */
async function runRow(run: RowRun, ws: WorkspaceHandle | null, row: PanelScheduleRegistryRow): Promise<void> {
  const { masterDb, now, summary } = run;
  if (!ws || ws.suspended) {
    // Try again later; a suspended workspace runs nothing until it is back.
    await releaseSchedule(masterDb, row, new Date(now.getTime() + (ws?.suspended ? 60 * MINUTE : RETRY_MS)));
    summary.deferred += 1;
    return;
  }
  if (Date.now() > run.deadline) {
    // Out of time: leave it due for the next invocation.
    await releaseSchedule(masterDb, row, row.nextRunAt);
    summary.deferred += 1;
    return;
  }
  let next: Date | null;
  try {
    next = await run.runItem(ws, row, now, run.deadline);
    summary.ran += 1;
  } catch (err) {
    console.error(`[panel-api] cron: ${row.kind} ${row.objectId} failed: ${errorText(err)}`);
    next = new Date(now.getTime() + RETRY_MS);
    summary.failed += 1;
  }
  await releaseSchedule(masterDb, row, next);
}

/** One cron invocation. */
export async function runScheduled(deps: ScheduledDeps): Promise<ScheduledSummary> {
  const { env } = deps;
  const now = deps.now ?? new Date();
  const masterDb = deps.masterDb ?? getMasterDb(env);
  const deadline = Date.now() + (deps.budgetMs ?? RUN_BUDGET_MS);
  const open = deps.openWorkspace ?? ((id: string) => defaultOpen(env, id));
  const runItem = deps.runItem ?? ((ws, row, at, until) => runScheduleItem({ ...deps, masterDb }, ws, row, at, until));
  const summary: ScheduledSummary = { claimed: 0, ran: 0, failed: 0, deferred: 0, domains: 0 };

  const claimed = await claimDue(masterDb, now, MAX_CLAIM);
  summary.claimed = claimed.length;
  const byWorkspace = new Map<string, PanelScheduleRegistryRow[]>();
  for (const row of claimed) byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row]);

  for (const [workspaceId, rows] of byWorkspace) {
    const ws = await open(workspaceId).catch((err: unknown) => {
      console.error(`[panel-api] cron: workspace ${workspaceId} could not be opened: ${errorText(err)}`);
      return null;
    });
    for (const row of rows) {
      await runRow({ masterDb, runItem, now, deadline, summary }, ws, row);
    }
  }

  try {
    summary.domains = await pollDomains(env, masterDb, now);
  } catch (err) {
    console.error(`[panel-api] cron: custom domains poll failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return summary;
}

/** The Worker's `scheduled` handler (exported from ./index.ts). */
export function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    runScheduled({ env })
      .then((s) => {
        if (s.claimed > 0 || s.domains > 0) console.warn(`[panel-api] cron claimed=${s.claimed} ran=${s.ran} failed=${s.failed} deferred=${s.deferred} domains=${s.domains}`);
      })
      .catch((err: unknown) => console.error('[panel-api] cron failed', err)),
  );
}
