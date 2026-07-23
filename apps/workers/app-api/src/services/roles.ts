/**
 * Roles service — custom workspace roles (permissions + app grants).
 *
 * Pure functions over the tenant DB (no Hono context). Backed by the `roles`
 * table. Migrated from apps/api-worker/src/routes/settings (roles section) so
 * app-api owns the canonical role CRUD. The legacy api-worker still serves
 * DELETE (it carries WeldChat channel-link cleanup side effects that have not
 * been ported here).
 */

import { and, count, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { roles, workspaceMembers, workspaceInstalledApps } = schema;

// App code → display name. Mirrors the legacy api-worker APP_NAMES map so the
// role editor shows brand names instead of a capitalised code.
const APP_NAMES: Record<string, string> = {
  // Legacy short codes
  crm: 'CRM',
  helpdesk: 'WeldDesk',
  mail: 'WeldMail',
  projects: 'WeldFlow',
  task: 'WeldConnect',
  host: 'WeldHost',
  wms: 'WMS',
  accounting: 'Accounting',
  parcel: 'Parcel',
  social: 'Social',
  // Canonical weld* codes
  weldcrm: 'WeldCRM',
  welddesk: 'WeldDesk',
  weldmail: 'WeldMail',
  weldflow: 'WeldFlow',
  weldconnect: 'WeldConnect',
  weldhost: 'WeldHost',
  weldstash: 'WeldStash',
  weldbooks: 'WeldBooks',
  weldchat: 'WeldChat',
  weldmeet: 'WeldMeet',
  weldcalendar: 'WeldCalendar',
  welddrive: 'WeldDrive',
  welddata: 'WeldData',
};

/**
 * Display name for an app code, falling back to a capitalised code.
 * Exported so services/team/member-access.ts (the per-member app-assignment
 * list) renders the same brand names as the role editor instead of keeping a
 * third copy of APP_NAMES.
 */
export function appName(code: string): string {
  return APP_NAMES[code] || code.charAt(0).toUpperCase() + code.slice(1);
}

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystemRole: boolean;
  canDelete: boolean;
  canModify: boolean;
  memberCount: number;
  permissions: string[];
  apps: string[];
  createdAt: string;
  updatedAt: string;
}

function toRoleRow(
  role: typeof roles.$inferSelect,
  memberCount: number,
): RoleRow {
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? null,
    isSystemRole: role.isSystem,
    canDelete: !role.isSystem,
    canModify: !role.isSystem,
    memberCount,
    permissions: (role.permissions as string[]) || [],
    apps: (role.apps as string[]) || [],
    createdAt: role.createdAt?.toISOString() || '',
    updatedAt: role.updatedAt?.toISOString() || '',
  };
}

/**
 * Seed the four system roles if the workspace has none yet, then return all
 * non-deleted roles. Seeding is synchronous so the first list call already
 * includes them.
 */
async function ensureSeeded(db: Database): Promise<(typeof roles.$inferSelect)[]> {
  let rolesData = await db
    .select()
    .from(roles)
    .where(isNull(roles.deletedAt))
    .orderBy(roles.name);

  if (rolesData.length === 0) {
    const { SYSTEM_ROLES } = await import('@weldsuite/permissions/catalog');
    for (const [, roleDef] of Object.entries(SYSTEM_ROLES)) {
      await db.insert(roles).values({
        id: generateId('role'),
        name: roleDef.name,
        description: roleDef.description,
        isSystem: true,
        permissions: roleDef.permissions,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    rolesData = await db
      .select()
      .from(roles)
      .where(isNull(roles.deletedAt))
      .orderBy(roles.name);
  }

  return rolesData;
}

export async function listRoles(db: Database): Promise<RoleRow[]> {
  const rolesData = await ensureSeeded(db);

  const memberCounts = await db
    .select({
      role: workspaceMembers.role,
      roleId: workspaceMembers.roleId,
      count: count(),
    })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.status, 'ACTIVE'), isNull(workspaceMembers.deletedAt)))
    .groupBy(workspaceMembers.role, workspaceMembers.roleId);

  const countByRoleId = new Map<string, number>();
  const countByRoleName = new Map<string, number>();
  for (const mc of memberCounts) {
    if (mc.roleId) countByRoleId.set(mc.roleId, mc.count);
    if (mc.role) {
      const key = mc.role.toUpperCase();
      countByRoleName.set(key, (countByRoleName.get(key) || 0) + mc.count);
    }
  }

  return rolesData.map((role) =>
    toRoleRow(
      role,
      countByRoleId.get(role.id) || countByRoleName.get(role.name.toUpperCase()) || 0,
    ),
  );
}

export async function getRole(db: Database, roleId: string): Promise<RoleRow | null> {
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
    .limit(1);

  if (!role) return null;

  const [memberCount] = await db
    .select({ count: count() })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.status, 'ACTIVE'),
        isNull(workspaceMembers.deletedAt),
        role.isSystem
          ? eq(workspaceMembers.role, role.name.toUpperCase())
          : eq(workspaceMembers.roleId, roleId),
      ),
    );

  return toRoleRow(role, memberCount?.count || 0);
}

export interface CreateRoleArgs {
  name: string;
  description?: string;
  permissions?: string[];
  apps?: string[];
  copyFromRoleId?: string;
}

export async function createRole(db: Database, args: CreateRoleArgs): Promise<RoleRow | null> {
  let permissions = args.permissions || [];
  let apps = args.apps || [];

  // Copy permissions AND apps from a source role when requested and not
  // explicitly overridden by the caller.
  if (args.copyFromRoleId) {
    const [source] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, args.copyFromRoleId), isNull(roles.deletedAt)))
      .limit(1);
    if (source) {
      if (!args.permissions && source.permissions) permissions = source.permissions as string[];
      if (!args.apps && source.apps) apps = source.apps as string[];
    }
  }

  const id = generateId('role');
  await db.insert(roles).values({
    id,
    name: args.name,
    description: args.description,
    permissions,
    apps,
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return getRole(db, id);
}

export interface UpdateRoleArgs {
  name?: string;
  description?: string;
  permissions?: string[];
  apps?: string[];
}

export type UpdateRoleResult =
  | { ok: true; role: RoleRow }
  | { ok: false; reason: 'not_found' | 'system' };

export async function updateRole(
  db: Database,
  roleId: string,
  args: UpdateRoleArgs,
): Promise<UpdateRoleResult> {
  const [existing] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
    .limit(1);

  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.isSystem) return { ok: false, reason: 'system' };

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (args.name !== undefined) updateData.name = args.name;
  if (args.description !== undefined) updateData.description = args.description;
  if (args.permissions !== undefined) updateData.permissions = args.permissions;
  if (args.apps !== undefined) updateData.apps = args.apps;

  await db.update(roles).set(updateData).where(eq(roles.id, roleId));

  const role = await getRole(db, roleId);
  return { ok: true, role: role! };
}

/**
 * App codes granted by a member's role, intersected with the workspace's
 * active installed apps. Returns [] when the member has no custom role.
 * Used by the dashboard installed-apps read to live-derive role-granted apps.
 */
export async function getRoleAppCodes(
  db: Database,
  roleId: string | null,
  installedAppCodes: string[],
): Promise<string[]> {
  if (!roleId) return [];
  const [role] = await db
    .select({ apps: roles.apps })
    .from(roles)
    .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
    .limit(1);
  if (!role) return [];
  const installed = new Set(installedAppCodes);
  return ((role.apps as string[]) || []).filter((code) => installed.has(code));
}

/** Active installed apps for the workspace, as a selectable {code,name} list. */
export async function listInstallableApps(
  db: Database,
): Promise<{ appCode: string; appName: string }[]> {
  const installed = await db
    .select({ appCode: workspaceInstalledApps.appCode })
    .from(workspaceInstalledApps)
    .where(and(eq(workspaceInstalledApps.isActive, true), isNull(workspaceInstalledApps.deletedAt)));

  return installed.map((a) => ({ appCode: a.appCode, appName: appName(a.appCode) }));
}
