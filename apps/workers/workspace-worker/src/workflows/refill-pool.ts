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
 *                       claims stay on the instant path.
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
import { applyTenantMigrations, LATEST_SCHEMA_VERSION } from '../lib/tenant-migrations';

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
 * Statement budget per migration step. Each statement is one neon-http
 * subrequest and a Workflows step attempt is a single Worker invocation
 * (≤1000 subrequests, ≤30s CPU) — running the full ~2,600-statement journal
 * in one step kills the isolate with an opaque WorkflowInternalError. 600
 * leaves headroom while keeping the step count low (~5 steps per fresh slot;
 * the largest single migration, 0000 at ~570 statements, still fits).
 */
const MIGRATION_STATEMENTS_PER_STEP = 600;

function targetFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class RefillPoolWorkflow extends WorkflowEntrypoint<Env, RefillPoolParams> {
  async run(event: WorkflowEvent<RefillPoolParams>, step: WorkflowStep) {
    const region = event.payload?.region || this.env.NEON_DEFAULT_REGION || 'aws-eu-central-1';
    const targetShared = targetFromEnv(this.env.POOL_TARGET_SHARED, 3);
    const targetDedicated = targetFromEnv(this.env.POOL_TARGET_DEDICATED, 0);

    if (!LATEST_SCHEMA_VERSION) {
      console.warn('[RefillPool] No bundled migrations — nothing to prepare');
      return { created: 0, caughtUp: 0 };
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
      return { shared, dedicated };
    });

    let created = 0;

    for (let i = 0; i < deficits.shared; i++) {
      if (await this.createSharedSlotSteps(step, i, region, targetShared)) created++;
    }

    for (let i = 0; i < deficits.dedicated; i++) {
      if (await this.createSlotSteps(step, 'dedicated', i, region, targetDedicated)) created++;
    }

    const caughtUp = await this.catchUpStaleSlots(step, region);

    console.log(`[RefillPool] Done: ${created} slots created, ${caughtUp} caught up`);
    return { created, caughtUp };
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
      }, async () => {
        const tenantDb = drizzleNeonHttp({ client: neon(databaseUrl) });
        return applyTenantMigrations(tenantDb, { statementBudget: MIGRATION_STATEMENTS_PER_STEP });
      });
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
      }, async () => svc.getGoldenSchemaVersion(shard));

      let goldenReady = goldenVersion === LATEST_SCHEMA_VERSION;
      if (!goldenReady) {
        const goldenUrl = await step.do(`${prefix}-golden-open`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, async () => svc.openGoldenForMigration(shard));

        if (goldenUrl) {
          const applied = await this.runMigrationBatches(step, `${prefix}-golden`, goldenUrl);
          console.log(`[RefillPool] Golden template on shard ${shard.id}: ${applied} migrations applied`);

          await step.do(`${prefix}-golden-seed`, {
            retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
          }, async () => this.seedWorkspaceAgnosticDefaults({ databaseUrl: goldenUrl }));

          goldenReady = await step.do(`${prefix}-golden-seal`, {
            retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
          }, async () => svc.sealGoldenTemplate(shard, LATEST_SCHEMA_VERSION!));
        }
      }

      if (goldenReady) {
        resources = await step.do(`${prefix}-clone`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, async () => svc.createWarmSharedSlotFromTemplate(shard));
      }

      // Legacy fallback: API-created empty database + full journal replay.
      if (!resources) {
        console.warn(`[RefillPool] Template path unavailable on shard ${shard.id}, falling back to journal replay`);
        resources = await step.do(`${prefix}-resources`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, async () => svc.createWarmSharedSlotResourcesOnShard(shard));
        if (resources) {
          const applied = await this.runMigrationBatches(step, prefix, resources.databaseUrl);
          console.log(`[RefillPool] Slot ${resources.poolId}: ${applied} migrations applied`);
        }
      }

      if (!resources) {
        await step.do(`${prefix}-release-capacity`, {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        }, async () => svc.releaseShardCapacity(getMasterDb(this.env), shard.id));
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
   */
  private async catchUpStaleSlots(step: WorkflowStep, region: string): Promise<number> {
    const stale = await step.do('find-stale-slots', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
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
      try {
        let applied = 0;
        for (let batch = 0; ; batch++) {
          const result = await step.do(`catch-up-${slot.id}-${batch}`, {
            retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' },
            timeout: '10 minutes',
          }, async () => {
            const tenantDb = drizzleNeonHttp({ client: neon(slot.databaseUrl) });
            return applyTenantMigrations(tenantDb, { statementBudget: MIGRATION_STATEMENTS_PER_STEP });
          });
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
        });

        console.log(`[RefillPool] Caught up slot ${slot.id} (+${applied} migrations)`);
        caughtUp++;
      } catch (error) {
        console.error(`[RefillPool] Failed to catch up slot ${slot.id}:`, error);
      }
    }
    return caughtUp;
  }
}

/**
 * Kick off refill runs (called from the worker's cron `scheduled` handler) —
 * one per region that needs a warm pool: the default region plus every region
 * that already has a shared shard (a shard existing there means tenants chose
 * that region during onboarding, so future signups there deserve warm slots
 * too). A short-TTL KV lock prevents a thundering herd of overlapping runs;
 * the per-step recount inside the workflow is the real overshoot guard.
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
  } catch (error) {
    console.warn('[RefillPool] Could not enumerate shard regions, refilling default region only:', error);
  }

  const stamp = Date.now();
  for (const region of regions) {
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
