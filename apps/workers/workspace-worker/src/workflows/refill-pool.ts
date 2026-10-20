/**
 * RefillPoolWorkflow — keeps the warm database pool topped up so new
 * workspaces can be provisioned INSTANTLY.
 *
 * Two kinds of warm slot (see `database_pool.kind`):
 *   'shared'    — a pre-migrated database + role inside a shared Neon project
 *                 shard. Claimed by FREE workspaces. Free tenants never get a
 *                 dedicated Neon project (cost: project ceiling + compute
 *                 fan-out) — shards are the only container for them.
 *   'dedicated' — a whole pre-created, pre-migrated Neon project. Claimed by
 *                 PAID workspaces.
 *
 * Each run:
 *   1. assess         — count available slots per kind vs the configured
 *                       targets (POOL_TARGET_SHARED / POOL_TARGET_DEDICATED).
 *   2. create-shared-slot — clone the shard's GOLDEN TEMPLATE database
 *                       (`CREATE DATABASE ... TEMPLATE`, a storage-level copy
 *                       taking seconds). The golden template is migrated once
 *                       per shard and delta-migrated on deploys; only when it
 *                       can't be used (legacy shard without admin tracking)
 *                       does the slot fall back to the journey below.
 *      create-dedicated-slot (and the shared fallback) — create Neon
 *                       resources, run the FULL migration journal (in budgeted
 *                       batches, one step each — see
 *                       MIGRATION_STATEMENTS_PER_STEP), pre-seed workspace-
 *                       agnostic rows (digest settings), then insert
 *                       the pool row. The row is only inserted once the slot is
 *                       fully ready, so a crash never leaves a claimable
 *                       half-ready slot.
 *   3. catch-up-stale — after a deploy ships new migrations, delta-migrate
 *                       existing available slots back to the latest schema so
 *                       claims stay on the instant path. A slot that fails
 *                       catch-up on the same migration MAX_CATCHUP_FAILURES
 *                       runs in a row is retired (status 'error').
 *
 * Triggered by the worker's cron (see `scheduled` in ../index.ts); a KV lock
 * plus a per-step recount keep overlapping runs from overshooting targets.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { databasePool, neonSharedProjects } from '@weldsuite/db/schema/master';
import { taskDigestSettings } from '@weldsuite/db/schema/task-digest-settings';
import { createProvisioningService, type WarmSlotResources } from '@weldsuite/neon-provisioning';
import type { Env } from '../index';
import { getMasterDb } from '../db';
import { generateId } from '../lib/id';
import { neonTenantSql } from '../lib/database-move/neon-sql';
import {
  applyTenantMigrations,
  LATEST_SCHEMA_VERSION,
  TenantMigrationError,
  type ApplyMigrationsResult,
} from '../lib/tenant-migrations';

export interface RefillPoolParams {
  /** Optional region override; defaults to NEON_DEFAULT_REGION. */
  region?: string;
}

/** Upper bound of slots created per kind per run — keeps runs short; the cron
 *  fires again in a few minutes to finish topping up a drained pool. */
const MAX_CREATES_PER_RUN = 3;
/** Stale available slots delta-migrated per run. */
const MAX_CATCHUP_PER_RUN = 5;
/**
 * Statement budget per migration step. A Workflows step attempt is a single
 * Worker invocation (≤1000 subrequests, ≤30s CPU). Each migration is applied
 * as one transaction, i.e. one neon-http subrequest, so a step makes one
 * request for the journal table plus one per migration (~220 for the whole
 * journal): subrequests no longer run out. The budget now bounds the Postgres
 * work one attempt waits on, and what a failed attempt redoes: the full
 * journal is ~2,600 statements. 600 keeps the step count low (~5 steps per
 * fresh slot; the largest single migration, 0000 at ~570 statements in one
 * ~150 KB request, still fits).
 */
const MIGRATION_STATEMENTS_PER_STEP = 600;

/**
 * Consecutive runs a stale slot may fail catch-up on the same migration before
 * it is retired. A failed migration rolls back whole, so each run retries it
 * from a clean slate; a slot that still fails it after this many runs (the
 * unsettled back-off apart) will not get there on its own, and while it stays
 * 'available' and stale the pool never settles and every retry wakes the master
 * DB and the slot's compute. Retired slots get status 'error': no longer
 * claimed or caught up, the next run creates a replacement, and the database
 * stays for inspection (`pnpm cleanup:pool` in apps/tools/migrate-databases
 * deletes dedicated 'error' slots).
 */
const MAX_CATCHUP_FAILURES = 3;
/** `refill-pool:catch-up-failures:<poolId>` holds that slot's `CatchUpFailures`. */
const CATCHUP_FAILURES_KEY_PREFIX = 'refill-pool:catch-up-failures:';
/** Long enough to span several back-off runs; an expired streak starts over. */
const CATCHUP_FAILURES_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * KV keys backing the "nothing to do" fast path.
 *
 * The cron fires every few minutes so a drained pool refills quickly, but the
 * pool is already at target on almost every tick. That matters because the
 * master DB deliberately uses the un-cached Neon HTTP driver (see ../db): an
 * unconditional `assess` + `find-stale-slots` query every tick never leaves the
 * master compute the idle gap it needs to scale to zero, so it stays billing
 * 24/7. Caching the outcome lets a settled pool be confirmed from KV alone and
 * the database go quiet between real events.
 *
 * `refill-pool:regions` is the index of regions the last run knew about;
 * `refill-pool:state:<region>` holds that region's `PoolState`.
 */
const REGIONS_KEY = 'refill-pool:regions';
const STATE_KEY_PREFIX = 'refill-pool:state:';
/** A settled pool is trusted this long before Postgres is consulted again. */
const SETTLED_TTL_SECONDS = 6 * 60 * 60;
/**
 * Backoff after a run that could NOT reach target — no shard capacity, Neon API
 * failing, or a slot that failed catch-up (retired after MAX_CATCHUP_FAILURES
 * such runs). Without it such a run retries as soon as the in-flight lock
 * lapses, indefinitely, and each retry wakes both the master DB and every shard
 * it probes for a golden-template version. The cron honours it through
 * `regionCanSkip`.
 */
const UNSETTLED_TTL_SECONDS = 30 * 60;
/** TTL of the region index. Must outlive the per-region state entries so it can
 *  always be used to find (and invalidate) them. */
const REGIONS_TTL_SECONDS = 24 * 60 * 60;

interface PoolState {
  /** Schema version the pool settled at — a deploy invalidates by mismatch. */
  schemaVersion: string;
  /** Targets met and no stale slot left behind, i.e. nothing left to do. */
  settled: boolean;
}

/** A stale slot's run of failed catch-ups. */
interface CatchUpFailures {
  /** Migration it failed on; null when it failed without one to blame (database unreachable, say). */
  tag: string | null;
  /** Consecutive runs that failed there. */
  count: number;
}

/** One catch-up step: what it applied, or the migration that failed (rolled back whole) or was refused. */
type CatchUpBatch = ApplyMigrationsResult | { failedOn: string; sqlState: string | null };

function targetFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Whether a finished run left the pool with provably nothing to do, so the next
 * ticks may skip Postgres. Pure and exported so the boundary cases can be
 * reasoned about (and tested) on their own — a wrong `true` here suppresses
 * database checks for SETTLED_TTL_SECONDS, which is the costly direction to get
 * wrong.
 *
 * `staleFound < MAX_CATCHUP_PER_RUN` matters because the catch-up query is
 * LIMITed: a full batch means there may be more stale slots behind it, so even
 * a fully successful batch can't prove the pool is clean.
 */
export function isPoolSettled(counts: {
  targetShared: number;
  targetDedicated: number;
  haveShared: number;
  haveDedicated: number;
  createdShared: number;
  createdDedicated: number;
  caughtUp: number;
  staleFound: number;
}): boolean {
  return (
    counts.haveShared + counts.createdShared >= counts.targetShared &&
    counts.haveDedicated + counts.createdDedicated >= counts.targetDedicated &&
    counts.caughtUp === counts.staleFound &&
    counts.staleFound < MAX_CATCHUP_PER_RUN
  );
}

/** Read one region's cached state; null when absent or unreadable. */
async function readPoolState(env: Env, region: string): Promise<PoolState | null> {
  try {
    return await env.WORKSPACE_CACHE.get(`${STATE_KEY_PREFIX}${region}`, 'json') as PoolState | null;
  } catch (error) {
    console.warn(`[RefillPool] Could not read pool state for ${region}:`, error);
    return null;
  }
}

/**
 * Whether a region's cached state lets the cron leave it alone this tick.
 *
 * Only a verdict recorded at the deployed schema counts; a deploy invalidates by
 * mismatch. Either verdict then holds until its entry expires: settled means
 * nothing to do (SETTLED_TTL_SECONDS), unsettled is the back-off after a run
 * that fell short (UNSETTLED_TTL_SECONDS). A warm-slot claim deletes the entry
 * (`invalidatePoolState`), so a drained pool still refills on the next tick.
 */
function regionCanSkip(state: PoolState | null): boolean {
  return (
    !!LATEST_SCHEMA_VERSION &&
    typeof state?.settled === 'boolean' &&
    state.schemaVersion === LATEST_SCHEMA_VERSION
  );
}

/**
 * True when every region the last run knew about is settled or backing off at
 * the schema version this deploy carries. Fails open (false) on any KV problem,
 * so a cache outage degrades to the old always-check-Postgres behaviour.
 */
async function poolCanSkip(env: Env): Promise<boolean> {
  if (!LATEST_SCHEMA_VERSION) return false;
  try {
    const regions = await env.WORKSPACE_CACHE.get(REGIONS_KEY, 'json') as string[] | null;
    if (!regions?.length) return false;

    const states = await Promise.all(regions.map(region => readPoolState(env, region)));
    return states.every(regionCanSkip);
  } catch (error) {
    console.warn('[RefillPool] Pool-state cache unavailable, checking Postgres:', error);
    return false;
  }
}

/**
 * Narrow a freshly enumerated region list to the regions with work to do.
 *
 * `poolCanSkip` is all-or-nothing, so on a tick where one region needs a run
 * we would otherwise start a workflow — two more master-DB queries each — for
 * every settled or backing-off region alongside it. Regions with no cached
 * state are kept: unknown is not settled.
 */
async function regionsDueForRefill(env: Env, regions: string[]): Promise<string[]> {
  const states = await Promise.all(regions.map(region => readPoolState(env, region)));
  return regions.filter((_region, i) => !regionCanSkip(states[i] ?? null));
}

/** Record a region's post-run state so settled ticks can skip Postgres. */
async function writePoolState(env: Env, region: string, settled: boolean): Promise<void> {
  if (!LATEST_SCHEMA_VERSION) return;
  const state: PoolState = { schemaVersion: LATEST_SCHEMA_VERSION, settled };
  try {
    await env.WORKSPACE_CACHE.put(`${STATE_KEY_PREFIX}${region}`, JSON.stringify(state), {
      expirationTtl: settled ? SETTLED_TTL_SECONDS : UNSETTLED_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(`[RefillPool] Could not cache pool state for ${region}:`, error);
  }
}

async function cacheRegions(env: Env, regions: string[]): Promise<void> {
  try {
    await env.WORKSPACE_CACHE.put(REGIONS_KEY, JSON.stringify(regions), {
      expirationTtl: REGIONS_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('[RefillPool] Could not cache refill regions:', error);
  }
}

/**
 * Drop the cached per-region state so the next cron tick re-checks Postgres.
 * Call this whenever the pool is drained outside this workflow — i.e. when a
 * workspace claims a warm slot. The region index is left in place: it's the
 * only way to find these keys, and it is rewritten on every real run anyway.
 */
export async function invalidatePoolState(env: Env): Promise<void> {
  try {
    const regions = await env.WORKSPACE_CACHE.get(REGIONS_KEY, 'json') as string[] | null;
    if (!regions?.length) return;
    await Promise.all(
      regions.map(region => env.WORKSPACE_CACHE.delete(`${STATE_KEY_PREFIX}${region}`))
    );
  } catch (error) {
    console.warn('[RefillPool] Could not invalidate cached pool state:', error);
  }
}

/**
 * Count one more failed catch-up of a slot and return its streak. The streak
 * goes on only while the slot fails on the same migration: failing on another
 * one means it got further, and starts over at 1. When KV is unavailable the
 * streak cannot grow, so the slot is retried as before rather than retired.
 */
async function recordCatchUpFailure(env: Env, poolId: string, tag: string | null): Promise<number> {
  const key = `${CATCHUP_FAILURES_KEY_PREFIX}${poolId}`;
  let previous: CatchUpFailures | null = null;
  try {
    previous = await env.WORKSPACE_CACHE.get(key, 'json') as CatchUpFailures | null;
  } catch (error) {
    console.warn(`[RefillPool] Could not read catch-up failures of slot ${poolId}:`, error);
  }
  const failures: CatchUpFailures = { tag, count: previous?.tag === tag ? previous.count + 1 : 1 };
  try {
    await env.WORKSPACE_CACHE.put(key, JSON.stringify(failures), { expirationTtl: CATCHUP_FAILURES_TTL_SECONDS });
  } catch (error) {
    console.warn(`[RefillPool] Could not record catch-up failure of slot ${poolId}:`, error);
    return 1;
  }
  return failures.count;
}

async function clearCatchUpFailures(env: Env, poolId: string): Promise<void> {
  try {
    await env.WORKSPACE_CACHE.delete(`${CATCHUP_FAILURES_KEY_PREFIX}${poolId}`);
  } catch (error) {
    console.warn(`[RefillPool] Could not clear catch-up failures of slot ${poolId}:`, error);
  }
}

/**
 * Apply the next budgeted batch of a stale slot's pending migrations. A
 * migration Postgres rejected (or that was refused before it ran) is returned
 * rather than thrown: it rolled back whole and fails the same way when retried
 * straight away, so the step does not retry it; the next run does. Anything
 * else (no answer from the database) throws, and the step retries.
 */
async function catchUpBatch(databaseUrl: string): Promise<CatchUpBatch> {
  try {
    return await applyTenantMigrations(neonTenantSql(databaseUrl), { statementBudget: MIGRATION_STATEMENTS_PER_STEP });
  } catch (error) {
    if (error instanceof TenantMigrationError && (error.sqlState !== null || error.statement !== null)) {
      return { failedOn: error.tag, sqlState: error.sqlState };
    }
    throw error;
  }
}

export class RefillPoolWorkflow extends WorkflowEntrypoint<Env, RefillPoolParams> {
  async run(event: WorkflowEvent<RefillPoolParams>, step: WorkflowStep) {
    const region = event.payload?.region || this.env.NEON_DEFAULT_REGION || 'aws-eu-central-1';
    const targetShared = targetFromEnv(this.env.POOL_TARGET_SHARED, 3);
    const targetDedicated = targetFromEnv(this.env.POOL_TARGET_DEDICATED, 0);

    if (!LATEST_SCHEMA_VERSION) {
      console.warn('[RefillPool] No bundled migrations — nothing to prepare');
      // Same shape as the normal return below, so anything reading the workflow
      // instance's output sees `settled` on every path rather than undefined.
      return { created: 0, caughtUp: 0, settled: false };
    }

    const deficits = await step.do('assess', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const masterDb = getMasterDb(this.env);
      const counts = await this.countAvailable(masterDb, region);
      const shared = Math.min(Math.max(targetShared - counts.shared, 0), MAX_CREATES_PER_RUN);
      const dedicated = Math.min(Math.max(targetDedicated - counts.dedicated, 0), MAX_CREATES_PER_RUN);
      console.log(
        `[RefillPool] region=${region} shared ${counts.shared}/${targetShared} (+${shared}), ` +
        `dedicated ${counts.dedicated}/${targetDedicated} (+${dedicated})`
      );
      // haveShared/haveDedicated feed the settled check below — the deficits
      // above are capped at MAX_CREATES_PER_RUN and so can't reveal the real gap.
      return { shared, dedicated, haveShared: counts.shared, haveDedicated: counts.dedicated };
    });

    let createdShared = 0;
    for (let i = 0; i < deficits.shared; i++) {
      if (await this.createSharedSlotSteps(step, i, region, targetShared)) createdShared++;
    }

    let createdDedicated = 0;
    for (let i = 0; i < deficits.dedicated; i++) {
      if (await this.createSlotSteps(step, 'dedicated', i, region, targetDedicated)) createdDedicated++;
    }

    const { caughtUp, staleFound } = await this.catchUpStaleSlots(step, region);
    const created = createdShared + createdDedicated;

    // A run that fell short — capacity exhausted, a slot that won't migrate, or
    // a catch-up batch that filled its limit — records false and takes the short
    // backoff TTL instead of being trusted for hours. See isPoolSettled.
    const settled = isPoolSettled({
      targetShared,
      targetDedicated,
      haveShared: deficits.haveShared,
      haveDedicated: deficits.haveDedicated,
      createdShared,
      createdDedicated,
      caughtUp,
      staleFound,
    });

    await step.do('record-state', {
      retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
    }, async () => {
      await writePoolState(this.env, region, settled);
      return settled;
    });

    console.log(`[RefillPool] Done: ${created} slots created, ${caughtUp} caught up, settled=${settled}`);
    return { created, caughtUp, settled };
  }

  private async countAvailable(masterDb: ReturnType<typeof getMasterDb>, region: string) {
    const rows = await masterDb
      .select({ kind: databasePool.kind, count: sql<number>`count(*)::int` })
      .from(databasePool)
      .where(and(eq(databasePool.status, 'available'), eq(databasePool.region, region)))
      .groupBy(databasePool.kind);

    const byKind: Record<string, number> = {};
    for (const row of rows) byKind[row.kind] = row.count;
    return { shared: byKind['shared'] ?? 0, dedicated: byKind['dedicated'] ?? 0 };
  }

  /** Run the pending migration journal against a database in budgeted step
   *  batches (step names `${prefix}-migrate-N`). Returns statements applied. */
  private async runMigrationBatches(step: WorkflowStep, prefix: string, databaseUrl: string): Promise<number> {
    let applied = 0;
    for (let batch = 0; ; batch++) {
      const result = await step.do(`${prefix}-migrate-${batch}`, {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '10 minutes',
      }, async () => applyTenantMigrations(neonTenantSql(databaseUrl), { statementBudget: MIGRATION_STATEMENTS_PER_STEP }));
      applied += result.applied;
      if (result.remaining === 0) break;
    }
    return applied;
  }

  /** Insert the `database_pool` row that makes a fully-ready slot claimable. */
  private async insertPoolRow(kind: 'shared' | 'dedicated', region: string, resources: WarmSlotResources): Promise<void> {
    const masterDb = getMasterDb(this.env);
    await masterDb.insert(databasePool).values({
      id: resources.poolId,
      kind,
      neonProjectId: resources.neonProjectId,
      neonBranchId: resources.neonBranchId,
      connectionHost: resources.connectionHost,
      databaseName: resources.databaseName,
      roleName: resources.roleName,
      databaseUrl: resources.databaseUrl,
      sharedProjectId: resources.sharedProjectId,
      schemaVersion: LATEST_SCHEMA_VERSION,
      region,
      status: 'available',
    });
  }

  /**
   * Create one warm SHARED slot by cloning the shard's golden template.
   *
   * Claim shard capacity → ensure the shard's golden template is at the
   * bundled schema (migrating it in budgeted batches when it isn't — a
   * once-per-shard cost, then a delta per deploy) → clone it into the slot.
   * Shards that can't support the template path (no tracked admin role /
   * connection host) fall back to the legacy API-create + full-journal
   * replay. The pool row is only inserted once the slot is fully ready.
   */
  private async createSharedSlotSteps(
    step: WorkflowStep,
    index: number,
    region: string,
    target: number,
  ): Promise<boolean> {
    const prefix = `create-shared-slot-${index}`;
    const svc = this.provisioningService(region);

    const shard = await step.do(`${prefix}-claim-shard`, {
      retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
      timeout: '10 minutes',
    }, async () => {
      const masterDb = getMasterDb(this.env);

      // Recount before creating — overlapping runs (or an operator raising
      // the pool manually) must not overshoot the target.
      const counts = await this.countAvailable(masterDb, region);
      if (counts.shared >= target) {
        console.log('[RefillPool] shared pool already at target, skipping create');
        return null;
      }
      return svc.claimShardForWarmSlot(masterDb);
    });
    if (!shard) return false;

    let resources: WarmSlotResources | null = null;
    try {
      const goldenVersion = await step.do(`${prefix}-golden-check`, {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, () => Promise.resolve(svc.getGoldenSchemaVersion(shard)));

      let goldenReady = goldenVersion === LATEST_SCHEMA_VERSION;
      if (!goldenReady) {
        const goldenUrl = await step.do(`${prefix}-golden-open`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, () => Promise.resolve(svc.openGoldenForMigration(shard)));

        if (goldenUrl) {
          const applied = await this.runMigrationBatches(step, `${prefix}-golden`, goldenUrl);
          console.log(`[RefillPool] Golden template on shard ${shard.id}: ${applied} migrations applied`);

          await step.do(`${prefix}-golden-seed`, {
            retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
          }, async () => this.seedWorkspaceAgnosticDefaults({ databaseUrl: goldenUrl }));

          goldenReady = await step.do(`${prefix}-golden-seal`, {
            retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
          }, () => Promise.resolve(svc.sealGoldenTemplate(shard, LATEST_SCHEMA_VERSION!)));
        }
      }

      if (goldenReady) {
        resources = await step.do(`${prefix}-clone`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, () => Promise.resolve(svc.createWarmSharedSlotFromTemplate(shard)));
      }

      // Legacy fallback: API-created empty database + full journal replay.
      if (!resources) {
        console.warn(`[RefillPool] Template path unavailable on shard ${shard.id}, falling back to journal replay`);
        resources = await step.do(`${prefix}-resources`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, () => Promise.resolve(svc.createWarmSharedSlotResourcesOnShard(shard)));
        if (resources) {
          const applied = await this.runMigrationBatches(step, prefix, resources.databaseUrl);
          console.log(`[RefillPool] Slot ${resources.poolId}: ${applied} migrations applied`);
        }
      }

      if (!resources) {
        await step.do(`${prefix}-release-capacity`, {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        }, () => Promise.resolve(svc.releaseShardCapacity(getMasterDb(this.env), shard.id)));
        return false;
      }

      const slot = resources;
      await step.do(`${prefix}-finalize`, {
        retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
        timeout: '10 minutes',
      }, async () => {
        // Template clones inherit the seed rows baked into the golden template.
        if (!slot.preMigrated) await this.seedWorkspaceAgnosticDefaults(slot);
        await this.insertPoolRow('shared', region, slot);
      });

      console.log(
        `[RefillPool] Warm shared slot ${slot.poolId} ready ` +
        `(schema ${LATEST_SCHEMA_VERSION}, ${slot.preMigrated ? 'template clone' : 'journal replay'})`
      );
      return true;
    } catch (error) {
      console.error(`[RefillPool] Failed to prepare shared slot on shard ${shard.id}, releasing:`, error);
      try {
        await step.do(`${prefix}-release`, {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        }, async () => {
          const masterDb = getMasterDb(this.env);
          if (resources) {
            await svc.releaseWarmSlotResources(masterDb, resources);
          } else {
            await svc.releaseShardCapacity(masterDb, shard.id);
          }
        });
      } catch (releaseError) {
        console.error('[RefillPool] Failed to release shared slot resources (orphaned):', releaseError);
      }
      return false;
    }
  }

  /**
   * Create one fully-ready warm DEDICATED slot across several workflow steps:
   * Neon resources → migration journal in budgeted batches → workspace-
   * agnostic seeds + pool row. Split because a single step attempt is one
   * Worker invocation and the full journal blows its subrequest/CPU limits.
   * The pool row is still only inserted in the final step, so a crash never
   * leaves a claimable half-ready slot. Returns false (without failing the
   * run) when capacity is unavailable or another run already met the target.
   * (Dedicated pool projects can't use the golden template — Postgres
   * templates don't cross Neon projects.)
   */
  private async createSlotSteps(
    step: WorkflowStep,
    kind: 'dedicated',
    index: number,
    region: string,
    target: number,
  ): Promise<boolean> {
    const prefix = `create-${kind}-slot-${index}`;

    const resources = await step.do(`${prefix}-resources`, {
      retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
      timeout: '10 minutes',
    }, async (): Promise<WarmSlotResources | null> => {
      const masterDb = getMasterDb(this.env);

      // Recount before creating — overlapping runs (or an operator raising
      // the pool manually) must not overshoot the target.
      const counts = await this.countAvailable(masterDb, region);
      if (counts.dedicated >= target) {
        console.log(`[RefillPool] ${kind} pool already at target, skipping create`);
        return null;
      }

      return this.provisioningService(region).createWarmDedicatedProjectResources();
    });

    if (!resources) {
      console.warn(`[RefillPool] No ${kind} slot resources created`);
      return false;
    }

    try {
      const applied = await this.runMigrationBatches(step, prefix, resources.databaseUrl);
      console.log(`[RefillPool] Slot ${resources.poolId}: ${applied} migrations applied`);

      await step.do(`${prefix}-finalize`, {
        retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
        timeout: '10 minutes',
      }, async () => {
        await this.seedWorkspaceAgnosticDefaults(resources);
        await this.insertPoolRow(kind, region, resources);
      });

      console.log(`[RefillPool] Warm ${kind} slot ${resources.poolId} ready (schema ${LATEST_SCHEMA_VERSION})`);
      return true;
    } catch (error) {
      console.error(`[RefillPool] Failed to prepare ${kind} slot ${resources.poolId}, releasing resources:`, error);
      try {
        await step.do(`${prefix}-release`, {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        }, async () => {
          const masterDb = getMasterDb(this.env);
          await this.provisioningService(region).releaseWarmSlotResources(masterDb, resources);
        });
      } catch (releaseError) {
        console.error(`[RefillPool] Failed to release slot ${resources.poolId} (orphaned Neon resources):`, releaseError);
      }
      return false;
    }
  }

  private provisioningService(region: string) {
    return createProvisioningService({
      NEON_API_KEY: this.env.NEON_API_KEY,
      NEON_ORG_ID: this.env.NEON_ORG_ID,
      NEON_DEFAULT_REGION: region,
    });
  }

  /**
   * Pre-seed rows every workspace gets and that reference nothing
   * workspace-specific, so the claim-time personalize step stays minimal.
   * Mirrors the tenant half of the provisioning workflow's setup-digest
   * (idempotent no-op afterwards). Also seeds the golden template, whose
   * clones inherit the rows — and which is re-seeded on every schema
   * catch-up, hence the existence guard.
   */
  private async seedWorkspaceAgnosticDefaults(
    resources: Pick<WarmSlotResources, 'databaseUrl'>,
  ): Promise<void> {
    const tenantDb = drizzleNeonHttp({ client: neon(resources.databaseUrl) });

    const existing = await tenantDb
      .select({ id: taskDigestSettings.id })
      .from(taskDigestSettings)
      .limit(1);
    if (existing.length > 0) return;

    await tenantDb.insert(taskDigestSettings).values({
      id: generateId('tds'),
      enabled: true,
      sendHour: 8,
      taskTypes: { projectTasks: true, personalTasks: true },
      sections: { overdue: true, dueToday: true, dueThisWeek: true },
    });
  }

  /**
   * Delta-migrate available slots whose schema fell behind after a deploy, so
   * subsequent claims take the instant path instead of the workflow wait.
   * One step per slot per migration batch — the delta is usually tiny, but a
   * slot that fell far behind must not blow a single step's invocation limits.
   *
   * Returns both how many were caught up and how many were found, so the caller
   * can tell "nothing stale" from "some stale slots refused to migrate" and
   * avoid recording a settled pool in the latter case. A slot that keeps
   * failing is retired (see MAX_CATCHUP_FAILURES), so it stops holding the
   * pool unsettled: the run that retires it still counts it as stale, and the
   * next one, no longer finding it, can settle.
   */
  private async catchUpStaleSlots(
    step: WorkflowStep,
    region: string,
  ): Promise<{ caughtUp: number; staleFound: number }> {
    const stale = await step.do('find-stale-slots', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, () => {
      const masterDb = getMasterDb(this.env);
      return masterDb
        .select({ id: databasePool.id, databaseUrl: databasePool.databaseUrl })
        .from(databasePool)
        .where(and(
          eq(databasePool.status, 'available'),
          eq(databasePool.region, region),
          or(
            isNull(databasePool.schemaVersion),
            ne(databasePool.schemaVersion, LATEST_SCHEMA_VERSION!),
          ),
        ))
        .limit(MAX_CATCHUP_PER_RUN);
    });

    let caughtUp = 0;
    for (const slot of stale) {
      const outcome = await this.catchUpSlot(step, slot);
      if (outcome.caughtUp) {
        caughtUp++;
      } else {
        await this.countCatchUpFailure(step, slot.id, outcome.failedOn);
      }
    }
    return { caughtUp, staleFound: stale.length };
  }

  /** Delta-migrate one stale slot and mark it current. `failedOn` names the migration it failed on, when one did. */
  private async catchUpSlot(
    step: WorkflowStep,
    slot: { id: string; databaseUrl: string },
  ): Promise<{ caughtUp: true } | { caughtUp: false; failedOn: string | null }> {
    try {
      let applied = 0;
      for (let batch = 0; ; batch++) {
        const result = await step.do(`catch-up-${slot.id}-${batch}`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, () => catchUpBatch(slot.databaseUrl));
        if ('failedOn' in result) {
          const state = result.sqlState ? ` (SQLSTATE ${result.sqlState})` : '';
          console.error(`[RefillPool] Slot ${slot.id} failed catch-up on migration ${result.failedOn}${state}; rolled back`);
          return { caughtUp: false, failedOn: result.failedOn };
        }
        applied += result.applied;
        if (result.remaining === 0) break;
      }

      await step.do(`catch-up-${slot.id}-mark`, {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const masterDb = getMasterDb(this.env);
        await masterDb
          .update(databasePool)
          .set({ schemaVersion: LATEST_SCHEMA_VERSION })
          .where(eq(databasePool.id, slot.id));
        await clearCatchUpFailures(this.env, slot.id);
      });

      console.log(`[RefillPool] Caught up slot ${slot.id} (+${applied} migrations)`);
      return { caughtUp: true };
    } catch (error) {
      console.error(`[RefillPool] Failed to catch up slot ${slot.id}:`, error);
      return { caughtUp: false, failedOn: null };
    }
  }

  /**
   * Count a failed catch-up, and retire the slot (status 'error') once it has
   * failed MAX_CATCHUP_FAILURES runs in a row on the same migration. Only an
   * unclaimed slot is retired: a workspace may have claimed it since
   * find-stale-slots, and then its provisioning applies the delta itself.
   */
  private async countCatchUpFailure(step: WorkflowStep, poolId: string, failedOn: string | null): Promise<void> {
    try {
      const failures = await step.do(`catch-up-${poolId}-failed`, {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, () => recordCatchUpFailure(this.env, poolId, failedOn));
      if (failures < MAX_CATCHUP_FAILURES) return;

      const retired = await step.do(`catch-up-${poolId}-retire`, {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const masterDb = getMasterDb(this.env);
        const rows = await masterDb
          .update(databasePool)
          .set({ status: 'error' })
          .where(and(eq(databasePool.id, poolId), eq(databasePool.status, 'available')))
          .returning({ id: databasePool.id });
        await clearCatchUpFailures(this.env, poolId);
        return rows.length > 0;
      });
      if (retired) {
        const where = failedOn ? 'on migration ' + failedOn : 'before reaching a migration';
        console.error(`[RefillPool] Retired slot ${poolId} (status 'error'): catch-up failed ${failures} runs in a row ${where}`);
      }
    } catch (error) {
      console.error(`[RefillPool] Could not count the failed catch-up of slot ${poolId}:`, error);
    }
  }
}

/**
 * Kick off refill runs (called from the worker's cron `scheduled` handler) —
 * one per region that needs a warm pool: the default region plus every region
 * that already has a shared shard (a shard existing there means tenants chose
 * that region during onboarding, so future signups there deserve warm slots
 * too). A short-TTL KV lock prevents a thundering herd of overlapping runs;
 * the per-step recount inside the workflow is the real overshoot guard.
 *
 * Ticks where the pool is already settled, or backing off after a run that fell
 * short, return before touching Postgres at all — see `poolCanSkip`. Without
 * that the cron's own bookkeeping queries kept the master Neon compute from
 * ever scaling to zero.
 */
export async function triggerPoolRefill(env: Env): Promise<void> {
  if (!env.REFILL_POOL) {
    console.warn('[RefillPool] REFILL_POOL workflow binding not configured, skipping');
    return;
  }
  if (!env.NEON_API_KEY) {
    console.warn('[RefillPool] NEON_API_KEY not configured, skipping');
    return;
  }
  // Without a bundled journal the workflow can't prepare anything (it bails at
  // the same check), so stop here rather than paying the region query to find out.
  if (!LATEST_SCHEMA_VERSION) {
    console.warn('[RefillPool] No bundled migrations — skipping');
    return;
  }

  // Checked before the lock is taken: this path opens no database and starts no
  // workflow, so it must not leave a 10-minute lock behind either.
  if (await poolCanSkip(env)) {
    console.log('[RefillPool] Pool settled or backing off per cached state — skipping (no database access)');
    return;
  }

  const lockKey = 'refill-pool:inflight';
  try {
    const inFlight = await env.WORKSPACE_CACHE.get(lockKey);
    if (inFlight) {
      console.log('[RefillPool] A refill run is already in flight, skipping');
      return;
    }
    await env.WORKSPACE_CACHE.put(lockKey, '1', { expirationTtl: 600 });
  } catch (lockErr) {
    console.warn('[RefillPool] Lock unavailable (proceeding):', lockErr);
  }

  const defaultRegion = env.NEON_DEFAULT_REGION || 'aws-eu-central-1';
  let regions = [defaultRegion];
  try {
    const masterDb = getMasterDb(env);
    const shardRegions = await masterDb
      .selectDistinct({ region: neonSharedProjects.region })
      .from(neonSharedProjects);
    regions = [...new Set([defaultRegion, ...shardRegions.map(r => r.region)])];
    // Cached so `poolCanSkip` knows which regions to check — and so this
    // enumeration isn't itself a per-tick query against the master DB.
    await cacheRegions(env, regions);
  } catch (error) {
    console.warn('[RefillPool] Could not enumerate shard regions, refilling default region only:', error);
  }

  // The aggregate check above only tells us SOMETHING needs doing. Drop the
  // regions whose own cached state is still settled or backing off so they
  // don't each pay an assess + find-stale-slots round-trip on behalf of a
  // noisy neighbour.
  const pending = await regionsDueForRefill(env, regions);
  if (pending.length === 0) {
    console.log('[RefillPool] All enumerated regions settled or backing off — nothing to trigger');
    // Nothing was started, so don't sit on the in-flight lock for its full TTL.
    try {
      await env.WORKSPACE_CACHE.delete(lockKey);
    } catch (unlockErr) {
      console.warn('[RefillPool] Could not release in-flight lock:', unlockErr);
    }
    return;
  }

  const stamp = Date.now();
  for (const region of pending) {
    try {
      const instance = await env.REFILL_POOL.create({
        id: `refill-${region}-${stamp}`,
        params: { region },
      });
      console.log(`[RefillPool] Triggered refill run ${instance.id} (${region})`);
    } catch (error) {
      console.error(`[RefillPool] Failed to trigger refill workflow for ${region}:`, error);
    }
  }
}
