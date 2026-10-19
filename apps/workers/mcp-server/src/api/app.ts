import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { appNotLicensedBody, findModuleForExternalPath, missingLicensedApp } from '@weldsuite/api-modules';
import { classifyMovedDatabaseError, workspaceMovingResponse } from '@weldsuite/worker-kit/workspace-moving';
import { v1 } from './routes/v1';
import { createTenantDb } from './db';
import type { ApiKeySession, HonoEnv } from './types';
import type { Env } from '../types/env';
import type { McpSession } from '../lib/api-types';
import { isReadOnlyRequestAllowed, workspaceReadOnlyBody } from '../lib/read-only';
import { forgetWorkspaceForOrg } from '../lib/workspace-cache';

/**
 * Origin used when dispatching into the internal API. Never leaves the worker —
 * `apiApp.fetch()` is called directly, so only the path and query matter.
 */
export const INTERNAL_ORIGIN = 'https://mcp.internal';

/**
 * Key under which the authenticated session is smuggled into the Hono `env`
 * for an internal dispatch. This lets the resource routes be mounted once at
 * module scope while still receiving a per-request session — Hono's `fetch()`
 * takes the env as an argument, so each call can carry its own.
 */
const SESSION_KEY = '__mcpSession';

/** Env as seen by the internal API app: real bindings plus the request session. */
export type InternalEnv = Env & { [SESSION_KEY]: McpSession };

/** Build the env object handed to a single internal dispatch. */
export function internalEnv(env: Env, session: McpSession): InternalEnv {
  return { ...env, [SESSION_KEY]: session };
}

/**
 * Translate the OAuth-derived MCP session into the session shape the ported
 * external-api routes expect. Keeping the translation in one place is what
 * allows `src/api/routes` to stay an unmodified copy.
 */
function toApiSession(session: McpSession): ApiKeySession {
  return {
    keyId: session.tokenId,
    keyType: 'personal',
    workspaceId: session.workspaceId,
    userId: session.userId,
    // `scopes` carries effective permissions here — see `api/lib/scopes.ts`.
    scopes: session.permissions,
    permissionDenies: session.permissionDenies,
    tier: session.tier,
    clerkOrgId: session.clerkOrgId,
    databaseUrl: session.databaseUrl,
  };
}

/**
 * The MCP server's own copy of the v1 resource API.
 *
 * Mounted once at module scope and invoked in-process by `lib/proxy.ts`, so a
 * tool call costs no network hop and the server depends on no other worker.
 */
export const apiApp = new Hono<HonoEnv>();

apiApp.use('*', async (c, next) => {
  const session = (c.env as InternalEnv)[SESSION_KEY];

  if (!session) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Internal dispatch is missing its session' } },
      500,
    );
  }

  // A licensed (partner-managed) workspace reaches only the modules its apps
  // read; the same table the first-party workers use (`@weldsuite/api-modules`).
  if (session.licensedApps) {
    const missing = missingLicensedApp(
      findModuleForExternalPath(c.req.path),
      new Set(session.licensedApps),
    );
    if (missing) return c.json(appNotLicensedBody(missing), 403);
  }

  // A read-only workspace (partner suspended or licence inactive) may be read
  // and exported but not changed. One whose tenant database is being moved
  // (TASK-1150) gets the same exceptions, and is told to retry instead:
  // 503 WORKSPACE_MOVING.
  if (session.readOnly && !isReadOnlyRequestAllowed(c.req.method, c.req.path)) {
    const reason = session.readOnlyReason;
    if (reason === 'database_move') return workspaceMovingResponse(c);
    return c.json(workspaceReadOnlyBody(reason), 403);
  }

  const apiSession = toApiSession(session);
  c.set('apiSession', apiSession);
  c.set('tenantDb', createTenantDb(session.databaseUrl));
  c.set('workspaceId', session.workspaceId);
  c.set('userId', session.userId);

  await next();
});

apiApp.route('/v1', v1);

/**
 * Errors thrown by a route. A tenant database that moved under the request
 * (source set read-only, 25006; role password rotated, 28P01) is answered with
 * 503 WORKSPACE_MOVING, which `lib/proxy.ts` turns into a tool error saying to
 * try again; a rotated password also drops the cached tenant URL. Everything
 * else keeps Hono's own default handling (an HTTPException's response, else a
 * logged 500).
 */
apiApp.onError(async (err, c) => {
  const moved = classifyMovedDatabaseError(err);
  if (moved) {
    // Only a classification is logged: the error's message can carry the query
    // and the role name.
    const clerkOrgId = c.get('apiSession')?.clerkOrgId;
    console.warn(`[MCP Server] workspace database moved (${moved}), org ${clerkOrgId ?? 'unknown'}`);
    if (moved === 'password_rotated' && clerkOrgId) await forgetWorkspaceForOrg(c.env?.API_CACHE, clerkOrgId);
    return workspaceMovingResponse(c);
  }
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.text('Internal Server Error', 500);
});
