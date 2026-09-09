/**
 * WeldPass sync targets and pushes.
 *
 * A push decrypts an environment, hands the plaintext to a provider, and
 * records what happened. The decrypted map exists only for the duration of the
 * call and is never logged, returned, or stored — the run record keeps key
 * names and outcomes only.
 */

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type {
  WeldPassProvider,
  WeldPassSyncRunDetail,
  WeldPassSyncStatus,
  WeldPassSyncTargetConfig,
} from '@weldsuite/db/schema/weldpass';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { readCredentialToken } from './credentials';
import { getProvider, ProviderError } from './providers';
import { readEnvironmentValues } from './secrets';
import { VaultNotFoundError } from './vault';

const targets = schema.weldpassSyncTargets;
const runs = schema.weldpassSyncRuns;

export interface SyncTargetSummary {
  id: string;
  projectId: string;
  environmentId: string;
  credentialId: string;
  provider: WeldPassProvider;
  name: string;
  config: WeldPassSyncTargetConfig;
  autoSync: boolean;
  prune: boolean;
  status: string;
  lastSyncedAt: Date | null;
  lastSyncedCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncRunSummary {
  id: string;
  targetId: string;
  environmentId: string;
  status: string;
  trigger: string;
  pushed: number;
  removed: number;
  failed: number;
  error: string | null;
  details: WeldPassSyncRunDetail[];
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const targetColumns = {
  id: targets.id,
  projectId: targets.projectId,
  environmentId: targets.environmentId,
  credentialId: targets.credentialId,
  provider: targets.provider,
  name: targets.name,
  config: targets.config,
  autoSync: targets.autoSync,
  prune: targets.prune,
  status: targets.status,
  lastSyncedAt: targets.lastSyncedAt,
  lastSyncedCount: targets.lastSyncedCount,
  lastError: targets.lastError,
  createdAt: targets.createdAt,
  updatedAt: targets.updatedAt,
};

const runColumns = {
  id: runs.id,
  targetId: runs.targetId,
  environmentId: runs.environmentId,
  status: runs.status,
  trigger: runs.trigger,
  pushed: runs.pushed,
  removed: runs.removed,
  failed: runs.failed,
  error: runs.error,
  details: runs.details,
  triggeredBy: runs.triggeredBy,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

export async function listSyncTargets(
  db: Database,
  projectId: string,
  environmentId?: string,
): Promise<SyncTargetSummary[]> {
  const where = environmentId
    ? and(
        eq(targets.projectId, projectId),
        eq(targets.environmentId, environmentId),
        isNull(targets.deletedAt),
      )
    : and(eq(targets.projectId, projectId), isNull(targets.deletedAt));

  return db.select(targetColumns).from(targets).where(where).orderBy(asc(targets.name));
}

export async function requireSyncTarget(
  db: Database,
  projectId: string,
  targetId: string,
): Promise<SyncTargetSummary> {
  const [row] = await db
    .select(targetColumns)
    .from(targets)
    .where(
      and(eq(targets.id, targetId), eq(targets.projectId, projectId), isNull(targets.deletedAt)),
    )
    .limit(1);
  if (!row) throw new VaultNotFoundError('sync target', targetId);
  return row;
}

export async function createSyncTarget(
  db: Database,
  input: {
    projectId: string;
    environmentId: string;
    credentialId: string;
    provider: WeldPassProvider;
    name: string;
    config: WeldPassSyncTargetConfig;
    autoSync?: boolean;
    prune?: boolean;
    actorId: string;
  },
): Promise<SyncTargetSummary> {
  const [row] = await db
    .insert(targets)
    .values({
      id: generateId('wpt'),
      projectId: input.projectId,
      environmentId: input.environmentId,
      credentialId: input.credentialId,
      provider: input.provider,
      name: input.name,
      config: input.config,
      autoSync: input.autoSync ?? false,
      prune: input.prune ?? false,
      createdBy: input.actorId,
    })
    .returning(targetColumns);
  return row;
}

export async function updateSyncTarget(
  db: Database,
  projectId: string,
  targetId: string,
  patch: {
    name?: string;
    config?: WeldPassSyncTargetConfig;
    credentialId?: string;
    autoSync?: boolean;
    prune?: boolean;
  },
): Promise<SyncTargetSummary> {
  await requireSyncTarget(db, projectId, targetId);
  const [row] = await db
    .update(targets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(targets.id, targetId))
    .returning(targetColumns);
  return row;
}

export async function deleteSyncTarget(
  db: Database,
  projectId: string,
  targetId: string,
): Promise<void> {
  await requireSyncTarget(db, projectId, targetId);
  const now = new Date();
  await db
    .update(targets)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(targets.id, targetId));
}

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

export interface PushOutcome {
  run: SyncRunSummary;
  target: SyncTargetSummary;
}

/**
 * Push one environment to one target.
 *
 * The run row is written before the provider is called, so a push that times
 * out or crashes the isolate still leaves a `running` record rather than
 * vanishing — an operator can see that something was attempted.
 */
export async function pushToTarget(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: {
    projectId: string;
    targetId: string;
    trigger: 'manual' | 'auto';
    actorId: string;
  },
): Promise<PushOutcome> {
  const target = await requireSyncTarget(db, input.projectId, input.targetId);
  const runId = generateId('wpr');

  await db.insert(runs).values({
    id: runId,
    targetId: target.id,
    projectId: input.projectId,
    environmentId: target.environmentId,
    status: 'running',
    trigger: input.trigger,
    triggeredBy: input.actorId,
    startedAt: new Date(),
  });

  await db
    .update(targets)
    .set({ status: 'running', updatedAt: new Date() })
    .where(eq(targets.id, target.id));

  try {
    const token = await readCredentialToken(db, kek, input.projectId, target.credentialId);
    const secrets = await readEnvironmentValues(db, kek, target.environmentId);

    const result = await getProvider(target.provider).push({
      token,
      config: target.config,
      secrets,
      prune: target.prune,
    });

    const status: WeldPassSyncStatus = result.failed > 0 ? 'partial' : 'success';
    const run = await finishRun(db, runId, {
      status,
      pushed: result.pushed,
      removed: result.removed,
      failed: result.failed,
      error:
        result.failed > 0
          ? `${result.failed} of ${result.pushed + result.failed} values were rejected`
          : null,
      details: result.details,
    });

    const updatedTarget = await markTarget(db, target.id, {
      status,
      lastSyncedAt: new Date(),
      lastSyncedCount: result.pushed,
      lastError: run.error,
    });

    return { run, target: updatedTarget };
  } catch (err) {
    const message =
      err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err);

    const run = await finishRun(db, runId, {
      status: 'failed',
      pushed: 0,
      removed: 0,
      failed: 0,
      error: message,
      details: [],
    });

    const updatedTarget = await markTarget(db, target.id, {
      status: 'failed',
      lastError: message,
    });

    return { run, target: updatedTarget };
  }
}

/**
 * Push every auto-sync target for an environment. Called after a secret write.
 * One failing target does not stop the others — each records its own run.
 */
export async function pushAutoTargets(
  db: Database,
  kek: Uint8Array<ArrayBuffer>,
  input: { projectId: string; environmentId: string; actorId: string },
): Promise<PushOutcome[]> {
  const auto = await db
    .select({ id: targets.id })
    .from(targets)
    .where(
      and(
        eq(targets.projectId, input.projectId),
        eq(targets.environmentId, input.environmentId),
        eq(targets.autoSync, true),
        isNull(targets.deletedAt),
      ),
    );

  const outcomes: PushOutcome[] = [];
  for (const { id } of auto) {
    outcomes.push(
      await pushToTarget(db, kek, {
        projectId: input.projectId,
        targetId: id,
        trigger: 'auto',
        actorId: input.actorId,
      }),
    );
  }
  return outcomes;
}

export async function listSyncRuns(
  db: Database,
  projectId: string,
  options: { targetId?: string; limit?: number } = {},
): Promise<SyncRunSummary[]> {
  const where = options.targetId
    ? and(eq(runs.projectId, projectId), eq(runs.targetId, options.targetId))
    : eq(runs.projectId, projectId);

  return db
    .select(runColumns)
    .from(runs)
    .where(where)
    .orderBy(desc(runs.startedAt))
    .limit(options.limit ?? 25);
}

async function finishRun(
  db: Database,
  runId: string,
  result: {
    status: WeldPassSyncStatus;
    pushed: number;
    removed: number;
    failed: number;
    error: string | null;
    details: WeldPassSyncRunDetail[];
  },
): Promise<SyncRunSummary> {
  const [row] = await db
    .update(runs)
    .set({ ...result, finishedAt: new Date() })
    .where(eq(runs.id, runId))
    .returning(runColumns);
  return row;
}

async function markTarget(
  db: Database,
  targetId: string,
  patch: {
    status: WeldPassSyncStatus;
    lastSyncedAt?: Date;
    lastSyncedCount?: number;
    lastError: string | null;
  },
): Promise<SyncTargetSummary> {
  const [row] = await db
    .update(targets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(targets.id, targetId))
    .returning(targetColumns);
  return row;
}
