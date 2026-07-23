import type { Context, MiddlewareHandler } from 'hono';
import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import postgres from 'postgres';
import { apiKeys } from '@weldsuite/db/schema/api-keys';
import { workspaceApiKeys } from '@weldsuite/db/schema/workspace-api-keys';
import * as tenantSchema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { ApiKeySession, HonoEnv } from '../types';
import type { TenantTier } from '@weldsuite/db/schema/master';
import { error } from '../lib/response';

// KV cache TTL in seconds (5 minutes)
const KV_TTL_SECONDS = 300;

// App-token cache TTL — SHORT because revocation (uninstall / token revoke)
// must bite fast; the token row is only re-verified on cache miss.
const APP_TOKEN_KV_TTL_SECONDS = 60;

// ============================================================================
// KV Cache Types
// ============================================================================

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

interface CachedAppToken {
  workspaceId: string;
  appId: string;
  appCode: string;
  installId: string;
  scopes: string[];
  tokenId: string;
  tokenType: string;
  /** ISO timestamp, or null for non-expiring install tokens. */
  expiresAt: string | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract API key from request headers
 * Supports both Authorization: Bearer and X-Api-Key, for workspace/personal
 * API keys (wsk_) and user-app tokens (wsat_).
 */
function extractApiKey(c: Context): string | null {
  // Try Authorization header first
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token.startsWith('wsk_') || token.startsWith('wsat_')) {
      return token;
    }
  }

  // Try X-Api-Key header
  const apiKeyHeader = c.req.header('X-Api-Key');
  if (apiKeyHeader?.startsWith('wsk_') || apiKeyHeader?.startsWith('wsat_')) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Hash API key using Web Crypto API (native to Workers)
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get tier from plan slug
 */
function getTierFromPlan(planSlug: string | null | undefined): TenantTier {
  if (!planSlug) return 'free';
  if (['free', 'business', 'scale', 'enterprise'].includes(planSlug)) {
    return planSlug as TenantTier;
  }
  return 'free';
}

// ============================================================================
// KV-cached lookups
// ============================================================================

/**
 * Look up registry entry by key hash, with KV cache
 */
async function getRegistryEntry(
  kv: KVNamespace,
  masterDb: ReturnType<typeof drizzle>,
  keyHash: string
): Promise<CachedRegistryEntry | null> {
  const cacheKey = `akr:${keyHash}`;

  // 1. Check KV cache
  const cached = await kv.get(cacheKey, 'json') as CachedRegistryEntry | null;
  if (cached) return cached;

  // 2. Cache miss — query master DB
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

  // 3. Store in KV with TTL
  const result: CachedRegistryEntry = {
    workspaceId: entry.workspaceId,
    keyType: entry.keyType,
    tenantKeyId: entry.tenantKeyId,
  };
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: KV_TTL_SECONDS });

  return result;
}

/**
 * Look up workspace details (databaseUrl resolved via Neon API, plan tier), with KV cache
 */
async function getWorkspaceDetails(
  kv: KVNamespace,
  masterDb: ReturnType<typeof drizzle>,
  workspaceId: string,
  neonApiKey: string,
  encryptionKey?: string | EncryptionKeyring,
): Promise<CachedWorkspaceDetails | null> {
  const cacheKey = `ws:${workspaceId}`;

  // 1. Check KV cache
  const cached = await kv.get(cacheKey, 'json') as CachedWorkspaceDetails | null;
  if (cached) return cached;

  // 2. Cache miss — query master DB for Neon metadata + plan
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

  // 3. Resolve connection URI — decrypt-first, fallback to Neon API
  const databaseUrl = await resolveDatabaseUrl(
    neonApiKey,
    row as any,
    encryptionKey,
  );

  // 4. Store in KV with TTL
  const result: CachedWorkspaceDetails = {
    databaseUrl,
    tier: getTierFromPlan(row.planSlug),
    hasApiAccess: row.hasApiAccess ?? false,
  };
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: KV_TTL_SECONDS });

  return result;
}

// ============================================================================
// API Key Validation
// ============================================================================

/**
 * Validate API key using KV-cached master lookups + workspace DB via Neon HTTP
 *
 * Flow:
 * 1. Hash the incoming key
 * 2. KV-cached: key_hash → {workspaceId, keyType, tenantKeyId} from master registry
 * 3. KV-cached: workspaceId → {databaseUrl, tier, hasApiAccess} from master workspaces
 * 4. Always live: verify key in workspace DB (scopes, expiry, deletedAt)
 * 5. Fire-and-forget lastUsedAt update
 */
async function validateApiKey(
  c: Context<HonoEnv>,
  apiKey: string
): Promise<ApiKeySession | null> {
  try {
    const keyHash = await hashApiKey(apiKey);
    const now = new Date();
    const kv = c.env.API_CACHE;

    // Master DB connection (used only on KV cache miss)
    const masterSql = postgres(c.env.HYPERDRIVE_MASTER.connectionString, {
      max: 1,
      prepare: false,
    });
    const masterDb = drizzle(masterSql, { schema: masterSchema });

    // Step 1: Registry lookup (KV-cached)
    const registryEntry = await getRegistryEntry(kv, masterDb, keyHash);
    if (!registryEntry) {
      return null;
    }

    // Step 2: Workspace details (KV-cached, resolves connection URI via Neon API on miss)
    const workspace = await getWorkspaceDetails(kv, masterDb, registryEntry.workspaceId, c.env.NEON_API_KEY, keyringFromEnv(c.env));
    if (!workspace) {
      return null;
    }

    // Step 3: Verify key in workspace DB (always live — catches revocations/expiry)
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
            or(isNull(workspaceApiKeys.expiresAt), gt(workspaceApiKeys.expiresAt, now))
          )
        )
        .limit(1);

      if (!workspaceKey) {
        return null;
      }

      // Fire-and-forget lastUsedAt update
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
      };
    } else {
      // Personal key
      const [personalKey] = await tenantDb
        .select()
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, registryEntry.tenantKeyId),
            isNull(apiKeys.deletedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))
          )
        )
        .limit(1);

      if (!personalKey) {
        return null;
      }

      // Fire-and-forget lastUsedAt update
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
      };
    }
  } catch (error) {
    console.error('[API Auth] Error validating key:', error);
    return null;
  }
}

// ============================================================================
// User-app token validation (wsat_)
// ============================================================================

/**
 * Validate a user-app token (`wsat_` + 40 hex chars) minted for an app install.
 *
 * Flow:
 * 1. SHA-256 the token, KV-cached lookup (`uat:{hash}`, 60s TTL) resolving
 *    the token joined to its install grant + app row. On cache miss the
 *    validity rules are checked live: token not revoked, not expired, install
 *    status 'active', app isActive and not deleted. On cache hit we still
 *    cheap-verify expiresAt so short-lived session tokens die on time.
 * 2. KV-cached workspace details for the tenant DB URL + tier.
 * 3. Fire-and-forget lastUsedAt update on the token row.
 */
async function validateAppToken(
  c: Context<HonoEnv>,
  token: string
): Promise<ApiKeySession | null> {
  try {
    const tokenHash = await hashApiKey(token);
    const now = new Date();
    const kv = c.env.API_CACHE;
    const cacheKey = `uat:${tokenHash}`;

    // Master DB connection (used on KV cache miss + lastUsedAt update)
    const masterSql = postgres(c.env.HYPERDRIVE_MASTER.connectionString, {
      max: 1,
      prepare: false,
    });
    const masterDb = drizzle(masterSql, { schema: masterSchema });

    // Step 1: Token lookup (KV-cached, short TTL)
    let cached = await kv.get(cacheKey, 'json') as CachedAppToken | null;
    if (cached) {
      // Cache hit — still cheap-verify expiry (revocation waits for the TTL).
      if (cached.expiresAt && new Date(cached.expiresAt) <= now) {
        return null;
      }
    } else {
      const [row] = await masterDb
        .select({
          tokenId: masterSchema.userAppTokens.id,
          tokenType: masterSchema.userAppTokens.tokenType,
          scopes: masterSchema.userAppTokens.scopes,
          expiresAt: masterSchema.userAppTokens.expiresAt,
          installId: masterSchema.userAppInstalls.id,
          workspaceId: masterSchema.userAppTokens.workspaceId,
          appId: masterSchema.userApps.id,
          appCode: masterSchema.userApps.code,
        })
        .from(masterSchema.userAppTokens)
        .innerJoin(
          masterSchema.userAppInstalls,
          eq(masterSchema.userAppTokens.installId, masterSchema.userAppInstalls.id),
        )
        .innerJoin(
          masterSchema.userApps,
          eq(masterSchema.userAppTokens.appId, masterSchema.userApps.id),
        )
        .where(
          and(
            eq(masterSchema.userAppTokens.tokenHash, tokenHash),
            isNull(masterSchema.userAppTokens.revokedAt),
            or(
              isNull(masterSchema.userAppTokens.expiresAt),
              gt(masterSchema.userAppTokens.expiresAt, now),
            ),
            eq(masterSchema.userAppInstalls.status, 'active'),
            eq(masterSchema.userApps.isActive, true),
            isNull(masterSchema.userApps.deletedAt),
          ),
        )
        .limit(1);

      if (!row) return null;

      cached = {
        workspaceId: row.workspaceId,
        appId: row.appId,
        appCode: row.appCode,
        installId: row.installId,
        scopes: (row.scopes as string[]) ?? [],
        tokenId: row.tokenId,
        tokenType: row.tokenType,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      };
      await kv.put(cacheKey, JSON.stringify(cached), {
        expirationTtl: APP_TOKEN_KV_TTL_SECONDS,
      });
    }

    // Step 2: Workspace details (KV-cached) — resolves the tenant DB URL
    const workspace = await getWorkspaceDetails(kv, masterDb, cached.workspaceId, c.env.NEON_API_KEY, keyringFromEnv(c.env));
    if (!workspace) {
      return null;
    }

    // Step 3: Fire-and-forget lastUsedAt update
    masterDb
      .update(masterSchema.userAppTokens)
      .set({ lastUsedAt: now })
      .where(eq(masterSchema.userAppTokens.id, cached.tokenId))
      .execute()
      .catch(console.error);

    return {
      keyId: cached.tokenId,
      keyType: 'app',
      workspaceId: cached.workspaceId,
      userId: null,
      scopes: cached.scopes,
      tier: workspace.tier,
      // Installed apps are a platform feature, not raw API access — app tokens
      // work regardless of whether the workspace's plan includes API access.
      hasApiAccess: true,
      databaseUrl: workspace.databaseUrl,
      appId: cached.appId,
      appCode: cached.appCode,
      installId: cached.installId,
    };
  } catch (error) {
    console.error('[API Auth] Error validating app token:', error);
    return null;
  }
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Hono middleware factory for API key authentication
 * Extracts and validates API keys, sets session in context
 */
export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const apiKey = extractApiKey(c);

  if (!apiKey) {
    return error.unauthorized(
      c,
      'Invalid or missing API key. Provide a valid key via Authorization: Bearer wsk_... or X-Api-Key header.',
    );
  }

  const session = apiKey.startsWith('wsat_')
    ? await validateAppToken(c, apiKey)
    : await validateApiKey(c, apiKey);

  if (!session) {
    return error.unauthorized(
      c,
      'Invalid API key. The key may have been revoked, expired, or never existed.',
    );
  }

  if (!session.hasApiAccess) {
    return error.forbidden(
      c,
      'API access is not available on your current plan. Please upgrade to a plan with API access.',
    );
  }

  c.set('apiSession', session);
  // Mirror onto the top-level context vars that `publishEntityEvent` reads.
  // Workspace keys have no user, so fall back to the key id as the actor.
  c.set('workspaceId', session.workspaceId);
  c.set('userId', session.userId ?? session.keyId);
  await next();
};
