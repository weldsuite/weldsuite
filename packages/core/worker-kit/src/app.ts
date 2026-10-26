/**
 * The Hono app every API worker starts from.
 *
 *   const app = createModuleApi<Env, Variables>({ service: 'pass-api' });
 *   app.route('/public/…', publicRoutes);            // no auth
 *   app.use('/api/*', ...apiAuth());                 // Clerk → tenant DB → flags
 *   app.route('/api/weldpass', weldpassRoutes);      // authed
 *   export default { fetch: app.fetch };
 *
 * Global middleware (in order): request id, logger, CORS, X-Weld-App app
 * context. Also `/robots.txt`, `/health` (master DB ping) and the JSON
 * notFound/onError envelope that `@weldsuite/api-client` expects. `onError`
 * answers a database that moved under the request (read-only 25006, rotated
 * password 28P01) with 503 WORKSPACE_MOVING + `Retry-After`.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { logger } from 'hono/logger';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  appContextMiddleware,
  createDrizzlePermissionQueries,
  initPermissionMiddleware,
} from '@weldsuite/permissions/server';
import { apiCors } from './cors';
import { forgetWorkspaceContext, getMasterDb, schema } from './db';
import type { KitEnv, KitVariables } from './env';
import { moduleForwarder } from './forward';
import { clerkMiddleware } from './middleware/clerk';
import { featureFlagsMiddleware } from './middleware/feature-flags';
import { licenceGate } from './middleware/licence-gate';
import { requestId } from './middleware/request-id';
import { workspaceDbMiddleware } from './middleware/workspace-db';
import { classifyMovedDatabaseError, workspaceMovingResponse } from './workspace-moving';

let permissionsInitialized = false;

/** Register the Drizzle-backed permission lookups once per isolate. */
export function ensurePermissionMiddleware(): void {
  if (permissionsInitialized) return;
  permissionsInitialized = true;
  initPermissionMiddleware({
    createQueries: (c) =>
      createDrizzlePermissionQueries(c.get('tenantDb'), schema, { eq, and, isNull }),
  });
}

export interface ModuleApiOptions {
  /** Worker name, reported by /health and in error logs (e.g. `pass-api`). */
  service: string;
  /**
   * Forward moved modules to their own worker (see ./forward.ts). Only
   * app-api sets this; module workers never forward.
   */
  forwardModules?: boolean;
}

export function createModuleApi<
  E extends KitEnv = KitEnv,
  V extends KitVariables = KitVariables,
>(options: ModuleApiOptions): Hono<{ Bindings: E; Variables: V }> {
  ensurePermissionMiddleware();

  const app = new Hono<{ Bindings: E; Variables: V }>();

  if (options.forwardModules) app.use('*', moduleForwarder({ from: options.service }) as MiddlewareHandler);
  app.use('*', requestId());
  app.use('*', logger());
  app.use('*', apiCors());
  // X-Weld-App → c.get('app'), read by requirePermission for app-scoped keys.
  // A missing header means "no app context" (checked across all apps).
  app.use('*', appContextMiddleware());

  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

  app.get('/health', async (c) => {
    const timestamp = new Date().toISOString();
    let dbStatus: 'pass' | 'warn' | 'fail' = 'fail';
    let dbTime = 0;
    let dbError: string | undefined;
    let httpStatus: 200 | 503 = 503;

    try {
      const db = getMasterDb(c.env);
      const start = Date.now();
      await Promise.race([
        db.execute(sql`SELECT 1`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      dbTime = Date.now() - start;
      dbStatus = dbTime > 1000 ? 'warn' : 'pass';
      httpStatus = 200;
    } catch (err) {
      dbError = err instanceof Error ? err.message : 'unknown error';
    }

    return c.json(
      {
        status: httpStatus === 200 ? dbStatus : 'fail',
        service: options.service,
        environment: c.env.ENVIRONMENT,
        timestamp,
        checks: {
          master_db: {
            status: dbStatus,
            componentType: 'datastore',
            observedValue: dbTime,
            observedUnit: 'ms',
            ...(dbError && { error: dbError }),
          },
        },
      },
      httpStatus,
      { 'Cache-Control': 'no-cache, no-store' },
    );
  });

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `${c.req.path} not found` } }, 404),
  );

  app.onError(async (err, c) => {
    // The tenant database says the workspace moved under this request (set
    // read-only, or the role's password rotated): a retryable 503, not a 500.
    // Only a classification is logged, never the error: its message can carry
    // the query and the role name.
    const moved = classifyMovedDatabaseError(err);
    if (moved) {
      const orgId = c.get('orgId');
      console.warn(`${options.service}: workspace database moved (${moved}), org ${orgId ?? 'unknown'}`);
      // A rotated password means the URL in the cached entry is dead. Drop the
      // entry so the next request resolves the workspace from master again
      // instead of failing the same way until the TTL runs out.
      if (moved === 'password_rotated') await forgetWorkspaceContext(c.env, orgId, c.get('internalWorkspaceId'));
      return workspaceMovingResponse(c);
    }

    console.error(`${options.service} error:`, err);
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      500,
    );
  });

  return app;
}

/**
 * The authenticated-API guard: Clerk JWT → tenant DB for the active org →
 * app licence → feature flags. Mount on `/api/*` after the public routes.
 */
export function apiAuth(): MiddlewareHandler[] {
  return [
    clerkMiddleware() as unknown as MiddlewareHandler,
    workspaceDbMiddleware() as unknown as MiddlewareHandler,
    licenceGate() as unknown as MiddlewareHandler,
    featureFlagsMiddleware() as unknown as MiddlewareHandler,
  ];
}
