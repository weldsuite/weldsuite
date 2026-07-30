import { Hono } from 'hono';
import { v1 } from './routes/v1';
import { createTenantDb } from './db';
import type { ApiKeySession, HonoEnv } from './types';
import type { Env } from '../types/env';
import type { McpSession } from '../lib/api-types';

/**
 * Origin used when dispatching into the internal API. Never leaves the worker —
 * `apiApp.fetch()` is called directly, so only the path and query matter.
 */
export const INTERNAL_ORIGIN = 'http://mcp.internal';

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
    tier: session.tier,
    hasApiAccess: true,
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

  const apiSession = toApiSession(session);
  c.set('apiSession', apiSession);
  c.set('tenantDb', createTenantDb(session.databaseUrl));
  c.set('workspaceId', session.workspaceId);
  c.set('userId', session.userId);

  await next();
});

apiApp.route('/v1', v1);
