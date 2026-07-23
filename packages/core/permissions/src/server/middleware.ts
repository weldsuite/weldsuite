/**
 * @weldsuite/permissions — Hono permission middleware
 *
 * Requires that the user has one of the specified permissions.
 * Caches resolved permissions in Hono context for the request lifetime
 * so only one DB round-trip per request.
 */

import type { Context, Next } from 'hono';
import { hasAnyPermission } from '../engine';
import type { ResolvedPermissions } from '../types';
import { resolveEffectivePermissions, type PermissionDbQuery } from './resolver';

/**
 * Hono brands `HonoRequest<P>` with a non-`unique symbol` property
 * `[GET_MATCH_RESULT]: symbol`. Because the symbol is not unique, TypeScript
 * treats the property differently in `HonoRequest<string>` (wide path) vs
 * `HonoRequest<"/:id">` (narrow path) — so a `MiddlewareHandler<E, string,
 * …>` is NOT structurally assignable to a `Handler<E, "/:id", …>` route
 * slot. To stay slot-compatible for any path literal, we widen the
 * middleware function's context to `Context<any, any, any>` and return a
 * plain `RouteSlot` function type that bypasses Hono's branded HonoRequest
 * comparison at the call boundary. Inside the body we use the normal
 * Hono `Context` API; the typing only loosens at the function signature.
 */
type LooseContext = Context<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>;
type RouteSlot = (c: any, next: Next) => Promise<Response | undefined>;

/**
 * Context variable key for cached permissions.
 * Set this key on your Hono Variables type:
 *
 *   type Variables = { ...; userPermissions?: ResolvedPermissions };
 */
const CONTEXT_KEY = 'userPermissions';

// ---------------------------------------------------------------------------
// Option A: Pass a factory that creates PermissionDbQuery per-request
// ---------------------------------------------------------------------------

interface RequirePermissionOptions {
  /**
   * Factory that returns a PermissionDbQuery from the Hono context.
   * Called once per request (result is cached).
   */
  createQueries: (c: any) => PermissionDbQuery;
}

let _createQueries: ((c: any) => PermissionDbQuery) | null = null;

/**
 * One-time setup: tell the middleware how to create DB queries from context.
 * Call this once at worker startup.
 *
 * @example
 * ```ts
 * import { initPermissionMiddleware } from '@weldsuite/permissions/server';
 * initPermissionMiddleware({
 *   createQueries: (c) => createDrizzlePermissionQueries(c.get('tenantDb'), schema, { eq, and, isNull }),
 * });
 * ```
 */
export function initPermissionMiddleware(opts: RequirePermissionOptions) {
  _createQueries = opts.createQueries;
}

/**
 * Hono middleware that enforces permission checks.
 *
 * The user must have at least ONE of the listed permissions.
 * Returns 403 if the check fails.
 *
 * @example
 * ```ts
 * leadsRoutes.get('/', requirePermission('weldcrm:leads:read'), async (c) => { ... });
 * leadsRoutes.post('/', requirePermission('weldcrm:leads:create'), async (c) => { ... });
 * ```
 */
export const requirePermission = (...required: string[]): RouteSlot => {
  const handler = async (c: LooseContext, next: Next): Promise<Response | undefined> => {
    if (!_createQueries) {
      throw new Error(
        'Permission middleware not initialized. Call initPermissionMiddleware() at worker startup.',
      );
    }

    const userId = c.get('userId') as string | undefined;
    if (!userId) {
      return c.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401,
      );
    }

    // Check context cache first.
    let resolved = c.get(CONTEXT_KEY) as ResolvedPermissions | undefined;
    if (!resolved) {
      const queries = _createQueries(c);
      resolved = await resolveEffectivePermissions(queries, userId);
      c.set(CONTEXT_KEY, resolved);
    }

    if (!hasAnyPermission(resolved.permissions, required)) {
      return c.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have permission to perform this action',
          },
        },
        403,
      );
    }

    await next();
    return undefined;
  };
  return handler as unknown as RouteSlot;
};

/**
 * Helper to get the resolved permissions from context (after middleware has run).
 * Useful in route handlers that need to check additional permissions dynamically.
 */
export function getPermissionsFromContext(c: any): ResolvedPermissions | null {
  return c.get(CONTEXT_KEY) ?? null;
}

/**
 * Resolve the current user's effective permissions and cache them on context.
 * Idempotent — if already cached (e.g. by `requirePermission`), returns the
 * cached value. Use this in routes that need permission-aware behavior but
 * do NOT want to enforce a hard permission gate (e.g. the team-members
 * endpoint that returns different field projections for admin vs public
 * viewers).
 */
export async function ensurePermissionsResolved(c: any): Promise<ResolvedPermissions | null> {
  const cached: ResolvedPermissions | undefined = c.get(CONTEXT_KEY);
  if (cached) return cached;

  const userId: string | undefined = c.get('userId');
  if (!userId) return null;

  if (!_createQueries) {
    throw new Error(
      'Permission middleware not initialized. Call initPermissionMiddleware() at worker startup.',
    );
  }
  const queries = _createQueries(c);
  const resolved = await resolveEffectivePermissions(queries, userId);
  c.set(CONTEXT_KEY, resolved);
  return resolved;
}
