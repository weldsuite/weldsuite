/**
 * Keeps what the public collector reads in step with a project: the master
 * `panel_project_registry` row and the KV record `panel:project:<token>`.
 *
 * The tenant `panel_projects` row is the source of truth; these are copies the
 * collector can reach without opening a tenant database (ADR DATA-008). Both
 * writes are idempotent, so a request that fails halfway is repaired by
 * repeating it (or by the next change to the project).
 */

import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import type { PanelProject } from '@weldsuite/db/schema';
import type { PanelPlanLimits } from '@weldsuite/panel-domain/plans';
import { PANEL_KV_PREFIX, parseProjectRecord, projectKvKey, toProjectRecord, type PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import { withSettingDefaults } from '@weldsuite/panel-domain/settings';
import { loadWorkspacePlan } from './workspace-plan';

const { panelProjectRegistry } = masterSchema;

/** `panel:tier:<workspaceId>` → the replay tier last written into the workspace's project records. */
export const tierKvKey = (workspaceId: string): string => `${PANEL_KV_PREFIX}tier:${workspaceId}`;

/** The record with the workspace's replay tier: `90d` is written, `30d` is the default and left out. */
function withReplayTier(record: PanelProjectRecord, tier: PanelPlanLimits['replayTier']): PanelProjectRecord {
  const next = { ...record };
  if (tier === '90d') next.replayTier = tier;
  else delete next.replayTier;
  return next;
}

async function replayTierOf(registry: ProjectRegistry): Promise<PanelPlanLimits['replayTier']> {
  return (await loadWorkspacePlan(registry.masterDb, registry.workspaceId))?.limits.replayTier ?? '30d';
}

type RegistryRow = typeof panelProjectRegistry.$inferSelect;

export interface ProjectRegistry {
  masterDb: AnyMasterDatabase;
  kv: Pick<KVNamespace, 'get' | 'put' | 'delete'>;
  /** `workspaces.id` (`ws_…`), never the Clerk org id (ADR SEC-011). */
  workspaceId: string;
}

async function registryRow(registry: ProjectRegistry, projectId: string): Promise<RegistryRow | undefined> {
  const [row] = await registry.masterDb
    .select()
    .from(panelProjectRegistry)
    .where(eq(panelProjectRegistry.projectId, projectId))
    .limit(1);
  return row;
}

/** Deletes the KV records of `tokens`, each once, except `keep`'s. */
async function deleteTokens(registry: ProjectRegistry, tokens: Array<string | undefined>, keep?: string): Promise<void> {
  const retired = new Set(tokens.filter((token): token is string => !!token && token !== keep));
  for (const token of retired) await registry.kv.delete(projectKvKey(token));
}

/**
 * Upserts the registry row and the KV record for `project`, and deletes the KV
 * record of every token it no longer uses: `previousToken` (the one a rotation
 * replaced) and the one the registry still names, which an earlier sync that
 * failed halfway leaves behind. Old tokens stop working at once, without
 * waiting for a cache to expire.
 *
 * The registry row carries the project's `updatedAt`, and a sync of an older
 * version changes nothing: a PATCH that read the project before a rotation
 * cannot bring the rotated token back.
 */
export async function syncProjectRegistry(
  registry: ProjectRegistry,
  project: PanelProject,
  previousToken?: string,
): Promise<void> {
  const before = await registryRow(registry, project.id);
  if (before && before.updatedAt > project.updatedAt) return;

  // Before the registry row moves on, so a retry still finds them.
  await deleteTokens(registry, [previousToken, before?.token], project.token);

  const settings = withSettingDefaults(project.settings);
  const row = {
    token: project.token,
    workspaceId: registry.workspaceId,
    status: project.status,
    allowedDomains: project.allowedDomains,
    settings,
    updatedAt: project.updatedAt,
    deletedAt: null,
  };
  const [written] = await registry.masterDb
    .insert(panelProjectRegistry)
    .values({ projectId: project.id, ...row })
    .onConflictDoUpdate({
      target: panelProjectRegistry.projectId,
      set: row,
      setWhere: lte(panelProjectRegistry.updatedAt, project.updatedAt),
    })
    .returning({ projectId: panelProjectRegistry.projectId });
  // A newer version was synced meanwhile, and publishes itself.
  if (!written) return;

  // No expiry: the collector reads only KV, so a lapsed key would drop the
  // project's traffic. Deleting is explicit (rotation, project deletion).
  const tier = await replayTierOf(registry);
  const record = withReplayTier(toProjectRecord({ ...project, settings }, registry.workspaceId), tier);
  await registry.kv.put(projectKvKey(project.token), JSON.stringify(record));

  // A newer change (or the deletion) that synced while this one ran wins:
  // leave KV as the registry says, whatever order the writes landed in.
  const after = await registryRow(registry, project.id);
  if (after && after.updatedAt > project.updatedAt) {
    if (after.deletedAt || after.token !== project.token) await registry.kv.delete(projectKvKey(project.token));
    if (!after.deletedAt) {
      const latest = withReplayTier(toProjectRecord({ ...after, id: after.projectId }, after.workspaceId), tier);
      await registry.kv.put(projectKvKey(after.token), JSON.stringify(latest));
    }
  }
}

/**
 * Marks the registry row deleted and drops the KV records of the project's
 * token and of the one the registry names, so the collector refuses both.
 * Safe to repeat.
 */
export async function removeProjectFromRegistry(registry: ProjectRegistry, project: PanelProject): Promise<void> {
  const before = await registryRow(registry, project.id);
  // Marked first: a sync still running sees the deletion and takes back what it put.
  // The deleted row's `updatedAt` is its last version, so no earlier sync applies after this.
  await registry.masterDb
    .update(panelProjectRegistry)
    .set({
      deletedAt: new Date(),
      updatedAt: sql`greatest(${panelProjectRegistry.updatedAt}, ${project.updatedAt.toISOString()}::timestamptz)`,
    })
    .where(eq(panelProjectRegistry.projectId, project.id));
  await deleteTokens(registry, [project.token, before?.token]);
}

/**
 * Brings the KV records of a workspace's projects in step with its plan's
 * replay tier (a plan change takes effect without anyone touching a project).
 * Checked against `panel:tier:<workspace>` first, so the usual call is one KV
 * read; a failed run leaves the marker alone and is repeated by the next one.
 */
export async function applyReplayTier(
  deps: Pick<ProjectRegistry, 'masterDb' | 'kv'>,
  workspaceId: string,
  tier: PanelPlanLimits['replayTier'],
): Promise<void> {
  if ((await deps.kv.get(tierKvKey(workspaceId))) === tier) return;
  const rows = await deps.masterDb
    .select({ token: panelProjectRegistry.token })
    .from(panelProjectRegistry)
    .where(and(eq(panelProjectRegistry.workspaceId, workspaceId), isNull(panelProjectRegistry.deletedAt)));
  for (const { token } of rows) {
    const record = parseProjectRecord(await deps.kv.get(projectKvKey(token)));
    if (!record || record.replayTier === (tier === '90d' ? tier : undefined)) continue;
    await deps.kv.put(projectKvKey(token), JSON.stringify(withReplayTier(record, tier)));
  }
  await deps.kv.put(tierKvKey(workspaceId), tier);
}
