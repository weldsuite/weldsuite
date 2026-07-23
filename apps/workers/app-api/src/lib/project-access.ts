/**
 * WeldFlow project access guard (row-level / BOLA boundary).
 *
 * The object-level `projects:*` permission gates the *feature*, not the row.
 * The real boundary is project membership: a user may only act on projects they
 * manage or are an active member of — unless they hold `projects:scope:all`
 * (owners/admins), which bypasses the membership boundary workspace-wide.
 *
 * Reuse these in every by-id / :projectId / sub-resource handler under WeldFlow
 * (projects, project-members, tasks, sprints, milestones, …) so the boundary is
 * enforced consistently, not just on the list endpoint.
 */

import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import type { Env, Variables } from '../types';
import { schema } from '../db';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

async function callerContext(c: Ctx) {
  const userId = c.get('userId') as string | undefined;
  const resolved = await ensurePermissionsResolved(c);
  const scopeAll = hasPermission(resolved?.permissions ?? [], 'projects:scope:all');
  return { userId, scopeAll };
}

async function membership(c: Ctx, projectId: string, userId: string) {
  const db = c.get('tenantDb');
  const [proj] = await db
    .select({ managerId: schema.projects.projectManagerId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  const [member] = await db
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
    .limit(1);
  return { isManager: !!proj?.managerId && proj.managerId === userId, role: member?.role };
}

/**
 * May the caller READ / act on this project at all? True for scope:all holders,
 * the project manager, or any active member.
 */
export async function canAccessProject(c: Ctx, projectId: string): Promise<boolean> {
  const { userId, scopeAll } = await callerContext(c);
  if (scopeAll) return true;
  if (!userId) return false;
  const { isManager, role } = await membership(c, projectId, userId);
  return isManager || role !== undefined;
}

/**
 * May the caller MANAGE this project — edit/delete it, and add/remove/promote
 * members? True for scope:all holders, the project manager, or an active
 * owner/admin member. Plain members and viewers cannot.
 */
export async function canManageProject(c: Ctx, projectId: string): Promise<boolean> {
  const { userId, scopeAll } = await callerContext(c);
  if (scopeAll) return true;
  if (!userId) return false;
  const { isManager, role } = await membership(c, projectId, userId);
  return isManager || role === 'owner' || role === 'admin';
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
  const db = c.get('tenantDb');
  const [task] = await db
    .select({ projectId: schema.tasks.projectId, deletedAt: schema.tasks.deletedAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  if (!task || task.deletedAt) return 'not-found';
  if (!task.projectId) return 'ok';
  return (await canAccessProject(c, task.projectId)) ? 'ok' : 'denied';
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

/**
 * Access check for a WeldFlow sub-resource row identified by `id` in `table`.
 * `table` must expose `id`, `projectId`, and `deletedAt` columns (the generic
 * shape of sprints/goals/milestones/whiteboards/project-files/messages/etc.).
 *   'not-found' — missing/deleted row (caller should 404)
 *   'denied'    — belongs to a project the caller can't access
 *   'ok'        — null projectId, or an accessible project
 */
export async function canAccessSubresourceProject(
  c: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  id: string,
): Promise<'ok' | 'denied' | 'not-found'> {
  const db = c.get('tenantDb');
  const [row] = await db
    .select({ projectId: table.projectId, deletedAt: table.deletedAt })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (!row || row.deletedAt) return 'not-found';
  if (!row.projectId) return 'ok';
  return (await canAccessProject(c, row.projectId)) ? 'ok' : 'denied';
}
