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
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { getRoleRowPermissions } from '@weldsuite/permissions';

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
  weldcommerce: 'WeldCommerce',
  weldads: 'WeldAds',
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
    permissions: getRoleRowPermissions(role),
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

/**
 * System roles in level order (highest first). The list returns the system
 * roles in this order, then the custom roles alphabetically.
 */
const SYSTEM_ROLE_ORDER: readonly string[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

/** Names a custom role may never take (compared trimmed, case-insensitively). */
export const RESERVED_ROLE_NAMES: readonly string[] = SYSTEM_ROLE_ORDER;

type RoleRecord = typeof roles.$inferSelect;

function normaliseRoleName(name: string): string {
  return name.trim().toUpperCase();
}

function systemRank(role: RoleRecord): number {
  const idx = SYSTEM_ROLE_ORDER.indexOf(normaliseRoleName(role.name));
  return idx === -1 ? SYSTEM_ROLE_ORDER.length : idx;
}

function compareRoles(a: RoleRecord, b: RoleRecord): number {
  if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
  if (a.isSystem) {
    const rank = systemRank(a) - systemRank(b);
    if (rank !== 0) return rank;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Active member counts keyed by role id.
 *
 * A member whose `roleId` points at a live role counts for that role only;
 * every other member counts for the system role matching their tier (the
 * `role` column). Custom roles are never matched by name: a custom role that
 * shared a tier's name used to pick up every member of that tier.
 */
async function countMembersByRole(db: Database, liveRoles: RoleRecord[]): Promise<Map<string, number>> {
  const groups = await db
    .select({
      role: workspaceMembers.role,
      roleId: workspaceMembers.roleId,
      count: count(),
    })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.status, 'ACTIVE'), isNull(workspaceMembers.deletedAt)))
    .groupBy(workspaceMembers.role, workspaceMembers.roleId);

  const liveIds = new Set(liveRoles.map((r) => r.id));
  const systemIdByTier = new Map<string, string>();
  for (const r of liveRoles) {
    if (r.isSystem) systemIdByTier.set(normaliseRoleName(r.name), r.id);
  }

  const counts = new Map<string, number>();
  const add = (id: string | undefined, n: number) => {
    if (id) counts.set(id, (counts.get(id) || 0) + Number(n));
  };
  for (const g of groups) {
    if (g.roleId && liveIds.has(g.roleId)) add(g.roleId, g.count);
    else if (g.role) add(systemIdByTier.get(normaliseRoleName(g.role)), g.count);
  }
  return counts;
}

export async function listRoles(db: Database): Promise<RoleRow[]> {
  const rolesData = [...(await ensureSeeded(db))].sort(compareRoles);
  const counts = await countMembersByRole(db, rolesData);
  return rolesData.map((role) => toRoleRow(role, counts.get(role.id) || 0));
}

export async function getRole(db: Database, roleId: string): Promise<RoleRow | null> {
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
    .limit(1);

  if (!role) return null;

  // Same attribution as the list, so the list and the detail page agree.
  const liveRoles = await db.select().from(roles).where(isNull(roles.deletedAt));
  const counts = await countMembersByRole(db, liveRoles);
  return toRoleRow(role, counts.get(role.id) || 0);
}

export type RoleNameProblem = 'reserved' | 'duplicate';

/**
 * Why `name` cannot be used for a custom role, or null when it can. Reserved
 * names are the system tiers; a duplicate is another live role with the same
 * name. Both compare trimmed and case-insensitively. `exceptRoleId` skips the
 * role being renamed.
 */
export async function checkRoleName(
  db: Database,
  name: string,
  exceptRoleId?: string,
): Promise<RoleNameProblem | null> {
  const wanted = normaliseRoleName(name);
  if (RESERVED_ROLE_NAMES.includes(wanted)) return 'reserved';
  const live = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(isNull(roles.deletedAt));
  const clash = live.some((r) => r.id !== exceptRoleId && normaliseRoleName(r.name) === wanted);
  return clash ? 'duplicate' : null;
}

export interface CreateRoleArgs {
  name: string;
  description?: string;
  permissions?: string[];
  apps?: string[];
  copyFromRoleId?: string;
}

export type CreateRoleResult =
  | { ok: true; role: RoleRow }
  | { ok: false; reason: RoleNameProblem };

export async function createRole(db: Database, args: CreateRoleArgs): Promise<CreateRoleResult> {
  const name = args.name.trim();
  const problem = await checkRoleName(db, name);
  if (problem) return { ok: false, reason: problem };

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
      if (!args.permissions) permissions = getRoleRowPermissions(source);
      if (!args.apps && source.apps) apps = source.apps as string[];
    }
  }

  const id = generateId('role');
  await db.insert(roles).values({
    id,
    name,
    description: args.description,
    permissions,
    apps,
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const role = await getRole(db, id);
  return { ok: true, role: role! };
}

export interface UpdateRoleArgs {
  name?: string;
  description?: string;
  permissions?: string[];
  apps?: string[];
}

export type UpdateRoleResult =
  | { ok: true; role: RoleRow }
  | { ok: false; reason: 'not_found' | 'system' | RoleNameProblem };

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
  if (args.name !== undefined) {
    const name = args.name.trim();
    const problem = await checkRoleName(db, name, roleId);
    if (problem) return { ok: false, reason: problem };
    updateData.name = name;
  }
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
