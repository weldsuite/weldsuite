/**
 * The apps a workspace member can open.
 *
 * The platform gates each module layout on this list
 * (GET /api/dashboard/installed-apps → useAppAccess), and search uses it to
 * link a record into a module the member actually has.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

/** The apps an EMPLOYEE member can open, whatever their assignments say. */
const EMPLOYEE_MEMBER_APPS = ['weldhr', 'weldchat'];

export async function listMemberAppCodes(db: Database, userId: string): Promise<string[]> {
  const { workspaceInstalledApps, workspaceMembers, userAppAssignments } = schema;

  const apps = await db
    .select({ appCode: workspaceInstalledApps.appCode })
    .from(workspaceInstalledApps)
    .where(and(eq(workspaceInstalledApps.isActive, true), isNull(workspaceInstalledApps.deletedAt)));

  const allAppCodes = apps.map((a) => a.appCode);

  const memberResult = await db
    .select({ role: workspaceMembers.role, roleId: workspaceMembers.roleId, memberType: workspaceMembers.memberType })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  const role = memberResult[0]?.role?.toUpperCase();

  if (role === 'OWNER' || role === 'ADMIN') {
    return allAppCodes;
  }

  // EMPLOYEE members have a fixed set of apps, like their fixed permissions
  // (EMPLOYEE_MEMBER_PERMISSIONS): My HR in WeldHR, and WeldChat.
  if (memberResult[0]?.memberType === 'EMPLOYEE') {
    return allAppCodes.filter((code) => EMPLOYEE_MEMBER_APPS.includes(code));
  }

  if (allAppCodes.length === 0) {
    return [];
  }

  // A member's effective apps = the workspace's installed apps intersected
  // with (apps granted by their role) ∪ (per-user app assignments). Role
  // apps are derived live — editing a role's apps instantly changes what its
  // members can open, with no per-user writes.
  const effective = new Set<string>();

  const roleId = memberResult[0]?.roleId ?? null;
  if (roleId) {
    const { roles } = schema;
    const [roleRow] = await db
      .select({ apps: roles.apps })
      .from(roles)
      .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
      .limit(1);
    const installed = new Set(allAppCodes);
    for (const code of ((roleRow?.apps as string[]) || [])) {
      if (installed.has(code)) effective.add(code);
    }
  }

  const assignments = await db
    .select({ appCode: userAppAssignments.appCode })
    .from(userAppAssignments)
    .where(
      and(
        eq(userAppAssignments.userId, userId),
        eq(userAppAssignments.isActive, true),
        inArray(userAppAssignments.appCode, allAppCodes),
      ),
    );
  for (const a of assignments) effective.add(a.appCode);

  return Array.from(effective);
}
