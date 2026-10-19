/**
 * Sealing tenant connection strings for KV caches.
 *
 * Workers cache the workspace → tenant DB lookup in KV for a few minutes so a
 * request costs no master-DB round trip. KV sits outside the encryption
 * boundary that DATABASE_ENCRYPTION_KEY draws around `workspaces.database_url`,
 * and many workers are bound to the same namespace, so the cached copy must be
 * as protected as the stored one: it is sealed with the same keyring and never
 * written as a plain `postgres://` URI.
 *
 * Sealed entries live under their own key prefixes (`SEALED_*` below), never
 * under the old plaintext keys (`ws:<id>`, `mcp:org:<org>`). A worker that has
 * not been redeployed yet keeps reading and writing the old keys, so the two
 * shapes never meet in one entry, and the old plaintext entries simply expire.
 *
 * Without a keyring nothing is cached: `sealCachedDatabaseUrl` returns null and
 * the caller resolves the URL on every request.
 */

import { decryptField, encryptField, looksEncrypted, type EncryptionKeyring } from './crypto';

/** `WORKSPACE_CACHE` key of a Clerk org's sealed workspace entry. */
export function sealedWorkspaceCacheKey(clerkOrgId: string): string {
  return `wsx:${clerkOrgId}`;
}

/** external-api `API_CACHE` key of a workspace id's sealed entry. */
export function sealedWorkspaceIdCacheKey(workspaceId: string): string {
  return `wsx:id:${workspaceId}`;
}

/** mcp-server `API_CACHE` key of a Clerk org's sealed entry. */
export function sealedMcpOrgCacheKey(clerkOrgId: string): string {
  return `mcpx:org:${clerkOrgId}`;
}

/** A keyring, a bare legacy v1 key, or nothing configured. */
type KeyringInput = string | EncryptionKeyring | undefined | null;

function normalizeKeyring(keyring: KeyringInput): EncryptionKeyring | null {
  const ring = typeof keyring === 'string' ? { v1: keyring } : keyring;
  return ring && (ring.v1 || ring.v2) ? ring : null;
}

/** Seal a connection string for a cache entry; null when there is no key. */
export async function sealCachedDatabaseUrl(
  databaseUrl: string,
  keyring: KeyringInput,
): Promise<string | null> {
  const ring = normalizeKeyring(keyring);
  return ring ? encryptField(databaseUrl, ring) : null;
}

/**
 * Open a sealed cache value. Null for anything that is not a sealed value this
 * keyring can open (a missing field, a plaintext URI, a rotated-out key), so
 * the caller treats the entry as a miss and resolves afresh.
 */
export async function openCachedDatabaseUrl(
  sealed: unknown,
  keyring: KeyringInput,
): Promise<string | null> {
  const ring = normalizeKeyring(keyring);
  if (!ring || typeof sealed !== 'string' || !looksEncrypted(sealed)) return null;
  try {
    return await decryptField(sealed, ring);
  } catch {
    return null;
  }
}
