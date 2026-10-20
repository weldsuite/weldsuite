/**
 * Guard for the `/test-fixtures/*` router (E2E seed + reset endpoints).
 *
 * The router can seed rows into, and hard-delete rows from, the tenant DB of
 * any workspace named by the `X-Test-Workspace-Id` header, with no Clerk JWT.
 * It is therefore fail-closed in three steps; each one answers before the next
 * runs:
 *
 *   1. Environment allowlist (`testFixturesEnvironmentGate`). The router is only
 *      served when `ENVIRONMENT` is exactly one of `TEST_FIXTURES_ENVIRONMENTS`
 *      (local `wrangler dev` and the `test` deployment, the only places the E2E
 *      suite runs). `production`, a missing `ENVIRONMENT` and a misspelled one
 *      all answer 404, the same as any unknown path, so the surface is not
 *      advertised. `index.ts` runs this gate in front of the mount, and
 *      `testFixturesGuard` repeats it as the router's first middleware.
 *   2. `X-Test-Token` must match `TEST_FIXTURES_TOKEN`, compared in constant
 *      time. The secret is only ever set on the `test` deployment; when it is
 *      unset the router answers 503 rather than skipping the check.
 *   3. `X-Test-Workspace-Id` (Clerk org id) is resolved into a tenant DB so
 *      the seed endpoints can write rows without a Clerk JWT.
 */

import { createMiddleware } from 'hono/factory';
import { getTenantDbForWorkspace, type Database } from '@weldsuite/worker-kit/db';
import { secretMatches } from '@weldsuite/worker-kit/webhook-token';
import type { Env } from '../types';

type TestFixturesVariables = {
  tenantDb: Database;
  workspaceId: string;
};

/**
 * `ENVIRONMENT` values the router may be served in: the top-level `[vars]` of
 * wrangler.toml (`development`, i.e. `wrangler dev`) and `[env.test.vars]`.
 * Anything else, `production` included, gets a 404.
 */
export const TEST_FIXTURES_ENVIRONMENTS: readonly string[] = ['development', 'test'];

/** True only for an `ENVIRONMENT` value that is explicitly on the allowlist. */
export function isTestFixturesEnvironment(environment: string | undefined | null): boolean {
  return typeof environment === 'string' && TEST_FIXTURES_ENVIRONMENTS.includes(environment);
}

/**
 * 404 unless `ENVIRONMENT` is on the allowlist. Mount it in front of
 * `/test-fixtures` so a production (or unconfigured) deploy never enters the
 * router at all. The body is the app's own notFound response, identical to any
 * unknown path.
 */
export const testFixturesEnvironmentGate = () =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    if (!isTestFixturesEnvironment(c.env.ENVIRONMENT)) {
      return c.notFound();
    }
    await next();
  });

export const testFixturesGuard = () => {
  return createMiddleware<{
    Bindings: Env;
    Variables: TestFixturesVariables;
  }>(async (c, next) => {
    // Second environment check, in case the router is ever mounted without the
    // gate in front of it.
    if (!isTestFixturesEnvironment(c.env.ENVIRONMENT)) {
      return c.notFound();
    }

    const expected = c.env.TEST_FIXTURES_TOKEN;
    if (!expected) {
      return c.json(
        {
          error: {
            code: 'NOT_CONFIGURED',
            message: 'TEST_FIXTURES_TOKEN is not set in this environment',
          },
        },
        503,
      );
    }

    if (!secretMatches(c.req.header('X-Test-Token'), expected)) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid test token' } },
        401,
      );
    }

    const workspaceId = c.req.header('X-Test-Workspace-Id');
    if (!workspaceId) {
      return c.json(
        {
          error: {
            code: 'WORKSPACE_REQUIRED',
            message: 'X-Test-Workspace-Id header is required',
          },
        },
        400,
      );
    }

    try {
      const db = await getTenantDbForWorkspace(c.env, workspaceId);
      c.set('tenantDb', db);
      c.set('workspaceId', workspaceId);
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'WORKSPACE_NOT_FOUND',
            message:
              err instanceof Error
                ? err.message
                : 'Could not resolve tenant database',
          },
        },
        404,
      );
    }

    await next();
  });
};
