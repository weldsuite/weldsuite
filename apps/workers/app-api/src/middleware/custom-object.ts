/**
 * WeldObjects — slug resolution + dynamic permission gate.
 *
 * `requirePermission('leads:read')` builds its middleware closure at route
 * REGISTRATION time, which works because the key is a constant. A custom
 * object's key isn't: `weldobjects:machine:read` is only knowable once the
 * request's `:slug` param has been read. This middleware closes that gap.
 *
 * It does two jobs in one pass so every data route gets both without
 * boilerplate:
 *
 *   1. Resolve `:slug` → the `custom_objects` row, 404 if unknown, and stash it
 *      on the context as `customObject` so handlers never re-query it.
 *   2. Resolve the caller's permissions once and check
 *      `weldobjects:<slug>:<action>` against them.
 *
 * Note this does NOT call `requirePermission` internally — it calls
 * `ensurePermissionsResolved` + `hasPermission` directly, so the permission
 * resolution is shared with any other gate on the same request (both read from
 * the same context cache, so there is still exactly one DB round-trip).
 *
 * Wildcard grants work unchanged: `weldobjects:*`, `weldobjects:machine:*` and
 * `weldobjects:*:read` all match, because the matcher in @weldsuite/permissions
 * walks segments generically rather than assuming two of them.
 */

import type { Context, Next } from 'hono';
import { ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import {
  customObjectPermission,
  customObjectScopeAllPermission,
  type CustomObjectPermissionAction,
} from '@weldsuite/permissions/custom-objects';
import { getCustomObjectBySlug, type CustomObjectRow } from '../services/custom-objects';
import { error } from '../lib/response';

/** Hono's branded HonoRequest makes a typed middleware non-assignable to a
 *  route slot with a path literal; widen exactly as requirePermission does. */
type RouteSlot = (c: any, next: Next) => Promise<Response | undefined>;

/**
 * Resolve `:slug` and enforce `weldobjects:<slug>:<action>`.
 *
 * A caller lacking permission gets 403; an unknown slug gets 404. The order
 * matters and is deliberate: slug resolution happens FIRST, so a user without
 * access to object A cannot probe which objects exist by comparing 403 against
 * 404 — they get 404 for a nonexistent object either way, and 403 only for one
 * that exists. That does leak existence to authenticated workspace members,
 * which is acceptable: object types are workspace-wide metadata, and the
 * sidebar lists them anyway.
 */
export function requireCustomObject(action: CustomObjectPermissionAction): RouteSlot {
  const handler = async (c: Context<any>, next: Next): Promise<Response | undefined> => {
    const slug = c.req.param('slug');
    if (!slug) return error.badRequest(c, 'Missing object slug');

    const db = c.get('tenantDb');
    const object = await getCustomObjectBySlug(db, slug);
    if (!object) return error.notFound(c, 'Custom object', slug);
    if (object.status === 'disabled') {
      return error.notFound(c, 'Custom object', slug);
    }

    const resolved = await ensurePermissionsResolved(c);
    const permissions = resolved?.permissions ?? [];
    if (!hasPermission(permissions, customObjectPermission(slug, action))) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `You do not have permission to ${action} ${object.labelPlural.toLowerCase()}`,
          },
        },
        403,
      );
    }

    c.set('customObject', object);
    await next();
    return undefined;
  };
  return handler as unknown as RouteSlot;
}

/**
 * The owner-scope value for the current caller on the resolved object:
 * `undefined` when they hold `<slug>:scope:all` (see everything), otherwise
 * their own user id (see only what they own).
 *
 * Same shape and semantics as `scopeFor` in routes/leads — pass the result
 * straight into `listRecords({ ownerScope })`.
 */
export async function customObjectScope(c: Context<any>): Promise<string | undefined> {
  const object = c.get('customObject') as CustomObjectRow | undefined;
  if (!object) return c.get('userId');

  const resolved = await ensurePermissionsResolved(c);
  const permissions = resolved?.permissions ?? [];
  if (hasPermission(permissions, customObjectScopeAllPermission(object.slug))) return undefined;
  return c.get('userId');
}

/** The resolved object, for handlers running behind `requireCustomObject`. */
export function getCustomObject(c: Context<any>): CustomObjectRow {
  const object = c.get('customObject') as CustomObjectRow | undefined;
  if (!object) {
    throw new Error(
      '[custom-object] getCustomObject() called without requireCustomObject() on the route',
    );
  }
  return object;
}
