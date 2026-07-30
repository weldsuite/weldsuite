import type { MiddlewareHandler } from 'hono';
import { createClerkClient } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { and, isNull } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { TenantTier } from '@weldsuite/db/schema/master';
import * as tenantSchema from '@weldsuite/db/schema';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  createDrizzlePermissionQueries,
  resolveEffectivePermissions,
} from '@weldsuite/permissions/server';
import { createTenantDb } from '../api/db';
import type { McpSession, HonoEnv } from '../lib/api-types';
import { clerkFrontendApiUrl, protectedResourceMetadataUrl } from '../lib/well-known';

const KV_TTL_SECONDS = 300;

/**
 * Ask Clerk's OIDC userinfo endpoint which organization a token is scoped to.
 *
 * Needed because an OAuth application can be configured to issue **opaque**
 * access tokens instead of JWTs (Clerk's escape hatch for instant revocation).
 * Opaque tokens have no readable payload, so there is no `org_id` claim to
 * decode — `/oauth/userinfo` is the only way to recover the org, and it returns
 * `org_id` / `org_name` / `org_slug` whenever `user:org:read` was granted.
 *
 * Cached in KV by token id: the org is chosen at consent and fixed for the life
 * of the token, so this costs one round trip per token rather than per request.
 */
async function fetchOrgFromUserinfo(
  kv: KVNamespace,
  publishableKey: string,
  token: string,
  tokenId: string,
): Promise<{ orgId: string | null; orgName: string | null }> {
  const cacheKey = `mcp:userinfo:${tokenId}`;
  const cached = (await kv.get(cacheKey, 'json')) as {
    orgId: string | null;
    orgName: string | null;
  } | null;
  if (cached) return cached;

  const res = await fetch(`${clerkFrontendApiUrl(publishableKey)}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`userinfo returned ${res.status}`);
  }

  const body = (await res.json()) as { org_id?: string; org_name?: string };
  const result = {
    orgId: body.org_id ?? null,
    orgName: body.org_name ?? null,
  };

  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: KV_TTL_SECONDS });

  // Logged on cache miss only — once per token rather than once per request —
  // so the org-resolution path stays observable without flooding the logs.
  console.log(
    `[MCP Auth] userinfo resolved org ${result.orgId ?? '(none)'} for token ${tokenId}`,
  );

  return result;
}

interface CachedWorkspace {
  workspaceId: string;
  name: string;
  tier: TenantTier;
  databaseUrl: string;
}

function getTierFromPlan(planSlug: string | null | undefined): TenantTier {
  if (!planSlug) return 'free';
  if (['free', 'business', 'scale', 'enterprise'].includes(planSlug)) {
    return planSlug as TenantTier;
  }
  return 'free';
}

/**
 * Decode the payload of an *already-verified* OAuth access token.
 *
 * Clerk's SDK deliberately models an OAuth token as an `IdPOAuthAccessToken`
 * (`id`, `clientId`, `subject`, `scopes`, …) which carries **no organization**,
 * even though the token itself does when the client was granted the
 * `user:org:read` scope. Since WeldSuite's entire tenancy model keys off
 * `workspaces.clerk_org_id`, we read the claim ourselves.
 *
 * Returns `null` for opaque (`oat_`) tokens, which have no readable payload.
 *
 * Safe only because the caller has already had Clerk verify the signature and
 * expiry — this function performs no validation of its own.
 */
function decodeVerifiedJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a Clerk organization to its workspace and tenant database, cached in
 * KV. The MCP server serves tool calls from its own copy of the v1 routes, so
 * it needs a real tenant connection string, not just an identifier.
 */
async function getWorkspaceForOrg(
  kv: KVNamespace,
  masterDb: ReturnType<typeof drizzleNeonHttp>,
  clerkOrgId: string,
  neonApiKey: string,
  keyring?: string | EncryptionKeyring,
): Promise<CachedWorkspace | null> {
  const cacheKey = `mcp:org:${clerkOrgId}`;
  const cached = (await kv.get(cacheKey, 'json')) as CachedWorkspace | null;
  if (cached) return cached;

  const [row] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      name: masterSchema.workspaces.name,
      planSlug: masterSchema.plans.slug,
      neonProjectId: masterSchema.workspaces.neonProjectId,
      neonBranchId: masterSchema.workspaces.neonBranchId,
      neonRoleName: masterSchema.workspaces.neonRoleName,
      neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
      databaseUrl: masterSchema.workspaces.databaseUrl,
    })
    .from(masterSchema.workspaces)
    .leftJoin(masterSchema.plans, eq(masterSchema.workspaces.planId, masterSchema.plans.id))
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!row?.neonProjectId || !row?.neonBranchId || !row?.neonRoleName) return null;

  const databaseUrl = await resolveDatabaseUrl(
    neonApiKey,
    {
      neonProjectId: row.neonProjectId,
      neonBranchId: row.neonBranchId,
      neonRoleName: row.neonRoleName,
      neonDatabaseName: row.neonDatabaseName,
      databaseUrl: row.databaseUrl,
    },
    keyring,
  );

  const result: CachedWorkspace = {
    workspaceId: row.id,
    name: row.name,
    tier: getTierFromPlan(row.planSlug),
    databaseUrl,
  };
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: KV_TTL_SECONDS });

  return result;
}

/**
 * Hono middleware enforcing Clerk OAuth authentication on the MCP endpoint.
 *
 * On any failure it replies `401` with a `WWW-Authenticate` header pointing at
 * this server's protected-resource metadata. That header is the entire
 * bootstrap of the MCP OAuth flow: a client makes an unauthenticated call,
 * reads `resource_metadata` off the 401, discovers Clerk as the authorization
 * server, registers itself, and retries with a token.
 */
export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  // Every 401 logs a diagnostic. Two of these branches used to return silently,
  // which made "connected but nothing works" impossible to tell apart from
  // "request never arrived" in the Workers logs.
  const unauthorized = (message: string, diagnostic: string) => {
    console.error(`[MCP Auth] 401 — ${diagnostic}`);
    return c.json(
      { jsonrpc: '2.0', error: { code: -32001, message }, id: null },
      401,
      {
        'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(c.env.MCP_SERVER_URL)}"`,
      },
    );
  };

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(
      'Missing bearer token. Authenticate with OAuth to use this MCP server.',
      `no bearer token (Authorization header ${authHeader ? 'present but not Bearer' : 'absent'})`,
    );
  }
  const token = authHeader.slice(7).trim();

  let tokenId: string;
  let userId: string;
  let clientId: string | null;

  try {
    const clerk = createClerkClient({
      secretKey: c.env.CLERK_SECRET_KEY,
      publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    });

    const requestState = await clerk.authenticateRequest(c.req.raw, {
      acceptsToken: 'oauth_token',
      ...(c.env.CLERK_JWT_KEY ? { jwtKey: c.env.CLERK_JWT_KEY } : {}),
    });

    const auth = requestState.toAuth();
    if (!auth || !auth.isAuthenticated) {
      return unauthorized(
        'Invalid or expired access token.',
        `token rejected by Clerk (tokenType=${auth?.tokenType ?? 'none'}, reason=${requestState.reason ?? 'unknown'})`,
      );
    }

    tokenId = auth.id;
    userId = auth.userId;
    clientId = auth.clientId;
  } catch (error) {
    console.error('[MCP Auth] Token verification threw:', error);
    return unauthorized(
      'Access token could not be verified.',
      `verification threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Clerk drops the org from the typed auth object, so recover it ourselves.
  //
  // JWT access tokens carry it as an `org_id` claim, which is free to read. But
  // an OAuth application can be configured to issue opaque tokens instead, and
  // those have no payload at all — for them the userinfo endpoint is the only
  // route. Try the free path first, then fall back to the network call.
  const payload = decodeVerifiedJwtPayload(token);
  let clerkOrgId =
    (payload?.org_id as string | undefined) ??
    ((payload?.o as { id?: string } | undefined)?.id ?? null);

  if (!clerkOrgId) {
    try {
      const userinfo = await fetchOrgFromUserinfo(
        c.env.API_CACHE,
        c.env.CLERK_PUBLISHABLE_KEY,
        token,
        tokenId,
      );
      clerkOrgId = userinfo.orgId;
    } catch (error) {
      console.error('[MCP Auth] userinfo lookup failed:', error);
    }
  }

  if (!clerkOrgId) {
    // Claim names only — never values, which carry user identifiers.
    return unauthorized(
      'Token is not scoped to an organization. Re-authorize requesting the "user:org:read" scope and select a workspace.',
      `no org_id for user ${userId} via client ${clientId}: ` +
        `format=${payload ? 'jwt' : 'opaque'}, ` +
        `claims=[${payload ? Object.keys(payload).sort().join(',') : ''}], ` +
        'userinfo also had none — the client most likely lacks the user:org:read scope',
    );
  }

  console.log(`[MCP Auth] org ${clerkOrgId} resolved from ${orgSource} for user ${userId}`);

  const masterSql = neon(c.env.DATABASE_URL_MASTER);
  const masterDb = drizzleNeonHttp({ client: masterSql, schema: masterSchema });

  let workspace: CachedWorkspace | null;
  try {
    workspace = await getWorkspaceForOrg(
      c.env.API_CACHE,
      masterDb,
      clerkOrgId,
      c.env.NEON_API_KEY,
      keyringFromEnv(c.env),
    );
  } catch (error) {
    console.error('[MCP Auth] Workspace lookup failed:', error);
    return c.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Could not resolve workspace.' }, id: null },
      500,
    );
  }

  if (!workspace) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message: 'No WeldSuite workspace is linked to the selected organization.',
        },
        id: null,
      },
      403,
    );
  }

  // Authorization comes from the user's real workspace role — never from the
  // token. A member who cannot delete leads in the UI cannot delete them
  // through an AI assistant either.
  let permissions: string[];
  let role: string;
  let roleId: string | null;
  try {
    const tenantDb = createTenantDb(workspace.databaseUrl);
    const queries = createDrizzlePermissionQueries(tenantDb, tenantSchema, {
      eq,
      and,
      isNull,
    });
    const resolved = await resolveEffectivePermissions(queries, userId);
    permissions = resolved.permissions;
    role = resolved.role;
    roleId = resolved.roleId;
  } catch (error) {
    console.error('[MCP Auth] Permission resolution failed:', error);
    return c.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Could not resolve permissions.' }, id: null },
      500,
    );
  }

  // No role means the Clerk user is not a member of this workspace. Treat it as
  // a hard failure rather than an empty tool list, so the cause is obvious.
  if (!role) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message: 'You are not a member of this workspace.',
        },
        id: null,
      },
      403,
    );
  }

  // A member whose role resolves to zero permissions would otherwise get a
  // successful connection with an empty toolbox — indistinguishable from a
  // broken server. Fail loudly and name the role so the cause is actionable.
  //
  // The usual causes are a `role` value that isn't one of the system roles
  // (OWNER/ADMIN/MEMBER/VIEWER — the lookup is case-sensitive) or a custom
  // `roleId` whose permission list is empty.
  if (permissions.length === 0) {
    console.error(
      `[MCP Auth] Zero permissions for user ${userId} in workspace ${workspace.workspaceId} (role=${JSON.stringify(role)}, roleId=${JSON.stringify(roleId)})`,
    );
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message:
            `Your workspace role (${role}) grants no permissions, so no tools are available. ` +
            'Expected one of OWNER, ADMIN, MEMBER or VIEWER, or a custom role with permissions assigned.',
        },
        id: null,
      },
      403,
    );
  }

  const session: McpSession = {
    tokenId,
    userId,
    clerkOrgId,
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.name,
    tier: workspace.tier,
    databaseUrl: workspace.databaseUrl,
    permissions,
    role,
    clientId,
  };

  c.set('session', session);
  await next();
};
