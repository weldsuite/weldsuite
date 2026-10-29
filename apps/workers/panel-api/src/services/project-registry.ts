/**
 * Keeps what the public collector reads in step with a project: the master
 * `panel_project_registry` row and the KV record `panel:project:<token>`.
 *
 * The tenant `panel_projects` row is the source of truth; these are copies the
 * collector can reach without opening a tenant database (ADR DATA-008). Both
 * writes are idempotent, so a request that fails halfway is repaired by
 * repeating it (or by the next change to the project).
 */

import { eq, lte, sql } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import type { PanelProject } from '@weldsuite/db/schema';
import { projectKvKey, toProjectRecord } from '@weldsuite/panel-domain/registry';
import { withSettingDefaults } from '@weldsuite/panel-domain/settings';

const { panelProjectRegistry } = masterSchema;

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
  const record = toProjectRecord({ ...project, settings }, registry.workspaceId);
  await registry.kv.put(projectKvKey(project.token), JSON.stringify(record));

  // A newer change (or the deletion) that synced while this one ran wins:
  // leave KV as the registry says, whatever order the writes landed in.
  const after = await registryRow(registry, project.id);
  if (after && after.updatedAt > project.updatedAt) {
    if (after.deletedAt || after.token !== project.token) await registry.kv.delete(projectKvKey(project.token));
    if (!after.deletedAt) {
      const latest = toProjectRecord({ ...after, id: after.projectId }, after.workspaceId);
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
