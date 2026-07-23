/**
 * Per-member access service — what a single workspace member can see and use.
 *
 * Ported from apps/api-worker (W5b legacy-worker phase-out):
 *   - permissions breakdown ← GET  /settings/members/:memberId/permissions
 *   - app assignment list   ← GET  /settings/members/:memberId/apps
 *   - single app toggle     ← POST /settings/members/:memberId/apps/toggle
 *
 * Distinct from `/api/me/permissions`, which only ever answers for the caller:
 * this splits a *named* member's grants into role-derived vs per-member
 * override, which is exactly what the team-member panel's permission matrix
 * renders (inherited rows are shown checked-but-disabled).
 *
 * Pure functions over the tenant DB, no Hono context.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { appName } from '../roles';

const { workspaceMembers, roles, userAppAssignments, workspaceInstalledApps } = schema;

export interface MemberPermissionsBreakdown {
  /** Union of role + override grants — what actually applies. */
  effective: string[];
  /** Grants inherited from the member's custom role (empty when none). */
  rolePermissions: string[];
  /** Grants written directly onto the member row. */
  memberOverrides: string[];
  /** System tier (OWNER / ADMIN / MEMBER / ...). */
  role: string;
  /** Custom role id, or null when the member is on a bare system tier. */
  roleId: string | null;
}

export interface MemberAppAssignment {
  appCode: string;
  appName: string;
  isAssigned: boolean;
  assignedAt: Date | null;
  assignedBy: string | null;
}

/** Look up a live member row by its `workspace_members.id`. */
async function findMember(db: Database, memberId: string) {
  const [member] = await db
    .select({
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      roleId: workspaceMembers.roleId,
      permissions: workspaceMembers.permissions,
    })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  return member ?? null;
}

/**
 * Split a member's permissions into role-derived vs per-member override.
 * Returns null when the member does not exist (caller answers 404).
 *
 * NOTE: this is a breakdown of *stored* grants, exactly as the legacy route
 * computed it — it is NOT the resolved effective set from
 * `resolveEffectivePermissions()`. In particular a bare system tier (an
 * OWNER/ADMIN with no custom role) reports empty arrays here, because those
 * wildcards are not stored on the row. The panel relies on that: it renders
 * the override matrix, and separately hides it for OWNER.
 */
export async function getMemberPermissions(
  db: Database,
  memberId: string,
): Promise<MemberPermissionsBreakdown | null> {
  const member = await findMember(db, memberId);
  if (!member) return null;

  let rolePermissions: string[] = [];
  if (member.roleId) {
    const [role] = await db
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(and(eq(roles.id, member.roleId), isNull(roles.deletedAt)))
      .limit(1);
    rolePermissions = (role?.permissions as string[] | null) || [];
  }

  const memberOverrides = (member.permissions as string[] | null) || [];

  return {
    effective: [...new Set([...rolePermissions, ...memberOverrides])],
    rolePermissions,
    memberOverrides,
    role: member.role,
    roleId: member.roleId,
  };
}

/**
 * Every app installed in the workspace, each flagged with whether this member
 * is assigned to it. Returns null when the member does not exist.
 *
 * The list is driven by `workspace_installed_apps` (not by the member's
 * assignments), so the panel can offer un-assigned apps as toggles.
 */
export async function getMemberApps(
  db: Database,
  memberId: string,
): Promise<MemberAppAssignment[] | null> {
  const member = await findMember(db, memberId);
  if (!member) return null;

  const installedApps = await db
    .select({ appCode: workspaceInstalledApps.appCode })
    .from(workspaceInstalledApps)
    .where(
      and(
        eq(workspaceInstalledApps.isActive, true),
        isNull(workspaceInstalledApps.deletedAt),
      ),
    );

  const assignments = await db
    .select({
      appCode: userAppAssignments.appCode,
      isActive: userAppAssignments.isActive,
      grantedAt: userAppAssignments.grantedAt,
      grantedBy: userAppAssignments.grantedBy,
    })
    .from(userAppAssignments)
    .where(eq(userAppAssignments.userId, member.userId));

  const assignmentMap = new Map(assignments.map((a) => [a.appCode, a]));

  return installedApps.map((app) => {
    const assignment = assignmentMap.get(app.appCode);
    return {
      appCode: app.appCode,
      appName: appName(app.appCode),
      isAssigned: assignment?.isActive ?? false,
      assignedAt: assignment?.grantedAt ?? null,
      assignedBy: assignment?.grantedBy ?? null,
    };
  });
}

/**
 * Grant or revoke a single app for a member. Returns false when the member
 * does not exist (caller answers 404).
 *
 * Revoking deactivates rather than deletes, preserving the grant history the
 * assignment list reads back (`assignedAt` / `assignedBy`) — legacy parity.
 */
export async function toggleMemberApp(
  db: Database,
  params: { memberId: string; appCode: string; enabled: boolean; actorUserId: string },
): Promise<boolean> {
  const { memberId, appCode, enabled, actorUserId } = params;

  const member = await findMember(db, memberId);
  if (!member) return false;

  const [existing] = await db
    .select({ id: userAppAssignments.id })
    .from(userAppAssignments)
    .where(
      and(
        eq(userAppAssignments.userId, member.userId),
        eq(userAppAssignments.appCode, appCode),
      ),
    )
    .limit(1);

  const now = new Date();

  if (enabled) {
    if (existing) {
      await db
        .update(userAppAssignments)
        .set({ isActive: true, updatedAt: now })
        .where(eq(userAppAssignments.id, existing.id));
    } else {
      await db.insert(userAppAssignments).values({
        id: generateId('uaa'),
        userId: member.userId,
        appCode,
        isActive: true,
        // Legacy left grantedAt/grantedBy unset on this path (the column
        // default fills grantedAt); recording the actor here is strictly more
        // information and is what the assignment list reads back.
        grantedAt: now,
        grantedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      });
    }
  } else if (existing) {
    await db
      .update(userAppAssignments)
      .set({ isActive: false, updatedAt: now })
      .where(eq(userAppAssignments.id, existing.id));
  }
  // Revoking an app that was never granted is a no-op, as in legacy.

  return true;
}
