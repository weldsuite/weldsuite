/**
 * Asset register device import sweep: Cloudflare cron handler (every minute).
 *
 * Runs the Microsoft Intune imports of `asset_sources` (the shared logic is
 * `@weldsuite/core-domain/asset-sources`; app-api manages the sources). It
 * never wakes idle tenant DBs (ADR DATA-008): timing lives in the
 * SCHEDULE_INDEX D1 `workspace_due_index` (kind `asset_import`). app-api marks
 * the workspace due when a source is saved or started; each tick reads only D1,
 * opens the workspaces that are due, runs the import step of the sources that
 * are due or under way and stores when the workspace is next due: now while an
 * import is under way (it continues in bounded steps), the earliest
 * `next_sync_at` otherwise, and no row at all when no source is left. A
 * workspace without a source is never opened. Nothing existed before this
 * index, so there is nothing to seed.
 *
 * A step reads one Microsoft page and writes at most ASSET_IMPORT_MAX_WRITES
 * records, and every query of the tenant DB (Neon HTTP) is a subrequest, so a
 * tick runs STEPS_PER_TICK steps in all. Whatever does not fit stays due and
 * goes on the next tick.
 */

import { asc } from 'drizzle-orm';
import {
  publishCustomObjectEventRaw,
  publishEntityEventRaw,
} from '@weldsuite/entity-events';
import {
  ASSET_IMPORT_MAX_WRITES,
  assetSourceDueAt,
  assetSourceView,
  runAssetImportStep,
  startAssetImport,
  type AssetImportContext,
  type FetchLike,
} from '@weldsuite/core-domain/asset-sources';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../types';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const ASSET_IMPORT_SWEEP_CRONS = ['* * * * *'] as const;

export function isAssetImportSweepCron(cron: string): boolean {
  return (ASSET_IMPORT_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flag for the due index's one-time seed (nothing to seed: see above). */
export const ASSET_IMPORT_INDEX_SEED_KEY = 'desk:asset-import-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 10 * 60_000;
const WORKSPACES_PER_TICK = 20;
/** Import steps in one tick, across workspaces. */
export const ASSET_IMPORT_STEPS_PER_TICK = 1;

export interface WorkspaceAssetImportSweep {
  /** Import steps run. */
  steps: number;
  /** Runs that ended (finished or failed) in this workspace. */
  ended: number;
  /** When the workspace next has work (null: no source is left to import). */
  next: Date | null;
}

interface SweepOptions {
  fetch?: FetchLike;
  maxWrites?: number;
  /** Import steps this workspace may run; default {@link ASSET_IMPORT_STEPS_PER_TICK}. */
  maxSteps?: number;
}

type SourceRow = typeof schema.assetSources.$inferSelect;

/**
 * The run of a source to continue: the one under way, or one started now when
 * the source is due. Null when the source has nothing to do, or when another
 * tick started it between the read and the claim.
 */
async function runToContinue(db: Database, source: SourceRow, now: Date) {
  if (source.syncState) return source;
  const startable = source.enabled && source.nextSyncAt !== null && source.nextSyncAt <= now;
  return startable ? startAssetImport(db, source, { now }) : null;
}

/** When the workspace next has work: the earliest of its sources, a throttled one after its wait. Null when none has any. */
function earliestWork(sources: SourceRow[], throttledUntil: Map<string, Date>, now: Date): Date | null {
  let next: Date | null = null;
  for (const source of sources) {
    const wait = throttledUntil.get(source.id);
    const at = wait ?? assetSourceDueAt(source, now);
    if (at && (!next || at < next)) next = at;
  }
  return next;
}

/**
 * Run the due import steps of one workspace and answer when it next has work.
 * `orgId` is the Clerk org id the workspace's events and index row go by.
 */
export async function sweepWorkspaceAssetImports(
  env: Env,
  db: Database,
  orgId: string,
  now: Date,
  options: SweepOptions = {},
): Promise<WorkspaceAssetImportSweep> {
  const { assetSources: sources } = schema;
  const result: WorkspaceAssetImportSweep = { steps: 0, ended: 0, next: null };
  const throttledUntil = new Map<string, Date>();

  const context: AssetImportContext = {
    db,
    keyring: keyringFromEnv(env),
    fetch: options.fetch,
    now,
    maxWrites: options.maxWrites ?? ASSET_IMPORT_MAX_WRITES,
    events: {
      record: async ({ action, entityKey, recordId, data }) => {
        await publishCustomObjectEventRaw({
          env,
          db,
          workspaceId: orgId,
          userId: 'system',
          entityKey,
          action,
          entityId: recordId,
          data,
        });
      },
      field: async (definition) => {
        // The same event a field made by hand publishes.
        await publishEntityEventRaw({
          env,
          workspaceId: orgId,
          userId: 'system',
          entityType: 'custom_field',
          action: 'created',
          entityId: definition.id,
          data: { ...definition } as Record<string, unknown>,
        });
      },
    },
  };

  const due = await db.select().from(sources).orderBy(asc(sources.createdAt), asc(sources.id));
  for (const source of due) {
    if (result.steps >= (options.maxSteps ?? ASSET_IMPORT_STEPS_PER_TICK)) break;
    const running = await runToContinue(db, source, now);
    if (!running) continue;

    const step = await runAssetImportStep(context, running);
    result.steps += 1;
    if (step.retryAfterSeconds) throttledUntil.set(source.id, new Date(now.getTime() + step.retryAfterSeconds * 1000));
    if (step.done) {
      result.ended += 1;
      await publishEntityEventRaw({
        env,
        workspaceId: orgId,
        userId: 'system',
        entityType: 'asset_source',
        action: 'updated',
        entityId: step.source.id,
        data: assetSourceView(step.source) as unknown as Record<string, unknown>,
      });
    }
  }

  result.next = earliestWork(await db.select().from(sources), throttledUntil, now);
  return result;
}

export async function runAssetImportSweep(
  env: Env,
  now: Date = new Date(),
  options: { fetch?: FetchLike; maxWrites?: number } = {},
): Promise<DueIndexSweepResult & { steps: number; ended: number }> {
  const totals = { steps: 0, ended: 0 };
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'asset_import',
    label: '[AssetImport]',
    seed: { key: ASSET_IMPORT_INDEX_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    limit: WORKSPACES_PER_TICK,
    now: now.getTime(),
    shouldStop: () => totals.steps >= ASSET_IMPORT_STEPS_PER_TICK,
    process: async (orgId, at) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      const swept = await sweepWorkspaceAssetImports(env, db, orgId, at, {
        ...options,
        maxSteps: ASSET_IMPORT_STEPS_PER_TICK - totals.steps,
      });
      totals.steps += swept.steps;
      totals.ended += swept.ended;
      return swept.next;
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[AssetImport] due=${result.due} processed=${result.processed} steps=${totals.steps} ended=${totals.ended} workspaceFailures=${result.failed}`,
    );
  }
  return { ...result, steps: totals.steps, ended: totals.ended };
}
