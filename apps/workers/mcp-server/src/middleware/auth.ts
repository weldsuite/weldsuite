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
import { protectedResourceMetadataUrl } from '../lib/well-known';

const KV_TTL_SECONDS = 300;

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
 * Read the `org_id` claim out of a *already-verified* OAuth access token.
 *
 * Clerk's SDK deliberately models an OAuth token as an `IdPOAuthAccessToken`
 * (`id`, `clientId`, `subject`, `scopes`, …) which carries **no organization**,
 * even though the token itself does when the client was granted the
 * `user:org:read` scope. Since WeldSuite's entire tenancy model keys off
 * `workspaces.clerk_org_id`, we decode the claim ourselves.
 *
 * Safe only because the caller has already had Clerk verify the signature and
 * expiry — this function performs no validation of its own.
 */
function readOrgIdFromVerifiedJwt(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded)) as { org_id?: string; o?: { id?: string } };
    return payload.org_id ?? payload.o?.id ?? null;
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
  const unauthorized = (message: string) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32001, message }, id: null },
      401,
      {
        'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(c.env.MCP_SERVER_URL)}"`,
      },
    );

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized('Missing bearer token. Authenticate with OAuth to use this MCP server.');
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
      return unauthorized('Invalid or expired access token.');
    }

    tokenId = auth.id;
    userId = auth.userId;
    clientId = auth.clientId;
  } catch (error) {
    console.error('[MCP Auth] Token verification failed:', error);
    return unauthorized('Access token could not be verified.');
  }

  // Clerk drops the org from the typed auth object, so read it off the token.
  const clerkOrgId = readOrgIdFromVerifiedJwt(token);
  if (!clerkOrgId) {
    return unauthorized(
      'Token is not scoped to an organization. Re-authorize requesting the "user:org:read" scope and select a workspace.',
    );
  }

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
