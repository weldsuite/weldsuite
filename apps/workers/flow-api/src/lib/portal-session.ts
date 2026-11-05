/**
 * The client portal's workspace and session handling (FLOW-020, COM-007
 * pattern): the portal is public, so there is no Clerk session. The workspace
 * comes from a slug (sign-in) or from the session (everything after), the
 * caller from a hashed session token in KV, and access is checked against
 * `project_stakeholders.portal_access` on every request, so switching it off
 * takes effect at once.
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { normalizePortalSlug } from '@weldsuite/commerce-domain/portal-slug';
import {
  kvDelete,
  kvGetJson,
  kvPutJson,
  sha256Hex,
  type PortalKvEnv,
} from '@weldsuite/commerce-domain/portal-tokens';
import {
  PORTAL_MESSAGES,
  PORTAL_SESSION_TTL_SECONDS,
  PORTAL_SLUG_TTL_SECONDS,
  portalSessionKey,
  portalSlugKey,
  sessionNeedsRefresh,
  type PortalSessionRecord,
  type PortalSlugEntry,
} from '@weldsuite/flow-domain/project-portal';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, type Database } from '@weldsuite/worker-kit/db';
import { error } from '@weldsuite/worker-kit/response';
import { portalProjectRows } from '../services/project-portal';
import type { Env, Variables } from '../types';

/** What the portal's handlers read from the context, after {@link portalSession}. */
export type PortalVariables = Variables & {
  portalSession: PortalSessionRecord;
  /** The session token as the client sent it. */
  portalToken: string;
};

export type PortalContext = Context<{ Bindings: Env; Variables: PortalVariables }>;

/** A workspace opened for a portal request. */
export interface OpenedWorkspace {
  db: Database;
  workspaceId: string;
  clerkOrgId: string | null;
  slug: string;
  name: string;
}

/**
 * The workspace of a slug and its tenant database. Null for a slug that is not a
 * workspace's (malformed, unknown or inactive). A test (or any caller) that
 * already put a tenant database on the context skips the master lookup.
 *
 * The slug is matched exactly: there is no prefix fallback, so a request cannot
 * enumerate workspaces.
 */
export async function openWorkspaceBySlug(
  c: Context<{ Bindings: Env; Variables: PortalVariables }>,
  rawSlug: string,
): Promise<OpenedWorkspace | null> {
  const slug = normalizePortalSlug(rawSlug);
  if (!slug) return null;

  const preset = c.get('tenantDb');
  if (preset) {
    return {
      db: preset,
      workspaceId: c.get('workspaceId'),
      clerkOrgId: c.get('clerkOrgId') ?? null,
      slug,
      name: slug,
    };
  }

  const cacheKey = portalSlugKey(slug);
  let entry = await kvGetJson<PortalSlugEntry>(c.env, cacheKey);
  if (!entry) {
    const [workspace] = await getMasterDb(c.env)
      .select({
        id: masterSchema.workspaces.id,
        clerkOrgId: masterSchema.workspaces.clerkOrgId,
        name: masterSchema.workspaces.name,
        isActive: masterSchema.workspaces.isActive,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.slug, slug))
      .limit(1);
    if (!workspace?.isActive || !workspace.clerkOrgId) return null;
    entry = { workspaceId: workspace.id, clerkOrgId: workspace.clerkOrgId, name: workspace.name };
    await kvPutJson(c.env, cacheKey, entry, PORTAL_SLUG_TTL_SECONDS);
  }
  const db = await getTenantDbForWorkspace(c.env, entry.clerkOrgId);
  return { db, workspaceId: entry.workspaceId, clerkOrgId: entry.clerkOrgId, slug, name: entry.name };
}

/** The session token: `Authorization: Bearer <token>`. */
function readBearer(c: { req: { header(name: string): string | undefined } }): string | undefined {
  const header = c.req.header('Authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

/** Store a session record under its token's hash. */
export async function storeSession(env: PortalKvEnv, token: string, record: PortalSessionRecord): Promise<void> {
  await kvPutJson(env, portalSessionKey(await sha256Hex(token)), record, PORTAL_SESSION_TTL_SECONDS);
}

/** End a session. */
export async function endSession(env: PortalKvEnv, token: string): Promise<void> {
  await kvDelete(env, portalSessionKey(await sha256Hex(token)));
}

/**
 * Session middleware for everything after sign-in. A request needs a live
 * session token; the workspace is the session's own (a token cannot be used in
 * another workspace); and at least one of the session's contacts must still
 * hold portal access on a live project, or the answer is 401 "Access revoked".
 * A session used again more than a day after it was last written gets a new
 * 30-day TTL (sliding expiry).
 */
export const portalSession = createMiddleware<{ Bindings: Env; Variables: PortalVariables }>(async (c, next) => {
  const token = readBearer(c);
  if (!token) return error.unauthorized(c, PORTAL_MESSAGES.signInRequired);

  const session = await kvGetJson<PortalSessionRecord>(c.env, portalSessionKey(await sha256Hex(token)));
  if (!session) return error.unauthorized(c, PORTAL_MESSAGES.sessionExpired);

  const preset = c.get('tenantDb');
  if (preset) {
    if (session.workspaceId !== c.get('workspaceId')) return error.unauthorized(c, PORTAL_MESSAGES.sessionExpired);
  } else {
    try {
      c.set('tenantDb', await getTenantDbForWorkspace(c.env, session.clerkOrgId ?? session.workspaceId));
    } catch (err) {
      console.error('[flow-api/public-project-portal] could not open the workspace:', err);
      return error.internal(c, 'Failed to resolve workspace');
    }
    c.set('workspaceId', session.workspaceId);
    if (session.clerkOrgId) {
      c.set('clerkOrgId', session.clerkOrgId);
      c.set('orgId', session.clerkOrgId);
    }
  }

  // Revocation: the access is read from the tenant database on every request.
  const projects = await portalProjectRows(c.get('tenantDb'), session.contactIds, session.email);
  if (projects.length === 0) return error.unauthorized(c, PORTAL_MESSAGES.accessRevoked);

  const now = new Date();
  if (sessionNeedsRefresh(session.lastSeenAt, now)) {
    const refreshed: PortalSessionRecord = { ...session, lastSeenAt: now.toISOString() };
    c.executionCtx.waitUntil(storeSession(c.env, token, refreshed).catch((err: unknown) => {
      console.error('[flow-api/public-project-portal] could not refresh the session:', err);
    }));
  }

  // Entity events carry the contact as the actor; a handler that acts for one contact sets that contact's id.
  c.set('userId', session.contactIds[0] ?? '');
  c.set('portalSession', session);
  c.set('portalToken', token);
  await next();
});
