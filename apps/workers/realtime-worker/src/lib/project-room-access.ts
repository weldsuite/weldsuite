/**
 * Project-membership gate for project-scoped rooms (whiteboards).
 *
 * The room key's ownership anchor is the project, and "the project exists in the
 * caller's tenant DB" only proves the caller's *workspace* owns it. The same rule
 * flow-api applies to the REST surface also has to hold here, or any workspace
 * member could watch and edit a whiteboard of a project they are not on.
 *
 * KEEP IN LOCKSTEP with `resolveProjectAccess` in
 * `packages/domains/flow/src/project-access.ts` (flow-api's `canAccessProject` /
 * `canWriteProject`):
 *   read  — `projects:scope:all` holder, the project manager, or an active member
 *           (any role; viewers included)
 *   write — read, except an active 'viewer' (or unknown) role, which is read-only
 *   a soft-deleted project grants nothing to anyone.
 * Roles compare case-insensitively.
 *
 * The realtime worker only has the Clerk org role, not the permission catalog, so
 * `scopeAll` is approximated by the org role `owner` / `admin` (the roles that
 * hold `projects:scope:all` by default). A member with scope:all through a custom
 * role is therefore treated as an ordinary member here.
 */

import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import type { TenantDatabase } from './db';

export interface RoomAccess {
  canRead: boolean;
  canWrite: boolean;
}

const NO_ACCESS: RoomAccess = { canRead: false, canWrite: false };

/** The pure rule: what a caller may do given how they relate to the project. */
export function roomAccessFor(input: {
  scopeAll: boolean;
  isManager: boolean;
  /** The active member row's role, undefined when the caller is not an active member. */
  memberRole: string | undefined;
}): RoomAccess {
  const role = (input.memberRole ?? '').toLowerCase();
  const isMember = input.memberRole !== undefined;
  const canRead = input.scopeAll || input.isManager || isMember;
  const canWrite =
    input.scopeAll || input.isManager || role === 'owner' || role === 'admin' || role === 'member';
  return { canRead, canWrite: canRead && canWrite };
}

/** Whether a Clerk org role (`owner` / `admin` / `member` / ...) holds `projects:scope:all` by default. */
export function orgRoleHasScopeAll(orgRole: string): boolean {
  return orgRole === 'owner' || orgRole === 'admin';
}

/** Resolve the caller's access to one project from the tenant DB. */
export async function resolveProjectRoomAccess(
  db: TenantDatabase,
  caller: { userId: string; orgRole: string },
  projectId: string,
): Promise<RoomAccess> {
  const [[project], [member]] = await Promise.all([
    db
      .select({ managerId: schema.projects.projectManagerId, deletedAt: schema.projects.deletedAt })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1),
    db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, caller.userId),
          eq(schema.projectMembers.isActive, true),
          isNull(schema.projectMembers.deletedAt),
        ),
      )
      .limit(1),
  ]);
  if (!project || project.deletedAt) return NO_ACCESS;
  return roomAccessFor({
    scopeAll: orgRoleHasScopeAll(caller.orgRole),
    isManager: !!project.managerId && project.managerId === caller.userId,
    memberRole: member?.role,
  });
}
