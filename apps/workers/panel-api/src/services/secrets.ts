/**
 * The secrets WeldPanel keeps for a workspace: a Slack incoming-webhook URL
 * (alerts, scheduled reports) and an export's S3 secret access key. Sealed
 * with the repo's field encryption (`@weldsuite/db/lib/crypto`, AES-256-GCM
 * under DATABASE_ENCRYPTION_KEY / _V2, the worker secrets WeldReach seals
 * mailbox logins with), so no WeldPanel-specific key exists to lose or rotate.
 *
 * Never logged, never returned by the API, never on the entity bus.
 */

import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';

export type SecretKeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

/** No encryption key is configured here, so a secret can be neither stored nor read. */
export class SecretsUnavailableError extends Error {
  constructor() {
    super('Secrets cannot be stored here: no encryption key is configured');
    this.name = 'SecretsUnavailableError';
  }
}

function keyring(env: SecretKeyEnv) {
  const ring = keyringFromEnv(env);
  if (!ring.v1 && !ring.v2) throw new SecretsUnavailableError();
  return ring;
}

export async function sealSecret(env: SecretKeyEnv, plaintext: string): Promise<string> {
  return encryptField(plaintext, keyring(env));
}

export async function openSecret(env: SecretKeyEnv, ciphertext: string): Promise<string> {
  return decryptField(ciphertext, keyring(env));
}
