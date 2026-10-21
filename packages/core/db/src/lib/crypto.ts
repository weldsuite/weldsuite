/**
 * AES-256-GCM encryption/decryption via Web Crypto API
 *
 * Compatible with Cloudflare Workers and Node.js 20+.
 *
 * Formats:
 *   - v1 (legacy): "iv:ciphertext"      (2 hex segments, encrypted with the v1 key)
 *   - v2:          "v2:iv:ciphertext"   (explicit version tag, encrypted with the v2 key)
 *   - v3:          "v3:iv:ciphertext"   (v2 key + AES-GCM additional authenticated
 *                                        data, so the value only opens for the
 *                                        record it was sealed for)
 *
 * Key: 64-char hex string (32 bytes = AES-256).
 *
 * Key rotation (task_mrn6q2a4hariwbc6): the v1 key was exposed in git history.
 * All writes go through encryptField() which prefers the v2 key when present in
 * the keyring; decryptField() picks the key from the value's format, so v1 data
 * stays readable until the re-encryption sweep (apps/tools/migrate-databases
 * rotate-encryption-key) has rewritten it. Once the sweep reports zero v1 rows,
 * the v1 key is removed from all secret stores and the fallback path here dies.
 *
 * AAD binding (audit finding 657): v1/v2 ciphertexts carry no context, so a
 * `workspaces.database_url` value copied onto another workspace row decrypts
 * cleanly and silently routes that tenant to the wrong database. v3 values bind
 * the ciphertext to the owning record through the GCM AAD. Only the tenant
 * routing credential uses it, through encryptWorkspaceDatabaseUrl() /
 * decryptWorkspaceDatabaseUrl(); every other field keeps v1/v2 and the generic
 * helpers refuse to open a v3 value. Writing v3 is opt-in (keyring.aadWrites,
 * from FIELD_ENCRYPTION_AAD_WRITES) until every reader understands it.
 *
 * Rollout of v3 (order matters, a reader that predates it cannot open a v3 row):
 *   1. Ship this code. Every reader goes through resolveDatabaseUrl(), which
 *      passes the row's id to decryptWorkspaceDatabaseUrl(); nothing writes v3
 *      yet (flag unset), so rows stay v1/v2 and everything keeps working.
 *   2. Confirm every reader is redeployed: all Workers and Vercel apps that
 *      depend on @weldsuite/db, plus the processes CI does not deploy
 *      (apps/tools/discord-bot, apps/tools/outbound-audit).
 *   3. Set FIELD_ENCRYPTION_AAD_WRITES=1 on workspace-worker (new workspaces are
 *      sealed v3) and in the environment of the rotation sweep, then run
 *      `pnpm rotate:key` (dry-run) and `pnpm rotate:key:execute` in
 *      apps/tools/migrate-databases to upgrade the existing rows. Re-run until
 *      it reports no `database_url` values without AAD and no failures.
 *   Unsetting the flag stops new v3 writes and leaves existing v3 rows readable.
 *   Redeploying code that predates v3 once v3 rows exist would break them.
 */

const V1_FORMAT = /^[0-9a-f]+:[0-9a-f]+$/i;
const V2_FORMAT = /^v2:[0-9a-f]+:[0-9a-f]+$/i;
const V3_FORMAT = /^v3:[0-9a-f]+:[0-9a-f]+$/i;

/**
 * Keyring for versioned field encryption.
 * v1 = legacy DATABASE_ENCRYPTION_KEY, v2 = DATABASE_ENCRYPTION_KEY_V2.
 */
export interface EncryptionKeyring {
  v1?: string;
  v2?: string;
  /**
   * Write policy, not a key: seal `workspaces.database_url` as AAD-bound v3
   * (needs the v2 key). Off unless FIELD_ENCRYPTION_AAD_WRITES is set, so a
   * keyring built inline for reading never changes what gets written.
   */
  aadWrites?: boolean;
}

/** FIELD_ENCRYPTION_AAD_WRITES is on for "1" and "true" (any case), off otherwise. */
export function aadWritesEnabled(flag: string | undefined | null): boolean {
  const value = flag?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Build a keyring from a worker env / process.env-shaped object.
 */
export function keyringFromEnv(env: {
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  FIELD_ENCRYPTION_AAD_WRITES?: string;
}): EncryptionKeyring {
  return {
    v1: env.DATABASE_ENCRYPTION_KEY,
    v2: env.DATABASE_ENCRYPTION_KEY_V2,
    aadWrites: aadWritesEnabled(env.FIELD_ENCRYPTION_AAD_WRITES),
  };
}

/**
 * True when a stored value is in one of the encrypted formats (v1, v2 or v3).
 * Use this instead of ad-hoc regexes at call sites.
 */
export function looksEncrypted(value: string): boolean {
  return V3_FORMAT.test(value) || V2_FORMAT.test(value) || V1_FORMAT.test(value);
}

/** True when a stored value is an AAD-bound v3 value. */
export function isAadBound(value: string): boolean {
  return V3_FORMAT.test(value);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function importKey(hexKey: string): ReturnType<typeof crypto.subtle.importKey> {
  const keyBytes = hexToBytes(hexKey);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** The AES-GCM algorithm parameters (declared here: AesGcmParams is a DOM-lib name some workspaces' tsconfigs lack). */
interface GcmParams {
  name: 'AES-GCM';
  iv: Uint8Array<ArrayBuffer>;
  additionalData?: Uint8Array<ArrayBuffer>;
}

function gcmParams(iv: Uint8Array<ArrayBuffer>, aad: string | undefined): GcmParams {
  return aad === undefined
    ? { name: 'AES-GCM', iv }
    : { name: 'AES-GCM', iv, additionalData: new Uint8Array(new TextEncoder().encode(aad)) };
}

/** AES-256-GCM encrypt to the untagged "iv:ciphertext" hex form, optionally bound to `aad`. */
async function encryptRaw(plaintext: string, hexKey: string, aad?: string): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))); // 96-bit IV
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuf = await crypto.subtle.encrypt(gcmParams(iv, aad), key, encoded);

  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipherBuf))}`;
}

/**
 * Encrypt a plaintext string with AES-256-GCM (legacy v1 format).
 * @deprecated Use encryptField() with a keyring so new writes pick up the v2 key.
 * @returns "iv:ciphertext" hex string
 */
export async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  return encryptRaw(plaintext, hexKey);
}

/** AES-256-GCM decrypt of the untagged "iv:ciphertext" hex form; `aad` must match the seal. */
async function decryptRaw(encrypted: string, hexKey: string, aad?: string): Promise<string> {
  const [ivHex, cipherHex] = encrypted.split(':');
  if (!ivHex || !cipherHex) {
    throw new Error('Invalid encrypted format — expected "iv:ciphertext"');
  }

  const key = await importKey(hexKey);
  const iv = hexToBytes(ivHex);
  const cipherBytes = hexToBytes(cipherHex);

  const plainBuf = await crypto.subtle.decrypt(gcmParams(iv, aad), key, cipherBytes);

  return new TextDecoder().decode(plainBuf);
}

/**
 * Decrypt an "iv:ciphertext" hex string with AES-256-GCM (legacy v1 format).
 * @deprecated Use decryptField() with a keyring so v2 values are handled.
 * @returns plaintext string
 */
export async function decrypt(encrypted: string, hexKey: string): Promise<string> {
  return decryptRaw(encrypted, hexKey);
}

/**
 * Encrypt a field value using the newest key in the keyring.
 * With a v2 key present → "v2:iv:ciphertext"; otherwise legacy "iv:ciphertext".
 * Never writes v3: AAD-bound values go through encryptWorkspaceDatabaseUrl().
 */
export async function encryptField(
  plaintext: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (keyring.v2) {
    return `v2:${await encryptRaw(plaintext, keyring.v2)}`;
  }
  if (keyring.v1) {
    return encryptRaw(plaintext, keyring.v1);
  }
  throw new Error('encryptField: keyring has no keys');
}

/**
 * Decrypt a field value, selecting the key from the value's format:
 * "v2:iv:ciphertext" → v2 key, "iv:ciphertext" → v1 key. A v3 value is refused:
 * without its AAD it could never authenticate.
 */
export async function decryptField(
  value: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (V3_FORMAT.test(value)) {
    throw new Error(
      'decryptField: value is v3 (AAD-bound), open it with decryptWorkspaceDatabaseUrl()',
    );
  }
  if (V2_FORMAT.test(value)) {
    if (!keyring.v2) {
      throw new Error('decryptField: value is v2 but keyring has no v2 key');
    }
    return decryptRaw(value.slice(3), keyring.v2);
  }
  if (V1_FORMAT.test(value)) {
    if (!keyring.v1) {
      throw new Error('decryptField: value is v1 but keyring has no v1 key');
    }
    return decryptRaw(value, keyring.v1);
  }
  throw new Error('decryptField: value is not in a recognized encrypted format');
}

/**
 * Decrypt when the value is in an encrypted format, otherwise return it as-is.
 * Replaces the maybeDecrypt/HEX_PAIR helpers that were copy-pasted per worker.
 * A v3 value comes back untouched (it needs its AAD, see decryptWorkspaceDatabaseUrl).
 */
export async function maybeDecryptField(
  value: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (!looksEncrypted(value) || V3_FORMAT.test(value)) return value;
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

// ── workspaces.database_url (AAD-bound) ──────────────────────────────────────

/**
 * The AAD of a workspace's database URL: the master `workspaces.id`, the one
 * identifier every reader has (some only ever hold the Clerk org id on the
 * request, but all of them select the row's id to resolve the URL).
 */
export function workspaceDatabaseUrlAad(workspaceId: string): string {
  return `workspaces:${workspaceId}:database_url`;
}

/**
 * Seal a workspace's tenant connection string.
 *
 * With `keyring.aadWrites` and a v2 key → "v3:iv:ciphertext", bound to
 * `workspaceId`. Otherwise exactly what encryptField() writes (v2, or legacy v1
 * without a v2 key), so nothing changes until FIELD_ENCRYPTION_AAD_WRITES is on.
 */
export async function encryptWorkspaceDatabaseUrl(
  databaseUrl: string,
  workspaceId: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (keyring.aadWrites && keyring.v2) {
    if (!workspaceId) {
      throw new Error('encryptWorkspaceDatabaseUrl: workspaceId is required');
    }
    return `v3:${await encryptRaw(databaseUrl, keyring.v2, workspaceDatabaseUrlAad(workspaceId))}`;
  }
  return encryptField(databaseUrl, keyring);
}

/**
 * Open a stored `workspaces.database_url`.
 *
 * v3 needs the v2 key and the id of the workspace the row belongs to; a value
 * sealed for another workspace (or tampered with) throws. Legacy v1/v2 values
 * carry no AAD and open as before, so existing rows keep working until the
 * rotation sweep has rewritten them. Never call this with a plaintext URL.
 */
export async function decryptWorkspaceDatabaseUrl(
  value: string,
  workspaceId: string,
  keyring: EncryptionKeyring,
): Promise<string> {
  if (!V3_FORMAT.test(value)) {
    return decryptField(value, keyring);
  }
  if (!keyring.v2) {
    throw new Error('decryptWorkspaceDatabaseUrl: value is v3 but keyring has no v2 key');
  }
  if (!workspaceId) {
    throw new Error('decryptWorkspaceDatabaseUrl: workspaceId is required to open a v3 value');
  }
  try {
    return await decryptRaw(value.slice(3), keyring.v2, workspaceDatabaseUrlAad(workspaceId));
  } catch {
    // Web Crypto reports a bare OperationError for every authentication failure.
    throw new Error(
      'decryptWorkspaceDatabaseUrl: authentication failed (value sealed for another workspace, tampered with, or wrong key)',
    );
  }
}
