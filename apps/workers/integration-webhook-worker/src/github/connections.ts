/**
 * GitHub connection helpers for the App webhook receiver.
 * Tenant-scoped reads/updates against `githubConnections`. Ported from core-api.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { schema, type TenantDatabase } from '../db';

export async function getConnectionByInstallationId(db: TenantDatabase, installationId: number) {
  const [row] = await db
    .select()
    .from(schema.githubConnections)
    .where(
      and(
        eq(schema.githubConnections.installationId, installationId),
        isNull(schema.githubConnections.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getDecryptedWebhookSecret(
  connection: { webhookSecret?: string | null },
  encryptionKey: EncryptionKeyring,
): Promise<string | null> {
  if (!connection.webhookSecret) return null;
  return decryptField(connection.webhookSecret, encryptionKey);
}

export async function updateConnectionStatus(
  db: TenantDatabase,
  installationId: number,
  status: 'active' | 'suspended' | 'revoked',
): Promise<void> {
  const now = new Date();
  await db
    .update(schema.githubConnections)
    .set({
      status,
      ...(status === 'revoked' ? { revokedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(schema.githubConnections.installationId, installationId));
}
