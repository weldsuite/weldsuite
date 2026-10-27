/**
 * WeldPanel projects: the tenant `panel_projects` rows, and the registry sync
 * every change triggers (./project-registry).
 *
 * Pure functions: no Hono context. The tenant DB is the workspace's own, so
 * every query is already scoped to it; a project id from another workspace is
 * simply not found.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelProject } from '@weldsuite/db/schema';
import { seenKvKey } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS, withSettingDefaults } from '@weldsuite/panel-domain/settings';
import { generateProjectToken } from '@weldsuite/panel-domain/tokens';
import { DEFAULT_HOST, installSnippet, trimTrailingSlashes } from '@weldsuite/panel-sdk/install';
import type {
  CreatePanelProjectInput,
  PanelInstallInfo,
  PanelProjectDto,
  UpdatePanelProjectInput,
  UpdatePanelProjectSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import { removeProjectFromRegistry, syncProjectRegistry, type ProjectRegistry } from './project-registry';

const { panelProjects } = schema;

/** A project with an event this recent shows as `receiving` in the install panel. */
const RECEIVING_WINDOW_MS = 24 * 60 * 60 * 1000;

const live = isNull(panelProjects.deletedAt);

export function toProjectDto(project: PanelProject): PanelProjectDto {
  return {
    id: project.id,
    name: project.name,
    kind: project.kind,
    status: project.status,
    token: project.token,
    allowedDomains: project.allowedDomains,
    settings: withSettingDefaults(project.settings),
    createdByUserId: project.createdByUserId,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_project` entity event: no token, no settings. */
export function projectEventData(project: PanelProject) {
  return { id: project.id, name: project.name, kind: project.kind, status: project.status };
}

export async function listProjects(db: Database): Promise<PanelProject[]> {
  return db.select().from(panelProjects).where(live).orderBy(asc(panelProjects.createdAt), asc(panelProjects.id));
}

export async function getProject(db: Database, id: string): Promise<PanelProject | null> {
  const [project] = await db
    .select()
    .from(panelProjects)
    .where(and(eq(panelProjects.id, id), live))
    .limit(1);
  return project ?? null;
}

export async function createProject(
  db: Database,
  registry: ProjectRegistry,
  input: Required<CreatePanelProjectInput>,
  createdByUserId: string,
): Promise<PanelProject> {
  const [project] = await db
    .insert(panelProjects)
    .values({
      id: generateId('pnp'),
      name: input.name,
      kind: input.kind,
      status: 'active',
      token: generateProjectToken(),
      allowedDomains: unique(input.allowedDomains),
      settings: { ...DEFAULT_PANEL_SETTINGS },
      createdByUserId,
    })
    .returning();
  if (!project) throw new Error('panel_projects insert returned no row');

  try {
    await syncProjectRegistry(registry, project);
  } catch (err) {
    // A project the collector cannot see would sit in the list receiving
    // nothing. Nobody has its token yet, so take it back out of both.
    const cleanup = await Promise.allSettled([
      removeProjectFromRegistry(registry, project),
      db.delete(panelProjects).where(eq(panelProjects.id, project.id)),
    ]);
    for (const step of cleanup) {
      if (step.status === 'rejected') console.error('[panel-api] cleanup after a failed project registration:', step.reason);
    }
    throw err;
  }
  return project;
}

/** Name, kind and allowed domains. Null when the project does not exist. */
export async function updateProject(
  db: Database,
  registry: ProjectRegistry,
  id: string,
  patch: UpdatePanelProjectInput,
): Promise<PanelProject | null> {
  const [project] = await db
    .update(panelProjects)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(patch.allowedDomains !== undefined && { allowedDomains: unique(patch.allowedDomains) }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelProjects.id, id), live))
    .returning();
  if (!project) return null;

  await syncProjectRegistry(registry, project);
  return project;
}

/** Pausing and the collector and privacy settings. Null when the project does not exist. */
export async function updateProjectSettings(
  db: Database,
  registry: ProjectRegistry,
  id: string,
  patch: UpdatePanelProjectSettingsInput,
): Promise<PanelProject | null> {
  const [project] = await db
    .update(panelProjects)
    .set({
      ...(patch.status !== undefined && { status: patch.status }),
      // Merged in the database, so two admins changing different settings at
      // once do not overwrite each other.
      ...(patch.settings !== undefined && {
        settings: sql`${panelProjects.settings} || ${JSON.stringify(patch.settings)}::jsonb`,
      }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelProjects.id, id), live))
    .returning();
  if (!project) return null;

  await syncProjectRegistry(registry, project);
  return project;
}

export type RotateTokenResult = { project: PanelProject } | 'not_found' | 'conflict';

/**
 * Issues a new token. The update only applies while the row still carries the
 * token that was read, so two rotations racing cannot leave a token in KV that
 * no row owns: the loser gets `conflict` and can look again.
 */
export async function rotateProjectToken(
  db: Database,
  registry: ProjectRegistry,
  id: string,
): Promise<RotateTokenResult> {
  const current = await getProject(db, id);
  if (!current) return 'not_found';

  const [project] = await db
    .update(panelProjects)
    .set({ token: generateProjectToken(), updatedAt: new Date() })
    .where(and(eq(panelProjects.id, id), eq(panelProjects.token, current.token), live))
    .returning();
  if (!project) return (await getProject(db, id)) ? 'conflict' : 'not_found';

  await syncProjectRegistry(registry, project, current.token);
  return { project };
}

/** Soft delete: the row stays (for audit and the unique token), the collector stops accepting it. */
export async function deleteProject(
  db: Database,
  registry: ProjectRegistry,
  id: string,
): Promise<PanelProject | null> {
  const now = new Date();
  const [project] = await db
    .update(panelProjects)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(panelProjects.id, id), live))
    .returning();
  if (!project) return null;

  await removeProjectFromRegistry(registry, project);
  return project;
}

/**
 * The install panel: snippets for the project, and whether the collector has
 * accepted an event lately (it stamps KV `panel:seen:<id>` every few minutes).
 */
export async function loadInstallInfo(
  kv: Pick<KVNamespace, 'get'>,
  project: PanelProject,
  collectorUrl: string,
  now: Date = new Date(),
): Promise<PanelInstallInfo> {
  const origin = trimTrailingSlashes(collectorUrl);
  const seen = await kv.get(seenKvKey(project.id));
  const seenAt = seen ? new Date(seen) : null;
  const lastEventAt = seenAt && !Number.isNaN(seenAt.getTime()) ? seenAt : null;
  const receiving = lastEventAt !== null && now.getTime() - lastEventAt.getTime() <= RECEIVING_WINDOW_MS;

  return {
    projectId: project.id,
    token: project.token,
    collectorUrl: origin,
    // The SDK's own snippet: the stub that queues calls made before /s.js
    // loads, then the async loader, so the two can't drift apart.
    scriptSnippet: installSnippet(project.token, origin),
    npmSnippet: [
      "import { init } from '@weldsuite/panel-sdk';",
      '',
      origin === DEFAULT_HOST
        ? `init({ token: '${project.token}' });`
        : `init({ token: '${project.token}', host: '${origin}' });`,
    ].join('\n'),
    lastEventAt: lastEventAt?.toISOString() ?? null,
    status: receiving ? 'receiving' : 'waiting',
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
