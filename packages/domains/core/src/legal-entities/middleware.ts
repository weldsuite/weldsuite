/**
 * `legalEntityContext()`: the one place a WeldBooks or WeldHR request learns
 * which legal entity it is about, and the one place per-entity access is
 * enforced for it (docs/plans/legal-entities.md).
 *
 * Resolution: `X-Legal-Entity-Id`, then `X-Accounting-Entity-Id` (kept for
 * old mobile binaries and API clients), then `?entityId`, then the default
 * entity. An id that is unknown, deleted, not enabled for the app or not
 * visible to the member resolves to no entity (null): the route then lists
 * nothing or refuses, exactly as an unknown id did before, and a restricted
 * entity's existence is never confirmed. A named id never falls back to the
 * default.
 *
 * With `scoped: true` the member then acts with their entity role: the
 * request's `userPermissions` are replaced before any `requirePermission`
 * runs. Mount it after `apiAuth()` and before the routes.
 */

import { and, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { LegalEntityApp } from '@weldsuite/app-api-client/schemas/legal-entities';
import {
  canSeeEntity,
  entityRoleId,
  getEntityAccess,
  permissionsInEntity,
  type EntityAccess,
} from './access';
import { getLegalEntityExtension } from './extensions';

export const LEGAL_ENTITY_HEADER = 'x-legal-entity-id';
export const ACCOUNTING_ENTITY_HEADER = 'x-accounting-entity-id';

export interface LegalEntityContextOptions {
  /** Only entities this app is enabled for resolve (WeldBooks needs its extension row). */
  app?: LegalEntityApp;
  /** Swap in the member's entity role for the request. */
  scoped?: boolean;
  /**
   * Use the default entity when the request names none (default true, the
   * WeldBooks behaviour). WeldHR passes false: a request without an entity
   * spans every entity the member acts in with their workspace role, see
   * `requestEntityScope`.
   */
  fallbackToDefault?: boolean;
  /**
   * Skip the request entirely (no resolution, no swap) when this returns
   * true, e.g. the entity list that the switcher reads, or My HR.
   */
  skip?: (c: Context) => boolean;
}

const resolvedByRequest = new WeakMap<Context, Promise<string | null>>();

/** The entity id the request names (header or `?entityId`), before any check. */
export function requestedEntityId(c: Context): string | null {
  const raw =
    c.req.header(LEGAL_ENTITY_HEADER) || c.req.header(ACCOUNTING_ENTITY_HEADER) || c.req.query('entityId') || '';
  const id = raw.trim();
  return id.length > 0 && id.length <= 30 ? id : null;
}

async function enabledFor(db: Database, app: LegalEntityApp | undefined, entityId: string): Promise<boolean> {
  if (!app) return true;
  const enabled = await getLegalEntityExtension(app).enabledFor(db, [entityId]);
  return enabled.has(entityId);
}

/**
 * The default entity for an app: the core default when the app is enabled
 * for it, else (WeldBooks, release 1) the deprecated
 * `settings.default_entity_id` when it is.
 */
export async function defaultEntityIdFor(db: Database, app?: LegalEntityApp): Promise<string | null> {
  const [core] = await db
    .select({ id: schema.legalEntities.id })
    .from(schema.legalEntities)
    .where(and(eq(schema.legalEntities.isDefault, true), isNull(schema.legalEntities.deletedAt)))
    .limit(1);
  if (core && (await enabledFor(db, app, core.id))) return core.id;
  if (app === 'weldbooks') {
    const [settings] = await db.select({ id: schema.settings.defaultEntityId }).from(schema.settings).limit(1);
    if (settings?.id && (await enabledFor(db, app, settings.id))) return settings.id;
  }
  return null;
}

/** Resolve the request's entity against the member's access. Exported for tests and non-middleware callers. */
export async function resolveRequestEntity(
  c: Context,
  access: EntityAccess,
  app?: LegalEntityApp,
  fallbackToDefault = true,
): Promise<string | null> {
  const db = c.get('tenantDb') as Database;
  const requested = requestedEntityId(c);
  const candidate = requested ?? (fallbackToDefault ? await defaultEntityIdFor(db, app) : null);
  if (!candidate) return null;
  if (!canSeeEntity(access, candidate)) return null;
  if (!(await enabledFor(db, app, candidate))) return null;
  return candidate;
}

export function legalEntityContext(options: LegalEntityContextOptions = {}): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (options.skip?.(c)) return next();
    // Anything without a member (internal, public) is not about an entity.
    if (!c.get('userId') || !c.get('tenantDb')) return next();

    const access = await getEntityAccess(c);
    const pending = resolveRequestEntity(c, access, options.app, options.fallbackToDefault ?? true);
    resolvedByRequest.set(c, pending);
    const entityId = await pending;
    c.set('legalEntityId', entityId);

    if (options.scoped && entityId && entityRoleId(access, entityId)) {
      c.set('userPermissions', await permissionsInEntity(c.get('tenantDb') as Database, access, entityId));
    }
    return next();
  };
}

/**
 * The entity `legalEntityContext` resolved for this request; undefined when
 * the middleware did not run (callers then use their own fallback).
 */
export function getRequestEntityId(c: Context): Promise<string | null> | undefined {
  return resolvedByRequest.get(c);
}

/**
 * For a route that loaded a record by id: may this request touch a record
 * of `recordEntityId`? True when the member sees that entity and acts there
 * with the same role the request was checked with (the request's entity
 * role, or the workspace role when the request has no entity). Members whose
 * access is the same everywhere always pass, so deep links keep working.
 * Answer 404 when this is false.
 */
export async function recordInRequestEntity(c: Context, recordEntityId: string | null | undefined): Promise<boolean> {
  const access = await getEntityAccess(c);
  if (access.uniform) return true;
  if (!recordEntityId) return true;
  if (!canSeeEntity(access, recordEntityId)) return false;
  const requestEntityId = (await getRequestEntityId(c)) ?? null;
  if (requestEntityId === recordEntityId) return true;
  return entityRoleId(access, recordEntityId) === entityRoleId(access, requestEntityId);
}

/**
 * Filter for list routes that span entities (WeldHR without a switcher
 * selection, workspace-wide searches): the entity ids the member sees, or
 * null when they see every entity and no filter is needed.
 */
export async function visibleEntityFilter(c: Context): Promise<string[] | null> {
  const access = await getEntityAccess(c);
  if (access.seesAll) return null;
  const visible: string[] = [];
  let hidden = false;
  for (const id of access.entities.keys()) {
    if (canSeeEntity(access, id)) visible.push(id);
    else hidden = true;
  }
  return hidden ? visible : null;
}

/**
 * Which entities a list route may return rows of:
 *   - null: no filter (the member's access is the same everywhere and the
 *     request named no entity);
 *   - [id]: the entity the request is scoped to;
 *   - []: the request named an entity it may not see (list nothing);
 *   - several ids: no entity named, so every visible entity where the member
 *     acts with their workspace role (the role the request was checked
 *     with). Entities where they have an entity role are left out, so
 *     leaving the header off never bypasses an entity role.
 */
export async function requestEntityScope(c: Context): Promise<string[] | null> {
  const resolved = getRequestEntityId(c);
  const entityId = resolved ? await resolved : null;
  if (entityId) return [entityId];
  if (requestedEntityId(c)) return [];
  const access = await getEntityAccess(c);
  if (access.uniform) return null;
  return [...access.entities.keys()].filter((id) => canSeeEntity(access, id) && entityRoleId(access, id) === null);
}

/**
 * Drizzle condition for `requestEntityScope` on a `legal_entity_id`-style
 * column. Rows without an entity (from before a workspace had one) count as
 * the default entity's. Undefined means no filter.
 */
export function entityScopeCondition(
  column: AnyColumn,
  scope: string[] | null,
  defaultEntityId: string | null,
): SQL | undefined {
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`false`;
  const inScope = inArray(column, scope);
  return defaultEntityId && scope.includes(defaultEntityId) ? or(inScope, isNull(column)) : inScope;
}
