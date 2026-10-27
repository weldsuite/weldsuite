/**
 * Keeps what the public collector reads in step with a project: the master
 * `panel_project_registry` row and the KV record `panel:project:<token>`.
 *
 * The tenant `panel_projects` row is the source of truth; these are copies the
 * collector can reach without opening a tenant database (ADR DATA-008). Both
 * writes are idempotent, so a request that fails halfway is repaired by
 * repeating it (or by the next change to the project).
 */

import { eq } from 'drizzle-orm';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';
import type { PanelProject } from '@weldsuite/db/schema';
import { projectKvKey, toProjectRecord } from '@weldsuite/panel-domain/registry';
import { withSettingDefaults } from '@weldsuite/panel-domain/settings';

const { panelProjectRegistry } = masterSchema;

export interface ProjectRegistry {
  masterDb: AnyMasterDatabase;
  kv: Pick<KVNamespace, 'get' | 'put' | 'delete'>;
  /** `workspaces.id` (`ws_…`), never the Clerk org id (ADR SEC-011). */
  workspaceId: string;
}

/**
 * Upserts the registry row and the KV record for `project`. Pass the token the
 * project had before a rotation as `previousToken`: its KV key is deleted at
 * once, so the old token stops working without waiting for a cache to expire.
 */
export async function syncProjectRegistry(
  registry: ProjectRegistry,
  project: PanelProject,
  previousToken?: string,
): Promise<void> {
  const settings = withSettingDefaults(project.settings);
  const now = new Date();
  const row = {
    token: project.token,
    workspaceId: registry.workspaceId,
    status: project.status,
    allowedDomains: project.allowedDomains,
    settings,
    updatedAt: now,
    deletedAt: null,
  };

  await registry.masterDb
    .insert(panelProjectRegistry)
    .values({ projectId: project.id, ...row })
    .onConflictDoUpdate({ target: panelProjectRegistry.projectId, set: row });

  // No expiry: the collector reads only KV, so a lapsed key would drop the
  // project's traffic. Deleting is explicit (rotation, project deletion).
  const record = toProjectRecord({ ...project, settings }, registry.workspaceId);
  await registry.kv.put(projectKvKey(project.token), JSON.stringify(record));

  if (previousToken && previousToken !== project.token) {
    await registry.kv.delete(projectKvKey(previousToken));
  }
}

/** Marks the registry row deleted and drops the KV record, so the collector refuses the token. */
export async function removeProjectFromRegistry(registry: ProjectRegistry, project: PanelProject): Promise<void> {
  const now = new Date();
  await registry.masterDb
    .update(panelProjectRegistry)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(panelProjectRegistry.projectId, project.id));
  await registry.kv.delete(projectKvKey(project.token));
}
