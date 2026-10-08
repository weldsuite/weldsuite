/**
 * What the sales tax engines need from the worker: the key that opens the
 * entity's stored engine credentials, and (in tests) a recorded HTTP fetch.
 */

import { decryptField, encryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';

export interface SalesTaxRuntime {
  /** Opens `entities.sales_tax_credentials_encrypted`. */
  decrypt: (blob: string) => Promise<string>;
  /** Injected by tests; the engines use the global fetch otherwise. */
  fetch?: typeof fetch;
}

/** Test hook: every runtime made from an env uses this fetch. Never set in production. */
export const salesTaxTestHooks: { fetch?: typeof fetch } = {};

type EncryptionEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

export function salesTaxRuntimeFromEnv(env: EncryptionEnv, opts: { fetch?: typeof fetch } = {}): SalesTaxRuntime {
  const keyring = keyringFromEnv(env);
  return {
    decrypt: (blob) => decryptField(blob, keyring),
    fetch: opts.fetch ?? salesTaxTestHooks.fetch,
  };
}

export function sealEngineCredentials(credentials: Record<string, unknown>, env: EncryptionEnv): Promise<string> {
  const keyring: EncryptionKeyring = keyringFromEnv(env);
  return encryptField(JSON.stringify(credentials), keyring);
}

export function hasEncryptionKey(env: EncryptionEnv): boolean {
  const keyring = keyringFromEnv(env);
  return Boolean(keyring.v1 || keyring.v2);
}
