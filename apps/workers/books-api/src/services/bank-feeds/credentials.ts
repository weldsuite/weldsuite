/**
 * Provider credentials (access tokens) are stored AES-GCM encrypted in
 * `bank_connections.credentials_encrypted` and never returned by any route.
 */

import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';

export async function sealCredentials(credentials: Record<string, unknown>, keyring: EncryptionKeyring): Promise<string> {
  return encryptField(JSON.stringify(credentials), keyring);
}

export async function openCredentials(blob: string | null, keyring: EncryptionKeyring): Promise<Record<string, unknown>> {
  if (!blob) return {};
  try {
    const parsed: unknown = JSON.parse(await decryptField(blob, keyring));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Wrong key or damaged blob: the connection cannot sync until it is linked again.
    return {};
  }
}
