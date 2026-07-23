/**
 * API key service — shared by the personal (`api_keys`) and workspace
 * (`workspace_api_keys`) key surfaces.
 *
 * Ported from apps/api-worker `routes/settings/index.ts` (personal + workspace
 * API key sections). The app-api routes that preceded this were generic CRUD
 * shells: they never generated a key, so every POST violated the NOT NULL
 * `key_hash`, never returned the one-time plaintext the UI shows once, and
 * never wrote the master `api_key_registry` that apps/workers/external-api
 * authenticates against (see apps/workers/external-api/src/middleware/auth.ts —
 * it resolves a caller by `api_key_registry.key_hash`).
 *
 * The registry is the authentication index: a key that exists only in the
 * tenant DB can never authenticate, and a registry row that outlives its
 * tenant key is a live credential. Both writes are therefore paired here.
 */

import { eq } from 'drizzle-orm';
import { masterSchema, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';

/** Key material returned by {@link generateApiKey}. */
export interface GeneratedApiKey {
  /** The full plaintext key — returned to the caller EXACTLY once, never stored. */
  key: string;
  /** SHA-256 of `key`, hex encoded. This is what both DBs store. */
  hash: string;
  /** Display prefix (`wsk_` + first 8 hex chars) for identifying the key in lists. */
  prefix: string;
}

/**
 * Mint a `wsk_`-prefixed API key.
 *
 * Byte-for-byte the legacy algorithm: 32 random bytes hex-encoded behind a
 * `wsk_` prefix, SHA-256 hex for storage, and a `wsk_` + first-8-chars display
 * prefix. Changing any of it would invalidate every key already issued, so
 * this must stay in lockstep with apps/api-worker until that worker is deleted.
 */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const key = `wsk_${hex}`;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const prefix = `wsk_${key.slice(4, 12)}`;
  return { key, hash, prefix };
}

/**
 * Resolve the master `workspaces.id` for a Clerk org id.
 *
 * `orgId` in the request context is the CLERK org id (`org_…`); the registry's
 * `workspace_id` FK points at the generated `ws_…` id. Conflating the two
 * writes an unusable registry row.
 */
export async function resolveWorkspaceId(
  masterDb: MasterDatabase,
  clerkOrgId: string,
): Promise<string | null> {
  const [ws] = await masterDb
    .select({ id: masterSchema.workspaces.id })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);
  return ws?.id ?? null;
}

export interface RegisterApiKeyParams {
  masterDb: MasterDatabase;
  clerkOrgId: string;
  keyHash: string;
  keyType: 'personal' | 'workspace';
  /** The key's primary-key id in the TENANT database. */
  tenantKeyId: string;
}

/**
 * Dual-write a freshly minted key into the master `api_key_registry`.
 *
 * Best-effort, mirroring the legacy personal-key path: a registry failure must
 * not roll back a key the caller has already been shown. The cost is a key that
 * lists in the UI but cannot authenticate — recoverable by revoking and
 * re-issuing, whereas a thrown error after the plaintext was generated is not.
 */
export async function registerApiKey({
  masterDb,
  clerkOrgId,
  keyHash,
  keyType,
  tenantKeyId,
}: RegisterApiKeyParams): Promise<void> {
  try {
    const workspaceId = await resolveWorkspaceId(masterDb, clerkOrgId);
    if (!workspaceId) {
      console.error(
        `[app-api/api-keys] No master workspace for org ${clerkOrgId}; ${keyType} key ${tenantKeyId} will not authenticate.`,
      );
      return;
    }

    await masterDb.insert(masterSchema.apiKeyRegistry).values({
      id: generateId('akr'),
      keyHash,
      keyType,
      workspaceId,
      tenantKeyId,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('[app-api/api-keys] Failed to write key to master registry:', err);
  }
}

/**
 * Remove a key from the master registry on revoke.
 *
 * Best-effort to match the legacy route. NOTE: apps/workers/external-api KV-caches
 * registry lookups under `akr:<hash>` (see its auth middleware), so a revoked
 * key stays valid there until that TTL lapses. That gap predates this port —
 * app-api has no binding to external-api's KV namespace to invalidate it.
 */
export async function unregisterApiKey(
  masterDb: MasterDatabase,
  tenantKeyId: string,
): Promise<void> {
  try {
    await masterDb
      .delete(masterSchema.apiKeyRegistry)
      .where(eq(masterSchema.apiKeyRegistry.tenantKeyId, tenantKeyId));
  } catch (err) {
    console.error('[app-api/api-keys] Failed to remove key from master registry:', err);
  }
}
