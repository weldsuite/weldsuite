/**
 * WeldFlow project access resolution — context-free core shared between
 * flow-api's row-level guard (apps/workers/flow-api/src/lib/project-access.ts,
 * which wraps this with the caller's Hono context) and the WeldConnect
 * `create_task` action (connect-api's internal workflow-actions route),
 * which needs the same "may this user write to this project" check for the
 * workflow's owner but has no Hono context to read it from.
 *
 * See flow-api's project-access.ts for the full write-up of the role model;
 * this module only resolves it, `scopeAll` (the `projects:scope:all`
 * permission) is the caller's responsibility to compute.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

async function membership(db: Database, projectId: string, userId: string) {
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
 * The single source of truth for what a user may do on one project.
 *   admin — scope:all, the project manager, or an owner/admin member
 *   write — admin, or a 'member' role (viewers are read-only)
 *   read  — write, or a 'viewer' role
 * Roles are compared case-insensitively.
 *
 * @param userId - undefined (no authenticated caller, e.g. a schedule run
 *   with no owner) resolves to no access at all.
 * @param opts.scopeAll - whether the user holds `projects:scope:all`;
 *   computed by the caller (permission system / workflow-owner check).
 */
export async function resolveProjectAccess(
  db: Database,
  userId: string | undefined,
  opts: { scopeAll: boolean },
  projectId: string,
): Promise<ProjectAccess> {
  const { scopeAll } = opts;
  const { isManager, role: memberRole } = userId
    ? await membership(db, projectId, userId)
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

/** May this user WRITE to this project? See `resolveProjectAccess`. */
export async function canWriteProject(
  db: Database,
  userId: string | undefined,
  opts: { scopeAll: boolean },
  projectId: string,
): Promise<boolean> {
  return (await resolveProjectAccess(db, userId, opts, projectId)).canWrite;
}
