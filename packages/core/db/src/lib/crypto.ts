/**
 * AES-256-GCM encryption/decryption via Web Crypto API
 *
 * Compatible with Cloudflare Workers and Node.js 20+.
 *
 * Formats:
 *   - v1 (legacy): "iv:ciphertext"      (2 hex segments, encrypted with the v1 key)
 *   - v2:          "v2:iv:ciphertext"   (explicit version tag, encrypted with the v2 key)
 *
 * Key: 64-char hex string (32 bytes = AES-256).
 *
 * Key rotation (task_mrn6q2a4hariwbc6): the v1 key was exposed in git history.
 * All writes go through encryptField() which prefers the v2 key when present in
 * the keyring; decryptField() picks the key from the value's format, so v1 data
 * stays readable until the re-encryption sweep (apps/tools/migrate-databases
 * rotate-encryption-key) has rewritten it. Once the sweep reports zero v1 rows,
 * the v1 key is removed from all secret stores and the fallback path here dies.
 */

const V1_FORMAT = /^[0-9a-f]+:[0-9a-f]+$/i;
const V2_FORMAT = /^v2:[0-9a-f]+:[0-9a-f]+$/i;

/**
 * Keyring for versioned field encryption.
 * v1 = legacy DATABASE_ENCRYPTION_KEY, v2 = DATABASE_ENCRYPTION_KEY_V2.
 */
export interface EncryptionKeyring {
  v1?: string;
  v2?: string;
}

/**
 * Build a keyring from a worker env / process.env-shaped object.
 */
export function keyringFromEnv(env: {
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}): EncryptionKeyring {
  return {
    v1: env.DATABASE_ENCRYPTION_KEY,
    v2: env.DATABASE_ENCRYPTION_KEY_V2,
  };
}

/**
 * True when a stored value is in one of the encrypted formats (v1 or v2).
 * Use this instead of ad-hoc regexes at call sites.
 */
export function looksEncrypted(value: string): boolean {
  return V2_FORMAT.test(value) || V1_FORMAT.test(value);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string with AES-256-GCM (legacy v1 format).
 * @deprecated Use encryptField() with a keyring so new writes pick up the v2 key.
 * @returns "iv:ciphertext" hex string
 */
export async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  );

  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipherBuf))}`;
}

/**
 * Decrypt an "iv:ciphertext" hex string with AES-256-GCM (legacy v1 format).
 * @deprecated Use decryptField() with a keyring so v2 values are handled.
 * @returns plaintext string
 */
export async function decrypt(encrypted: string, hexKey: string): Promise<string> {
  const [ivHex, cipherHex] = encrypted.split(':');
  if (!ivHex || !cipherHex) {
    throw new Error('Invalid encrypted format — expected "iv:ciphertext"');
  }

  const key = await importKey(hexKey);
  const iv = hexToBytes(ivHex);
  const cipherBytes = hexToBytes(cipherHex);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBytes,
  );

  return new TextDecoder().decode(plainBuf);
}

/**
 * Encrypt a field value using the newest key in the keyring.
 * With a v2 key present → "v2:iv:ciphertext"; otherwise legacy "iv:ciphertext".
 */
export async function encryptField(
  plaintext: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (keyring.v2) {
    return `v2:${await encrypt(plaintext, keyring.v2)}`;
  }
  if (keyring.v1) {
    return encrypt(plaintext, keyring.v1);
  }
  throw new Error('encryptField: keyring has no keys');
}

/**
 * Decrypt a field value, selecting the key from the value's format:
 * "v2:iv:ciphertext" → v2 key, "iv:ciphertext" → v1 key.
 */
export async function decryptField(
  value: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (V2_FORMAT.test(value)) {
    if (!keyring.v2) {
      throw new Error('decryptField: value is v2 but keyring has no v2 key');
    }
    return decrypt(value.slice(3), keyring.v2);
  }
  if (V1_FORMAT.test(value)) {
    if (!keyring.v1) {
      throw new Error('decryptField: value is v1 but keyring has no v1 key');
    }
    return decrypt(value, keyring.v1);
  }
  throw new Error('decryptField: value is not in a recognized encrypted format');
}

/**
 * Decrypt when the value is in an encrypted format, otherwise return it as-is.
 * Replaces the maybeDecrypt/HEX_PAIR helpers that were copy-pasted per worker.
 */
export async function maybeDecryptField(
  value: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (!looksEncrypted(value)) return value;
  if ((V2_FORMAT.test(value) && !keyring.v2) || (V1_FORMAT.test(value) && !keyring.v1)) {
    return value;
  }
  try {
    return await decryptField(value, keyring);
  } catch {
    // Hex-looking values that aren't actually ciphertext (e.g. plain hex tokens)
    return value;
  }
}
