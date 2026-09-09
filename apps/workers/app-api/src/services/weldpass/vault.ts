/**
 * WeldPass vault projects and environments.
 *
 * Every route that touches a secret starts here: resolve the project inside the
 * caller's workspace, then unwrap its KEK. A project belonging to another
 * workspace is simply not found, so an id from elsewhere reads as 404 rather
 * than 403 — nothing is confirmed to exist.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { createVaultKey, unwrapVaultKey, type RootKeyring } from './envelope';

/** Environments a new project starts with — the shape almost every repo wants. */
const DEFAULT_ENVIRONMENTS = [
  { name: 'Development', slug: 'development', isProduction: false, sortOrder: 0 },
  { name: 'Preview', slug: 'preview', isProduction: false, sortOrder: 1 },
  { name: 'Production', slug: 'production', isProduction: true, sortOrder: 2 },
];

export class VaultNotFoundError extends Error {
  constructor(
    readonly resource: 'project' | 'environment' | 'secret' | 'credential' | 'sync target',
    readonly id: string,
  ) {
    super(`${resource} ${id} not found`);
    this.name = 'VaultNotFoundError';
  }
}

const projects = schema.weldpassProjects;
const environments = schema.weldpassEnvironments;

/** Project columns safe to hand a client — the wrapped key stays server-side. */
const projectColumns = {
  id: projects.id,
  name: projects.name,
  slug: projects.slug,
  description: projects.description,
  rootKeyVersion: projects.rootKeyVersion,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

export type VaultProject = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  rootKeyVersion: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface EnvironmentRow {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  isProduction: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const environmentColumns = {
  id: environments.id,
  projectId: environments.projectId,
  name: environments.name,
  slug: environments.slug,
  isProduction: environments.isProduction,
  sortOrder: environments.sortOrder,
  createdAt: environments.createdAt,
  updatedAt: environments.updatedAt,
};

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(db: Database, workspaceId: string): Promise<VaultProject[]> {
  return db
    .select(projectColumns)
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
    .orderBy(asc(projects.name));
}

export async function findProjectBySlug(
  db: Database,
  workspaceId: string,
  slug: string,
): Promise<VaultProject | null> {
  const [row] = await db
    .select(projectColumns)
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        eq(projects.slug, slug),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Resolve a project in the caller's workspace, or throw a 404-shaped error. */
export async function requireProject(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<VaultProject> {
  const [row] = await db
    .select(projectColumns)
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.workspaceId, workspaceId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new VaultNotFoundError('project', projectId);
  return row;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string | null;
  createdBy: string;
}

/**
 * Create a project, its KEK, and its default environments.
 *
 * Neon's HTTP driver has no interactive transactions, so the writes are ordered
 * so that the worst interruption leaves a usable project with fewer
 * environments than intended, never a project whose key is missing.
 */
export async function createProject(
  db: Database,
  workspaceId: string,
  keyring: RootKeyring,
  input: CreateProjectInput,
): Promise<{ project: VaultProject; environments: EnvironmentRow[] }> {
  const id = generateId('wpp');
  const slug = slugify(input.slug ?? input.name);
  if (!slug) throw new Error('Project name must contain at least one letter or digit');

  const key = await createVaultKey(keyring, id);

  const [project] = await db
    .insert(projects)
    .values({
      id,
      workspaceId,
      name: input.name,
      slug,
      description: input.description ?? null,
      kekWrapped: key.kekWrapped,
      rootKeyVersion: key.rootKeyVersion,
      createdBy: input.createdBy,
    })
    .returning(projectColumns);

  const created = await db
    .insert(environments)
    .values(
      DEFAULT_ENVIRONMENTS.map((environment) => ({
        id: generateId('wpe'),
        projectId: id,
        ...environment,
      })),
    )
    .returning(environmentColumns);

  return { project, environments: created };
}

export async function updateProject(
  db: Database,
  workspaceId: string,
  projectId: string,
  patch: { name?: string; description?: string | null },
): Promise<VaultProject> {
  await requireProject(db, workspaceId, projectId);
  const [row] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .returning(projectColumns);
  return row;
}

export async function deleteProject(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  await requireProject(db, workspaceId, projectId);
  const now = new Date();
  await db
    .update(projects)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
}

/**
 * Resolve a project and unwrap its KEK in one step — what every secret route
 * needs. The key material lives only in this request's memory.
 */
export async function openVault(
  db: Database,
  workspaceId: string,
  keyring: RootKeyring,
  projectId: string,
): Promise<{ project: VaultProject; kek: Uint8Array<ArrayBuffer> }> {
  const project = await requireProject(db, workspaceId, projectId);

  // `requireProject` deliberately does not select the wrapped key, so it is
  // fetched only on the path that actually needs to decrypt.
  const [row] = await db
    .select({ kekWrapped: projects.kekWrapped })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) throw new VaultNotFoundError('project', projectId);

  return { project, kek: await unwrapVaultKey(keyring, project.id, row.kekWrapped) };
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export async function listEnvironments(
  db: Database,
  projectId: string,
): Promise<EnvironmentRow[]> {
  return db
    .select(environmentColumns)
    .from(environments)
    .where(and(eq(environments.projectId, projectId), isNull(environments.deletedAt)))
    .orderBy(asc(environments.sortOrder), asc(environments.name));
}

/**
 * Resolve an environment *within a project the caller already owns*. Taking the
 * project id rather than trusting the environment id alone is what keeps one
 * workspace from reading another's environment by guessing an id.
 */
export async function requireEnvironment(
  db: Database,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentRow> {
  const [row] = await db
    .select(environmentColumns)
    .from(environments)
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.projectId, projectId),
        isNull(environments.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new VaultNotFoundError('environment', environmentId);
  return row;
}

export async function createEnvironment(
  db: Database,
  projectId: string,
  input: { name: string; slug?: string; isProduction?: boolean },
): Promise<EnvironmentRow> {
  const existing = await listEnvironments(db, projectId);
  const [row] = await db
    .insert(environments)
    .values({
      id: generateId('wpe'),
      projectId,
      name: input.name,
      slug: slugify(input.slug ?? input.name),
      isProduction: input.isProduction ?? false,
      sortOrder: existing.length,
    })
    .returning(environmentColumns);
  return row;
}

export async function updateEnvironment(
  db: Database,
  projectId: string,
  environmentId: string,
  patch: { name?: string; isProduction?: boolean; sortOrder?: number },
): Promise<EnvironmentRow> {
  await requireEnvironment(db, projectId, environmentId);
  const [row] = await db
    .update(environments)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .returning(environmentColumns);
  return row;
}

/**
 * Soft-delete an environment and everything in it. The secrets stay encrypted
 * in place, so a mistaken delete is recoverable by clearing `deleted_at` — but
 * they stop being listed, exported, or synced immediately.
 */
export async function deleteEnvironment(
  db: Database,
  projectId: string,
  environmentId: string,
): Promise<void> {
  await requireEnvironment(db, projectId, environmentId);
  const now = new Date();

  await db
    .update(schema.weldpassSecrets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.weldpassSecrets.environmentId, environmentId),
        isNull(schema.weldpassSecrets.deletedAt),
      ),
    );

  await db
    .update(schema.weldpassSyncTargets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.weldpassSyncTargets.environmentId, environmentId),
        isNull(schema.weldpassSyncTargets.deletedAt),
      ),
    );

  await db
    .update(environments)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(environments.id, environmentId));
}
