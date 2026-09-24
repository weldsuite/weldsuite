/**
 * @weldsuite/permissions — Hono permission middleware
 *
 * Requires that the user has one of the specified permissions.
 * Caches resolved permissions in Hono context for the request lifetime
 * so only one DB round-trip per request.
 *
 * Checks are app-aware: `requirePermission('companies:read')` is evaluated
 * as `<app>:companies:read` for the request's app context (see
 * ../app-scope.ts and ./app-context.ts), and member denies are honoured.
 */

import type { Context, Next } from 'hono';
import { checkAppPermission } from '../app-scope';
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

/** Context variable holding the request's app code (set by appContextMiddleware). */
export const APP_CONTEXT_KEY = 'app';

// ---------------------------------------------------------------------------
// Option A: Pass a factory that creates PermissionDbQuery per-request
// ---------------------------------------------------------------------------

interface RequirePermissionOptions {
  /**
   * Factory that returns a PermissionDbQuery from the Hono context.
   * Called once per request (result is cached).
   */
  createQueries: (c: any) => PermissionDbQuery;
  /**
   * The app the request comes from. Defaults to the `app` context variable
   * set by `appContextMiddleware`. Null/undefined means no app context.
   */
  getApp?: (c: any) => string | null | undefined;
  /**
   * Whether a per-app refusal is enforced (403) or only logged. Defaults to
   * the `PERMISSIONS_APP_ENFORCE` binding being the string "true". In log
   * mode a request refused in its app but allowed in another app goes
   * through with a warning, so the rollout can't lock anyone out.
   */
  isAppEnforced?: (c: any) => boolean;
}

let _createQueries: ((c: any) => PermissionDbQuery) | null = null;
let _getApp: (c: any) => string | null | undefined = (c) => c.get(APP_CONTEXT_KEY);
let _isAppEnforced: (c: any) => boolean = (c) => c.env?.PERMISSIONS_APP_ENFORCE === 'true';

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
  if (opts.getApp) _getApp = opts.getApp;
  if (opts.isAppEnforced) _isAppEnforced = opts.isAppEnforced;
}

// Each distinct warning is logged once per isolate: every request made from a
// module carries its app, so an unregistered (app, object) pair would
// otherwise log on every call.
const _warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (_warned.has(key)) return;
  if (_warned.size > 5000) _warned.clear();
  _warned.add(key);
  console.warn(message);
}

/**
 * Evaluate "any of `required`" for the resolved user in the request's app
 * context. True when access is granted (including the log-mode
 * pass-through), false when it must be refused.
 */
function evaluateInAppContext(c: any, resolved: ResolvedPermissions, required: string[]): boolean {
  const app = _getApp(c) ?? null;
  let refusedInApp: string | null = null;

  for (const key of required) {
    const check = checkAppPermission(resolved, key, app);
    if (check.objectNotInApp) {
      warnOnce(
        `nia|${app}|${key}`,
        `[permissions] object of "${key}" is not registered in app "${app}"; checked across all apps`,
      );
    }
    if (check.allowed) return true;
    if (check.mode === 'app' && !refusedInApp && checkAppPermission(resolved, key, null).allowed) {
      refusedInApp = key;
    }
  }

  // Refused in this app but granted in another one: enforce, or only log.
  if (refusedInApp && !_isAppEnforced(c)) {
    const userId = c.get('userId');
    warnOnce(
      `ref|${app}|${refusedInApp}|${userId}`,
      `[permissions] "${refusedInApp}" is not granted in app "${app}" for user ${userId}; allowed (log-only mode)`,
    );
    return true;
  }
  return false;
}

/**
 * Hono middleware that enforces permission checks.
 *
 * The user must have at least ONE of the listed permissions.
 * Returns 403 if the check fails.
 *
 * @example
 * ```ts
 * // Checked as `<app>:leads:read` for the request's app context.
 * leadsRoutes.get('/', requirePermission('leads:read'), async (c) => { ... });
 * leadsRoutes.post('/', requirePermission('leads:create'), async (c) => { ... });
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

    if (!evaluateInAppContext(c, resolved, required)) {
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

/**
 * App-aware, deny-aware check for use inside route handlers: does the current
 * user hold ANY of these keys in this request's app? Resolves and caches the
 * permissions like `requirePermission` does. Use it instead of
 * `hasPermission(resolved.permissions, …)` so per-app grants and member
 * denies apply, e.g. for `companies:scope:all` in a `scopeFor` helper.
 */
export async function hasContextPermission(c: any, ...required: string[]): Promise<boolean> {
  const resolved = await ensurePermissionsResolved(c);
  if (!resolved) return false;
  return evaluateInAppContext(c, resolved, required);
}
