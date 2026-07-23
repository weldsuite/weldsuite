/**
 * GitHub Connections Service
 *
 * Manages GitHub App installation records (one per workspace).
 * All queries are scoped by workspaceId, except getConnectionByInstallationId
 * which resolves workspace from the installationId (for webhook ingress).
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { encryptField, decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';

const { githubConnections } = schema;

// ============================================================================
// Types
// ============================================================================

export interface UpsertConnectionInput {
  installationId: number;
  appSlug: string;
  ownerType: 'user' | 'org';
  ownerLogin: string;
  scopes?: string[];
  status?: 'active' | 'suspended' | 'revoked';
  createdBy?: string;
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Get the active GitHub connection for a workspace.
 */
export async function getConnectionByWorkspace(
  db: Database,
  workspaceId: string,
) {
  const [row] = await db
    .select()
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.workspaceId, workspaceId),
        isNull(githubConnections.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Look up a connection by GitHub installation ID.
 * NOT scoped by workspaceId — the installationId is the workspace resolver
 * used by the webhook ingress before the workspace is known.
 */
export async function getConnectionByInstallationId(
  db: Database,
  installationId: number,
) {
  const [row] = await db
    .select()
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.installationId, installationId),
        isNull(githubConnections.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Create or update a GitHub App installation record.
 * Generates a 32-byte random webhook secret, encrypts it, and stores it.
 * Returns the connection row including the plain-text secret (only at creation time).
 */
export async function upsertConnection(
  db: Database,
  workspaceId: string,
  input: UpsertConnectionInput,
  encryptionKey: EncryptionKeyring,
): Promise<{ connection: typeof githubConnections.$inferSelect; plaintextSecret: string | null }> {
  const existing = await db
    .select()
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.installationId, input.installationId),
        isNull(githubConnections.deletedAt),
      ),
    )
    .limit(1);

  const now = new Date();

  if (existing.length > 0) {
    // Update existing — do NOT regenerate the webhook secret (keep existing encrypted value)
    const [updated] = await db
      .update(githubConnections)
      .set({
        workspaceId,
        appSlug: input.appSlug,
        ownerType: input.ownerType,
        ownerLogin: input.ownerLogin,
        scopes: input.scopes ?? null,
        status: input.status ?? 'active',
        installedAt: now,
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(githubConnections.id, existing[0].id))
      .returning();

    return { connection: updated, plaintextSecret: null };
  }

  // Generate a fresh webhook secret for new installations
  const plaintextSecret = generateWebhookSecret();
  const encryptedSecret = await encryptField(plaintextSecret, encryptionKey);

  const id = generateId('ghc');
  const [created] = await db
    .insert(githubConnections)
    .values({
      id,
      workspaceId,
      installationId: input.installationId,
      appSlug: input.appSlug,
      ownerType: input.ownerType,
      ownerLogin: input.ownerLogin,
      webhookSecret: encryptedSecret,
      createdBy: input.createdBy ?? null,
      status: input.status ?? 'active',
      scopes: input.scopes ?? null,
      installedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { connection: created, plaintextSecret };
}

/**
 * Mark a connection as revoked (soft-delete / status update).
 */
export async function revokeConnection(
  db: Database,
  workspaceId: string,
): Promise<void> {
  await db
    .update(githubConnections)
    .set({
      status: 'revoked',
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubConnections.workspaceId, workspaceId),
        isNull(githubConnections.deletedAt),
      ),
    );
}

/**
 * Update connection status (active / suspended / revoked) — used by webhook events.
 * Not scoped by workspaceId: called after installationId lookup resolves workspace.
 */
export async function updateConnectionStatus(
  db: Database,
  installationId: number,
  status: 'active' | 'suspended' | 'revoked',
): Promise<void> {
  const now = new Date();
  await db
    .update(githubConnections)
    .set({
      status,
      ...(status === 'revoked' ? { revokedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(githubConnections.installationId, installationId));
}

/**
 * Decrypt and return the webhook secret for a connection.
 */
export async function getDecryptedWebhookSecret(
  connection: typeof githubConnections.$inferSelect,
  encryptionKey: EncryptionKeyring,
): Promise<string | null> {
  if (!connection.webhookSecret) return null;
  return decryptField(connection.webhookSecret, encryptionKey);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a 32-byte random webhook secret as a 64-char hex string.
 * Uses Web Crypto — compatible with Cloudflare Workers.
 */
function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
