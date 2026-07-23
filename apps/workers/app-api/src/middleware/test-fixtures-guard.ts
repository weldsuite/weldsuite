/**
 * Two-layer guard for the `/test-fixtures/*` router:
 *
 *   1. `c.env.ENVIRONMENT !== 'production'` — belt-and-braces; the router
 *      is also conditionally mounted in `index.ts`, but if a deploy ever
 *      accidentally enables it, the env check stops the request cold.
 *   2. `X-Test-Token` header must match `c.env.TEST_FIXTURES_TOKEN` —
 *      the actual auth. Secret only exists in test/preview envs.
 *
 * The router also accepts an `X-Test-Workspace-Id` header (Clerk org id)
 * which is resolved into a tenant DB so seed endpoints can write rows
 * without a Clerk JWT.
 */

import { createMiddleware } from 'hono/factory';
import { getTenantDbForWorkspace, type Database } from '../db';
import type { Env } from '../types';

type TestFixturesVariables = {
  tenantDb: Database;
  workspaceId: string;
};

export const testFixturesGuard = () => {
  return createMiddleware<{
    Bindings: Env;
    Variables: TestFixturesVariables;
  }>(async (c, next) => {
    if (c.env.ENVIRONMENT === 'production') {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Not found' } },
        404,
      );
    }

    const expected = (c.env as Env & { TEST_FIXTURES_TOKEN?: string })
      .TEST_FIXTURES_TOKEN;
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

    const provided = c.req.header('X-Test-Token');
    if (!provided || provided !== expected) {
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
