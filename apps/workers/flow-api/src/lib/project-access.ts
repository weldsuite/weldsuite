/**
 * WeldFlow project access guard (row-level / BOLA boundary).
 *
 * The object-level `projects:*` permission gates the *feature*, not the row.
 * The real boundary is project membership: a user may only act on projects they
 * manage or are an active member of — unless they hold `projects:scope:all`
 * (owners/admins), which bypasses the membership boundary workspace-wide.
 *
 * Reads use `canAccessProject` (any active member, viewers included). Mutations
 * use `canWriteProject` / `canWriteTaskProject`: the project 'viewer' role is
 * read-only. Reuse these in every by-id / :projectId / sub-resource handler under
 * WeldFlow (projects, project-members, tasks, sprints, milestones, …) so the
 * boundary is enforced consistently, not just on the list endpoint.
 */

import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { hasContextPermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../types';
import { schema } from '@weldsuite/worker-kit/db';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

async function callerContext(c: Ctx) {
  const userId = c.get('userId') as string | undefined;
  const scopeAll = await hasContextPermission(c, 'projects:scope:all');
  return { userId, scopeAll };
}

async function membership(c: Ctx, projectId: string, userId: string) {
  const db = c.get('tenantDb');
  const [[proj], [member]] = await Promise.all([
    db
      .select({ managerId: schema.projects.projectManagerId })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1),
    db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, userId),
          eq(schema.projectMembers.isActive, true),
          isNull(schema.projectMembers.deletedAt),
        ),
      )
      .limit(1),
  ]);
  return { isManager: !!proj?.managerId && proj.managerId === userId, role: member?.role };
}

export interface ProjectAccess {
  /** Effective role: the member row's role (lowercased), else 'owner' for the project manager. */
  role: string | null;
  isManager: boolean;
  scopeAll: boolean;
  /** An active member row exists (any role, including unknown ones). */
  isMember: boolean;
  canRead: boolean;
  canWrite: boolean;
  isAdmin: boolean;
}

/**
 * The single source of truth for what a caller may do on one project. The write
 * guards below and `GET /projects/:id/permissions` both use it, so the flags the
 * UI shows and the API enforcement cannot drift.
 *   admin — scope:all, the project manager, or an owner/admin member
 *   write — admin, or a 'member' role (viewers are read-only)
 *   read  — write, or a 'viewer' role
 * Roles are compared case-insensitively.
 */
export async function resolveProjectAccess(c: Ctx, projectId: string): Promise<ProjectAccess> {
  const { userId, scopeAll } = await callerContext(c);
  const { isManager, role: memberRole } = userId
    ? await membership(c, projectId, userId)
    : { isManager: false, role: undefined };
  const projectRole = (memberRole ?? '').toLowerCase() || null;
  const role = projectRole ?? (isManager ? 'owner' : null);
  const isAdmin = scopeAll || isManager || role === 'owner' || role === 'admin';
  const canWrite = isAdmin || role === 'member';
  const canRead = canWrite || role === 'viewer';
  return {
    role,
    isManager,
    scopeAll,
    isMember: memberRole !== undefined,
    canRead,
    canWrite,
    isAdmin,
  };
}

/**
 * May the caller READ / act on this project at all? True for scope:all holders,
 * the project manager, or any active member (viewers included).
 */
export async function canAccessProject(c: Ctx, projectId: string): Promise<boolean> {
  const access = await resolveProjectAccess(c, projectId);
  return access.scopeAll || access.isManager || access.isMember;
}

/**
 * May the caller WRITE to this project — create / edit / delete its tasks and
 * sub-resources? True for scope:all holders, the project manager, and active
 * owner/admin/member roles. Viewers can read but not write.
 */
export async function canWriteProject(c: Ctx, projectId: string): Promise<boolean> {
  return (await resolveProjectAccess(c, projectId)).canWrite;
}

/**
 * May the caller MANAGE this project — edit/delete it, and add/remove/promote
 * members? True for scope:all holders, the project manager, or an active
 * owner/admin member. Plain members and viewers cannot.
 */
export async function canManageProject(c: Ctx, projectId: string): Promise<boolean> {
  return (await resolveProjectAccess(c, projectId)).isAdmin;
}

async function findTaskProject(
  c: Ctx,
  taskId: string,
): Promise<{ found: false } | { found: true; projectId: string | null }> {
  const db = c.get('tenantDb');
  const [task] = await db
    .select({ projectId: schema.tasks.projectId, deletedAt: schema.tasks.deletedAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  if (!task || task.deletedAt) return { found: false };
  return { found: true, projectId: task.projectId };
}

/**
 * Task access via its parent project. Tasks with a null `projectId` are
 * personal / CRM tasks (not project-scoped) — allowed here; their own boundary
 * (owner/assignee) is separate. Returns:
 *   'not-found' — missing/deleted task (caller should 404)
 *   'denied'    — project task the caller is not a member/manager of
 *   'ok'        — personal task, or a project the caller may act on
 */
export async function canAccessTaskProject(
  c: Ctx,
  taskId: string,
): Promise<'ok' | 'denied' | 'not-found'> {
  const task = await findTaskProject(c, taskId);
  if (!task.found) return 'not-found';
  if (!task.projectId) return 'ok';
  return (await canAccessProject(c, task.projectId)) ? 'ok' : 'denied';
}

/**
 * Same contract as `canAccessTaskProject`, for mutations: a project task is 'ok'
 * only when the caller may WRITE to its project (viewers get 'denied'). Personal
 * tasks (null `projectId`) stay 'ok'.
 */
export async function canWriteTaskProject(
  c: Ctx,
  taskId: string,
): Promise<'ok' | 'denied' | 'not-found'> {
  const task = await findTaskProject(c, taskId);
  if (!task.found) return 'not-found';
  if (!task.projectId) return 'ok';
  return (await canWriteProject(c, task.projectId)) ? 'ok' : 'denied';
}

/**
 * The set of project IDs the caller may access — for constraining list queries.
 * Returns `null` when the caller holds `projects:scope:all` (no constraint;
 * every project). Otherwise the ids of projects they manage or actively belong
 * to (empty array = access nothing).
 */
export async function accessibleProjectIds(c: Ctx): Promise<string[] | null> {
  const { userId, scopeAll } = await callerContext(c);
  if (scopeAll) return null;
  if (!userId) return [];
  const db = c.get('tenantDb');
  const [managed, memberOf] = await Promise.all([
    db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.projectManagerId, userId)),
    db
      .select({ projectId: schema.projectMembers.projectId })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.userId, userId),
          eq(schema.projectMembers.isActive, true),
          isNull(schema.projectMembers.deletedAt),
        ),
      ),
  ]);
  const ids = new Set<string>();
  for (const m of managed) ids.add(m.id);
  for (const m of memberOf) ids.add(m.projectId);
  return [...ids];
}
