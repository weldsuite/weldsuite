/**
 * @weldsuite/permissions — Server-side permission resolver
 *
 * Resolves a user's effective permissions from the database.
 * Generic over the database type so it works in any Hono worker.
 *
 * effectivePermissions = rolePermissions UNION teamPermissions[] UNION memberExtraPermissions
 */

import { SYSTEM_ROLES } from '../catalog';
import type { ResolvedPermissions } from '../types';

/**
 * Minimal database interface — any Drizzle-compatible client with select/from/where.
 * We use raw SQL-style calls so we don't need tight coupling to a specific db module.
 */
export interface PermissionDbQuery {
  /** Run a query and return rows. Caller provides the actual DB logic. */
  getMember(userId: string): Promise<{
    id: string;
    role: string;
    roleId: string | null;
    permissions: string[] | null;
  } | null>;

  getRolePermissions(roleId: string): Promise<string[] | null>;

  getTeamPermissions(memberId: string): Promise<string[][]>;
}

/**
 * Resolve the effective permissions for a user.
 *
 * Resolution order:
 * 1. If OWNER role → return ['*'] immediately
 * 2. Get role permissions (from custom roleId or system role fallback)
 * 3. Get team permissions (all teams the member belongs to)
 * 4. Get extra member permissions
 * 5. Merge and deduplicate
 */
export async function resolveEffectivePermissions(
  queries: PermissionDbQuery,
  userId: string,
): Promise<ResolvedPermissions> {
  const member = await queries.getMember(userId);

  if (!member) {
    return { permissions: [], role: '', roleId: null, isOwner: false };
  }

  const isOwner = member.role === 'OWNER';

  // OWNER shortcut
  if (isOwner) {
    return { permissions: ['*'], role: 'OWNER', roleId: member.roleId, isOwner: true };
  }

  // 1. Role permissions
  let rolePermissions: string[] = [];
  if (member.roleId) {
    // Custom role
    const perms = await queries.getRolePermissions(member.roleId);
    if (perms) rolePermissions = perms;
  } else {
    // System role fallback
    const systemRole = SYSTEM_ROLES[member.role];
    if (systemRole) rolePermissions = [...systemRole.permissions];
  }

  // 2. Team permissions
  const teamPermArrays = await queries.getTeamPermissions(member.id);
  const teamPermissions = teamPermArrays.flat();

  // 3. Extra member permissions
  const memberPermissions = member.permissions ?? [];

  // Merge and deduplicate
  const all = new Set([...rolePermissions, ...teamPermissions, ...memberPermissions]);

  return {
    permissions: [...all],
    role: member.role,
    roleId: member.roleId,
    isOwner: false,
  };
}

/**
 * Create a PermissionDbQuery adapter from a Drizzle database instance and schema.
 *
 * This is the standard adapter for the api-worker — pass your tenant db + schema.
 */
export function createDrizzlePermissionQueries(
  db: any,
  schema: {
    workspaceMembers: any;
    roles: any;
    teams?: any;
    teamMembers?: any;
  },
  drizzleOps: {
    eq: any;
    and: any;
    isNull: any;
  },
): PermissionDbQuery {
  const { eq, and, isNull } = drizzleOps;

  return {
    async getMember(userId: string) {
      const [member] = await db
        .select({
          id: schema.workspaceMembers.id,
          role: schema.workspaceMembers.role,
          roleId: schema.workspaceMembers.roleId,
          permissions: schema.workspaceMembers.permissions,
        })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.userId, userId),
            isNull(schema.workspaceMembers.deletedAt),
          ),
        )
        .limit(1);

      return member ?? null;
    },

    async getRolePermissions(roleId: string) {
      const [role] = await db
        .select({ permissions: schema.roles.permissions })
        .from(schema.roles)
        .where(and(eq(schema.roles.id, roleId), isNull(schema.roles.deletedAt)))
        .limit(1);

      return (role?.permissions as string[]) ?? null;
    },

    async getTeamPermissions(memberId: string) {
      // Teams table may not exist yet (Phase 4)
      if (!schema.teams || !schema.teamMembers) return [];

      const rows = await db
        .select({ permissions: schema.teams.permissions })
        .from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teamMembers.teamId, schema.teams.id))
        .where(
          and(
            eq(schema.teamMembers.memberId, memberId),
            isNull(schema.teams.deletedAt),
          ),
        );

      return rows
        .map((r: any) => (r.permissions as string[]) ?? [])
        .filter((a: string[]) => a.length > 0);
    },
  };
}
