/**
 * Mailpool mailbox SMTP/IMAP logins, sealed with the worker's
 * DATABASE_ENCRYPTION_KEY(_V2) in `reach_mailboxes.smtp_credentials` /
 * `imap_credentials`. Only the send path and the reply sender open them; no
 * route ever returns them (SENSITIVE_COLUMNS lists both columns).
 */

import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import type { ReachMailServerCredentials } from '@weldsuite/db/schema';

/** The tenant encryption keys (worker secrets) the mailbox logins are sealed with. */
export type CredentialKeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

export async function sealMailServerCredentials(env: CredentialKeyEnv, credentials: ReachMailServerCredentials): Promise<string> {
  return encryptField(JSON.stringify(credentials), keyringFromEnv(env));
}

/** null when missing, undecryptable or malformed: the mailbox cannot send until it is re-provisioned. */
export async function openMailServerCredentials(
  env: CredentialKeyEnv,
  blob: string | null | undefined,
): Promise<ReachMailServerCredentials | null> {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(await decryptField(blob, keyringFromEnv(env))) as Partial<ReachMailServerCredentials>;
    if (
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.username !== 'string' ||
      typeof parsed.password !== 'string'
    ) {
      return null;
    }
    return { host: parsed.host, port: parsed.port, tls: parsed.tls !== false, username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}
