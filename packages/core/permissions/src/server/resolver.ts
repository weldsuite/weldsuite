/**
 * @weldsuite/permissions — Server-side permission resolver
 *
 * Resolves a user's effective permissions from the database.
 * Generic over the database type so it works in any Hono worker.
 *
 * effectivePermissions = rolePermissions UNION teamPermissions[] UNION memberExtraPermissions
 *                        (an EMPLOYEE member: EMPLOYEE_MEMBER_PERMISSIONS, nothing else)
 * denies               = memberDenies (applied at check time, a deny always wins)
 */

import { EMPLOYEE_MEMBER_PERMISSIONS, SYSTEM_ROLES, getRoleRowPermissions } from '../catalog';
import type { ResolvedPermissions } from '../types';

/**
 * Bump by hand when what `resolveEffectivePermissions` returns can change
 * with no tenant write: a change to the resolution logic below (or to
 * `getRoleRowPermissions` / `migratePermissionKeys`), or a tenant migration
 * that rewrites `roles.permissions` or member permission columns. The
 * code-defined catalog is covered without a bump, see below.
 */
const RESOLVER_LOGIC_VERSION = 1;

/** 32-bit FNV-1a, hex: a short, stable fingerprint, not a security hash. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Identifies the code that resolved a permission result: the hand-bumped
 * logic version plus a fingerprint of the system-role catalog and the
 * EMPLOYEE permission set, which members without a custom role resolve from.
 * Caches of resolved permissions key on it (`@weldsuite/worker-kit/permission-cache`),
 * so a deploy that changes either never serves a result the old code
 * resolved, without waiting out the cache TTL.
 */
export const PERMISSIONS_RESOLUTION_VERSION = `${RESOLVER_LOGIC_VERSION}.${fingerprint(
  JSON.stringify([SYSTEM_ROLES, EMPLOYEE_MEMBER_PERMISSIONS]),
)}`;

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
    /** Explicit per-member denies. Absent until the column exists. */
    permissionDenies?: string[] | null;
    /** INTERNAL, EXTERNAL_GUEST or EMPLOYEE. Absent on adapters that don't select it. */
    memberType?: string | null;
  } | null>;

  getRolePermissions(roleId: string): Promise<string[] | null>;

  getTeamPermissions(memberId: string): Promise<string[][]>;
}

/**
 * Resolve the effective permissions for a user.
 *
 * Resolution order:
 * 1. If OWNER role → return ['*'] immediately
 *    If an EMPLOYEE member → return EMPLOYEE_MEMBER_PERMISSIONS (+ denies)
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
    return { permissions: [], denies: [], role: '', roleId: null, isOwner: false };
  }

  const isOwner = member.role === 'OWNER';

  // OWNER shortcut — the owner can never be restricted, so no denies.
  if (isOwner) {
    return { permissions: ['*'], denies: [], role: 'OWNER', roleId: member.roleId, isOwner: true };
  }

  // EMPLOYEE members (My HR + WeldChat) get a fixed set. Their role, teams and
  // per-member extras are ignored so nothing widens them by accident; explicit
  // denies still apply.
  if (member.memberType === 'EMPLOYEE') {
    return {
      permissions: [...EMPLOYEE_MEMBER_PERMISSIONS],
      denies: member.permissionDenies ?? [],
      role: member.role,
      roleId: member.roleId,
      isOwner: false,
    };
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
    denies: member.permissionDenies ?? [],
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
      const columns: Record<string, unknown> = {
        id: schema.workspaceMembers.id,
        role: schema.workspaceMembers.role,
        roleId: schema.workspaceMembers.roleId,
        permissions: schema.workspaceMembers.permissions,
      };
      // Only selected once the schema declares the column, so this adapter
      // keeps working against tenant DBs that predate it.
      if (schema.workspaceMembers.permissionDenies) {
        columns.permissionDenies = schema.workspaceMembers.permissionDenies;
      }
      if (schema.workspaceMembers.memberType) {
        columns.memberType = schema.workspaceMembers.memberType;
      }
      // Only an ACTIVE member resolves permissions: a SUSPENDED member must
      // lose access the moment they are suspended, and a PENDING invite grants
      // nothing until it is accepted. Anything else resolves as "no member".
      const conditions = [
        eq(schema.workspaceMembers.userId, userId),
        isNull(schema.workspaceMembers.deletedAt),
      ];
      if (schema.workspaceMembers.status) {
        conditions.push(eq(schema.workspaceMembers.status, 'ACTIVE'));
      }
      const [member] = await db
        .select(columns)
        .from(schema.workspaceMembers)
        .where(and(...conditions))
        .limit(1);

      return member ?? null;
    },

    async getRolePermissions(roleId: string) {
      const [role] = await db
        .select({
          permissions: schema.roles.permissions,
          isSystem: schema.roles.isSystem,
          name: schema.roles.name,
        })
        .from(schema.roles)
        .where(and(eq(schema.roles.id, roleId), isNull(schema.roles.deletedAt)))
        .limit(1);

      return role ? getRoleRowPermissions(role) : null;
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
