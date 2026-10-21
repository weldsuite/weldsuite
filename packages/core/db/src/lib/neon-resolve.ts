import { decryptWorkspaceDatabaseUrl, type EncryptionKeyring } from './crypto';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export interface NeonConnectionMeta {
  neonProjectId: string;
  neonBranchId: string;
  neonRoleName: string;
  neonDatabaseName: string | null;
}

/**
 * Resolve a Neon connection URI on-demand via the Neon API.
 * Uses GET /projects/{id}/connection_uri — returns full pooled URI in 1 call.
 */
export async function resolveNeonConnectionUri(
  neonApiKey: string,
  meta: NeonConnectionMeta
): Promise<string> {
  const params = new URLSearchParams({
    branch_id: meta.neonBranchId,
    role_name: meta.neonRoleName,
    database_name: meta.neonDatabaseName || 'neondb',
    pooled: 'true',
  });

  const res = await fetch(
    `${NEON_API_BASE}/projects/${meta.neonProjectId}/connection_uri?${params}`,
    {
      headers: {
        Authorization: `Bearer ${neonApiKey}`,
        Accept: 'application/json',
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Neon API error ${res.status}: ${await res.text()}`);
  }

  const { uri } = (await res.json()) as { uri: string };
  return uri;
}

/**
 * Resolve database URL with decrypt-first pattern.
 *
 * If the workspace has a stored `databaseUrl`:
 *   - Plaintext (starts with postgres(ql)://) → return directly
 *   - Encrypted (v1 / v2 / AAD-bound v3) → decrypt with the keyring, return
 * Otherwise, fall back to resolving via the Neon API.
 *
 * `workspace.id` is the master `workspaces.id` of the row `databaseUrl` was read
 * from. It is the AAD of a v3 value (audit finding 657), so a ciphertext copied
 * onto another workspace's row throws instead of routing that tenant to the
 * wrong database. Every caller must pass the id of the row it selected.
 */
export async function resolveDatabaseUrl(
  neonApiKey: string,
  workspace: NeonConnectionMeta & { id: string; databaseUrl?: string | null },
  encryptionKey?: string | EncryptionKeyring,
): Promise<string> {
  if (workspace.databaseUrl) {
    // Plaintext URLs start with the postgres protocol
    if (workspace.databaseUrl.startsWith('postgresql://') || workspace.databaseUrl.startsWith('postgres://')) {
      return workspace.databaseUrl;
    }
    // Otherwise it's encrypted — decrypt if a key is available.
    // A bare string is the legacy v1 key; a keyring handles v1, v2 and v3.
    const keyring: EncryptionKeyring | undefined =
      typeof encryptionKey === 'string' ? { v1: encryptionKey } : encryptionKey;
    if (keyring && (keyring.v1 || keyring.v2)) {
      return decryptWorkspaceDatabaseUrl(workspace.databaseUrl, workspace.id, keyring);
    }
  }
  return resolveNeonConnectionUri(neonApiKey, workspace);
}
