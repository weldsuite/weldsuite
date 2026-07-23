import type { Context, MiddlewareHandler } from 'hono';
import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { apiKeys } from '@weldsuite/db/schema/api-keys';
import { workspaceApiKeys } from '@weldsuite/db/schema/workspace-api-keys';
import * as tenantSchema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { ApiKeySession, HonoEnv } from '../lib/api-types';
import type { TenantTier } from '@weldsuite/db/schema/master';

const KV_TTL_SECONDS = 300;

interface CachedRegistryEntry {
  workspaceId: string;
  keyType: string;
  tenantKeyId: string;
}

interface CachedWorkspaceDetails {
  databaseUrl: string;
  tier: TenantTier;
  hasApiAccess: boolean;
}

function extractApiKey(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token.startsWith('wsk_')) return token;
  }

  const apiKeyHeader = c.req.header('X-Api-Key');
  if (apiKeyHeader?.startsWith('wsk_')) return apiKeyHeader;

  // Support API key in URL query parameter (for MCP clients like Claude Desktop
  // that use mcp-remote and can't set custom headers)
  const url = new URL(c.req.url);
  const queryKey = url.searchParams.get('key');
  if (queryKey?.startsWith('wsk_')) return queryKey;

  return null;
}

async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getTierFromPlan(planSlug: string | null | undefined): TenantTier {
  if (!planSlug) return 'free';
  if (['free', 'business', 'scale', 'enterprise'].includes(planSlug)) {
    return planSlug as TenantTier;
  }
  return 'free';
}

async function getRegistryEntry(
  kv: KVNamespace,
  masterDb: ReturnType<typeof drizzleNeonHttp>,
  keyHash: string,
): Promise<CachedRegistryEntry | null> {
  const cacheKey = `akr:${keyHash}`;
  const cached = (await kv.get(cacheKey, 'json')) as CachedRegistryEntry | null;
  if (cached) return cached;

  const [entry] = await masterDb
    .select({
      workspaceId: masterSchema.apiKeyRegistry.workspaceId,
      keyType: masterSchema.apiKeyRegistry.keyType,
      tenantKeyId: masterSchema.apiKeyRegistry.tenantKeyId,
    })
    .from(masterSchema.apiKeyRegistry)
    .where(eq(masterSchema.apiKeyRegistry.keyHash, keyHash))
    .limit(1);

  if (!entry) return null;

  const result: CachedRegistryEntry = {
    workspaceId: entry.workspaceId,
    keyType: entry.keyType,
    tenantKeyId: entry.tenantKeyId,
  };
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: KV_TTL_SECONDS });

  return result;
}

async function getWorkspaceDetails(
  kv: KVNamespace,
  masterDb: ReturnType<typeof drizzleNeonHttp>,
  workspaceId: string,
  neonApiKey: string,
  encryptionKey?: string | EncryptionKeyring,
): Promise<CachedWorkspaceDetails | null> {
  const cacheKey = `ws:${workspaceId}`;
  const cached = (await kv.get(cacheKey, 'json')) as CachedWorkspaceDetails | null;
  if (cached) return cached;

  const [row] = await masterDb
    .select({
      neonProjectId: masterSchema.workspaces.neonProjectId,
      neonBranchId: masterSchema.workspaces.neonBranchId,
      neonRoleName: masterSchema.workspaces.neonRoleName,
      neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
      databaseUrl: masterSchema.workspaces.databaseUrl,
      planSlug: masterSchema.plans.slug,
      hasApiAccess: masterSchema.plans.hasApiAccess,
    })
    .from(masterSchema.workspaces)
    .leftJoin(masterSchema.plans, eq(masterSchema.workspaces.planId, masterSchema.plans.id))
    .where(eq(masterSchema.workspaces.id, workspaceId))
    .limit(1);

  if (!row?.neonProjectId || !row?.neonBranchId || !row?.neonRoleName) return null;

  const databaseUrl = await resolveDatabaseUrl(neonApiKey, row as any, encryptionKey);

  const result: CachedWorkspaceDetails = {
    databaseUrl,
    tier: getTierFromPlan(row.planSlug),
    hasApiAccess: row.hasApiAccess ?? false,
  };
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: KV_TTL_SECONDS });

  return result;
}

async function validateApiKey(c: Context<HonoEnv>, apiKey: string): Promise<ApiKeySession | null> {
  try {
    const keyHash = await hashApiKey(apiKey);
    const now = new Date();
    const kv = c.env.API_CACHE;

    const masterSql = neon(c.env.DATABASE_URL_MASTER);
    const masterDb = drizzleNeonHttp({ client: masterSql, schema: masterSchema });

    const registryEntry = await getRegistryEntry(kv, masterDb, keyHash);
    if (!registryEntry) return null;

    const workspace = await getWorkspaceDetails(
      kv,
      masterDb,
      registryEntry.workspaceId,
      c.env.NEON_API_KEY,
      keyringFromEnv(c.env),
    );
    if (!workspace) return null;

    const sql = neon(workspace.databaseUrl);
    const tenantDb = drizzleNeonHttp({ client: sql, schema: tenantSchema });

    if (registryEntry.keyType === 'workspace') {
      const [workspaceKey] = await tenantDb
        .select()
        .from(workspaceApiKeys)
        .where(
          and(
            eq(workspaceApiKeys.id, registryEntry.tenantKeyId),
            isNull(workspaceApiKeys.deletedAt),
            or(isNull(workspaceApiKeys.expiresAt), gt(workspaceApiKeys.expiresAt, now)),
          ),
        )
        .limit(1);

      if (!workspaceKey) return null;

      tenantDb
        .update(workspaceApiKeys)
        .set({ lastUsedAt: now })
        .where(eq(workspaceApiKeys.id, workspaceKey.id))
        .execute()
        .catch(console.error);

      return {
        keyId: workspaceKey.id,
        keyType: 'workspace',
        workspaceId: registryEntry.workspaceId,
        userId: null,
        scopes: (workspaceKey.scopes as string[]) || [],
        tier: workspace.tier,
        hasApiAccess: workspace.hasApiAccess,
        databaseUrl: workspace.databaseUrl,
        apiKey,
      };
    } else {
      const [personalKey] = await tenantDb
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, registryEntry.tenantKeyId),
            isNull(apiKeys.deletedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
          ),
        )
        .limit(1);

      if (!personalKey) return null;

      tenantDb
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(eq(apiKeys.id, personalKey.id))
        .execute()
        .catch(console.error);

      return {
        keyId: personalKey.id,
        keyType: 'personal',
        workspaceId: registryEntry.workspaceId,
        userId: personalKey.userId,
        scopes: (personalKey.scopes as string[]) || [],
        tier: workspace.tier,
        hasApiAccess: workspace.hasApiAccess,
        databaseUrl: workspace.databaseUrl,
        apiKey,
      };
    }
  } catch (error) {
    console.error('[MCP Auth] Error validating key:', error);
    return null;
  }
}

/**
 * Hono middleware for API key authentication
 * Validates wsk_ API keys and sets session in context
 */
export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const apiKey = extractApiKey(c);

  if (!apiKey) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Missing API key. Provide a valid key via Authorization: Bearer wsk_... or X-Api-Key header.',
        },
        id: null,
      },
      401,
    );
  }

  const session = await validateApiKey(c, apiKey);

  if (!session) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Invalid API key. The key may have been revoked, expired, or does not exist.',
        },
        id: null,
      },
      401,
    );
  }

  if (!session.hasApiAccess) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32003,
          message: 'API access is not available on your current plan. Please upgrade to a plan with API access.',
        },
        id: null,
      },
      403,
    );
  }

  c.set('apiSession', session);
  await next();
};
