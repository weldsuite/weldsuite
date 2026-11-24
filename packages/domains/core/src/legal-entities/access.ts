/**
 * Per-entity access (weldsuite-documentation/plans/legal-entities.md, "Per-entity access").
 *
 * Who sees a legal entity, and which role they act with inside it:
 *
 *   owner                                   → every entity, workspace role
 *   has a `legal_entity_members` row        → that entity, the row's role
 *                                             (null = workspace role)
 *   no row, entity not restricted           → that entity, workspace role
 *   no row, entity restricted               → not visible
 *
 * Holders of `legal_entities:manage` (admins) see entities as any member
 * does, so a restricted entity only when they are listed on it, and act with
 * their workspace role in every entity they see.
 *
 * One snapshot per request (`getEntityAccess`), loaded with a single query,
 * computed from the member's WORKSPACE permissions before any entity role is
 * swapped in.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  createDrizzlePermissionQueries,
  ensurePermissionsResolved,
  resolveEffectivePermissions,
  type PermissionDbQuery,
} from '@weldsuite/permissions/server';
import { checkAppPermission } from '@weldsuite/permissions';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { LegalEntityAccessSource } from '@weldsuite/app-api-client/schemas/legal-entities';

/**
 * The permission that manages who sees which entity. Its holders keep their
 * workspace role in every entity they see, and see a restricted entity only
 * when they are listed on it.
 */
export const LEGAL_ENTITIES_MANAGE = 'legal_entities:manage';

export interface EntityAccessEntry {
  restricted: boolean;
  /** The member's row on this entity, or null when they have none. */
  member: { roleId: string | null } | null;
}

export interface EntityAccess {
  userId: string;
  isOwner: boolean;
  /** Owner: every entity, restricted or not. */
  seesAll: boolean;
  /**
   * Owner or `legal_entities:manage`: acts with the workspace role in every
   * entity they see, whatever role their row names.
   */
  managesAccess: boolean;
  /** Live (not deleted) entities of the workspace, with the member's standing on each. */
  entities: ReadonlyMap<string, EntityAccessEntry>;
  /**
   * Access is the same in every entity (sees all, or no restricted entity
   * and no entity role that applies): record checks can pass without
   * comparing entities.
   */
  uniform: boolean;
  /** The member's workspace permissions, before any entity role swap. */
  workspacePermissions: ResolvedPermissions;
}

const NO_PERMISSIONS: ResolvedPermissions = { permissions: [], denies: [], role: '', roleId: null, isOwner: false };

/** Pure: build the snapshot from the rows the loader reads. Exported for tests. */
export function buildEntityAccess(
  userId: string,
  workspacePermissions: ResolvedPermissions,
  rows: ReadonlyArray<{ id: string; accessRestricted: boolean; isMember: boolean; memberRoleId: string | null }>,
): EntityAccess {
  const isOwner = workspacePermissions.isOwner;
  const seesAll = isOwner;
  // Workspace-level key (registered in no app), deny-aware.
  const managesAccess = isOwner || checkAppPermission(workspacePermissions, LEGAL_ENTITIES_MANAGE, null).allowed;
  const entities = new Map<string, EntityAccessEntry>();
  let anyRestricted = false;
  let anyRole = false;
  for (const row of rows) {
    entities.set(row.id, {
      restricted: row.accessRestricted,
      member: row.isMember ? { roleId: row.memberRoleId } : null,
    });
    if (row.accessRestricted) anyRestricted = true;
    if (row.isMember && row.memberRoleId) anyRole = true;
  }
  return {
    userId,
    isOwner,
    seesAll,
    managesAccess,
    entities,
    uniform: seesAll || (!anyRestricted && (managesAccess || !anyRole)),
    workspacePermissions,
  };
}

/** Whether the member sees this entity at all. Unknown or deleted ids are never visible. */
export function canSeeEntity(access: EntityAccess, entityId: string | null | undefined): boolean {
  if (!entityId) return false;
  const entry = access.entities.get(entityId);
  if (!entry) return false;
  if (access.seesAll) return true;
  return entry.member !== null || !entry.restricted;
}

/**
 * The role the member acts with inside a visible entity: a `roles.id`, or
 * null for their workspace role. Owners and access managers always keep
 * their workspace role.
 */
export function entityRoleId(access: EntityAccess, entityId: string | null | undefined): string | null {
  if (!entityId || access.managesAccess) return null;
  return access.entities.get(entityId)?.member?.roleId ?? null;
}

/**
 * For an entity the member sees: 'manager' means they act there with their
 * workspace role because they manage access.
 */
export function entityAccessSource(access: EntityAccess, entityId: string): LegalEntityAccessSource {
  if (access.isOwner) return 'owner';
  if (access.managesAccess) return 'manager';
  return access.entities.get(entityId)?.member ? 'member' : 'open';
}

/** Ids of every entity the member sees. */
export function visibleEntityIds(access: EntityAccess): string[] {
  return [...access.entities.keys()].filter((id) => canSeeEntity(access, id));
}

/** Load the snapshot. One query: the live entities left-joined with the member's rows. */
export async function loadEntityAccess(
  db: Database,
  userId: string,
  workspacePermissions: ResolvedPermissions,
): Promise<EntityAccess> {
  const e = schema.legalEntities;
  const m = schema.legalEntityMembers;
  const rows = await db
    .select({
      id: e.id,
      accessRestricted: e.accessRestricted,
      isMember: sql<boolean>`${m.id} is not null`,
      memberRoleId: m.roleId,
    })
    .from(e)
    .leftJoin(m, and(eq(m.entityId, e.id), eq(m.userId, userId)))
    .where(isNull(e.deletedAt));
  return buildEntityAccess(
    userId,
    workspacePermissions,
    rows.map((r) => ({
      id: r.id,
      accessRestricted: Boolean(r.accessRestricted),
      isMember: Boolean(r.isMember),
      memberRoleId: r.memberRoleId ?? null,
    })),
  );
}

const accessByRequest = new WeakMap<Context, Promise<EntityAccess>>();

/**
 * The request's access snapshot, loaded once. Computed from the workspace
 * permissions, so call it (or let `legalEntityContext` call it) before an
 * entity role is swapped in; later calls return the cached snapshot.
 */
export function getEntityAccess(c: Context): Promise<EntityAccess> {
  let pending = accessByRequest.get(c);
  if (!pending) {
    pending = (async () => {
      const userId = (c.get('userId') as string | undefined) ?? '';
      const permissions = (await ensurePermissionsResolved(c)) ?? NO_PERMISSIONS;
      return loadEntityAccess(c.get('tenantDb') as Database, userId, permissions);
    })();
    accessByRequest.set(c, pending);
  }
  return pending;
}

/**
 * Resolve the member's permissions as if their workspace role were `roleId`:
 * that role's permissions ∪ team permissions ∪ personal extras, personal
 * denies still apply. EMPLOYEE members keep their fixed set (the resolver
 * ignores roles for them). Not cached in KV: the KV entry is the workspace
 * result.
 */
export async function resolvePermissionsWithRole(
  db: Database,
  userId: string,
  roleId: string,
): Promise<ResolvedPermissions> {
  const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
  const withRole: PermissionDbQuery = {
    ...queries,
    async getMember(id: string) {
      const member = await queries.getMember(id);
      if (!member) return null;
      // An entity role never makes anyone owner, and never applies to an owner
      // (owners see every entity with their own role, see entityRoleId).
      return { ...member, role: member.role === 'OWNER' ? 'ADMIN' : member.role, roleId };
    },
  };
  return resolveEffectivePermissions(withRole, userId);
}

/** The effective permissions inside one entity: the workspace result, or the entity role's. */
export async function permissionsInEntity(
  db: Database,
  access: EntityAccess,
  entityId: string,
): Promise<ResolvedPermissions> {
  const roleId = entityRoleId(access, entityId);
  if (!roleId) return access.workspacePermissions;
  return resolvePermissionsWithRole(db, access.userId, roleId);
}
