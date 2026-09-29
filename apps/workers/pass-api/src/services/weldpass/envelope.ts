/**
 * WeldPass envelope encryption (AES-256-GCM, Web Crypto).
 *
 * Three layers, so no single stolen artefact is enough:
 *
 *   root key   — 32 bytes, lives only in the worker's secret store, never in
 *                the database. Wraps each vault's KEK.
 *   vault KEK  — 32 bytes, generated per project, stored wrapped
 *                (`weldpass_projects.kek_wrapped`). Wraps each secret's DEK.
 *   secret DEK — 32 bytes, generated per *write*, stored wrapped
 *                (`weldpass_secrets.dek_wrapped`). Encrypts one value.
 *
 * A database dump alone reveals nothing: every value needs the root key. A
 * leaked root key alone reveals nothing without the database. Re-keying a
 * single secret means rewriting one row; rotating the root key means rewriting
 * only the project rows, not every secret.
 *
 * Every ciphertext is bound to where it lives via GCM additional authenticated
 * data, so a row copied from a staging environment into production fails to
 * decrypt instead of silently yielding the wrong value.
 *
 * Wire format is `<version>:<iv-hex>:<ciphertext-hex>`, matching the convention
 * in `@weldsuite/db/lib/crypto` so the two are recognisable side by side.
 */

const FORMAT = /^(v[0-9]+):([0-9a-f]+):([0-9a-f]+)$/i;

export type RootKeyVersion = 'v1' | 'v2';

/** Root keys available to this worker. `v2` is only present during rotation. */
export interface RootKeyring {
  v1?: string;
  v2?: string;
}

export function rootKeyringFromEnv(env: {
  WELDPASS_ROOT_KEY?: string;
  WELDPASS_ROOT_KEY_V2?: string;
}): RootKeyring {
  return { v1: env.WELDPASS_ROOT_KEY, v2: env.WELDPASS_ROOT_KEY_V2 };
}

/** Newest available root key — what new vaults are wrapped with. */
export function currentRootKeyVersion(keyring: RootKeyring): RootKeyVersion {
  if (keyring.v2) return 'v2';
  if (keyring.v1) return 'v1';
  throw new EnvelopeError('WELDPASS_ROOT_KEY is not configured');
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new EnvelopeError('Invalid hex length');
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new EnvelopeError('Invalid hex input');
    bytes[i / 2] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new EnvelopeError(`Expected a 32-byte AES key, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function requireRootKey(keyring: RootKeyring, version: string): Uint8Array<ArrayBuffer> {
  const hex = version === 'v2' ? keyring.v2 : version === 'v1' ? keyring.v1 : undefined;
  if (!hex) throw new EnvelopeError(`Root key "${version}" is not available to this worker`);
  if (hex.length !== 64) {
    throw new EnvelopeError(`Root key "${version}" must be 64 hex characters (32 bytes)`);
  }
  return hexToBytes(hex);
}

// ---------------------------------------------------------------------------
// Primitive seal / open
// ---------------------------------------------------------------------------

async function seal(
  keyBytes: Uint8Array<ArrayBuffer>,
  // Accepts any backing buffer — `TextEncoder.encode` returns
  // `Uint8Array<ArrayBufferLike>`, and Web Crypto takes any BufferSource.
  plaintext: Uint8Array,
  aad: string,
  version: string,
): Promise<string> {
  const key = await importAesKey(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    plaintext,
  );
  return `${version}:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipher))}`;
}

async function open(
  keyBytes: Uint8Array<ArrayBuffer>,
  packed: string,
  aad: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const match = FORMAT.exec(packed);
  if (!match) throw new EnvelopeError('Value is not in the expected envelope format');
  const [, , ivHex, cipherHex] = match;

  const key = await importAesKey(keyBytes);
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: hexToBytes(ivHex),
        additionalData: new TextEncoder().encode(aad),
      },
      key,
      hexToBytes(cipherHex),
    );
    return new Uint8Array(plain);
  } catch {
    // AES-GCM failures are indistinguishable by design (wrong key, tampered
    // ciphertext, or a row moved between vaults all land here).
    throw new EnvelopeError('Decryption failed — wrong key or the value has been tampered with');
  }
}

/** The version tag a packed value was written with. */
export function versionOf(packed: string): string {
  const match = FORMAT.exec(packed);
  if (!match) throw new EnvelopeError('Value is not in the expected envelope format');
  return match[1].toLowerCase();
}

// ---------------------------------------------------------------------------
// Vault keys (KEK)
// ---------------------------------------------------------------------------

/** A fresh vault key, wrapped and ready to store on the project row. */
export interface WrappedVaultKey {
  kekWrapped: string;
  rootKeyVersion: RootKeyVersion;
}

/**
 * Mint a project's KEK. `projectId` is the AAD, so a `kek_wrapped` blob copied
 * onto another project row will not open.
 */
export async function createVaultKey(
  keyring: RootKeyring,
  projectId: string,
): Promise<WrappedVaultKey> {
  const version = currentRootKeyVersion(keyring);
  const kek = crypto.getRandomValues(new Uint8Array(32));
  const kekWrapped = await seal(requireRootKey(keyring, version), kek, kekAad(projectId), version);
  return { kekWrapped, rootKeyVersion: version };
}

/** Unwrap a project's KEK for the lifetime of one request. */
export async function unwrapVaultKey(
  keyring: RootKeyring,
  projectId: string,
  kekWrapped: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const version = versionOf(kekWrapped);
  return open(requireRootKey(keyring, version), kekWrapped, kekAad(projectId));
}

/**
 * Re-wrap an existing KEK under the newest root key. Used by root-key rotation:
 * the vault contents are untouched, only the project row is rewritten.
 */
export async function rewrapVaultKey(
  keyring: RootKeyring,
  projectId: string,
  kekWrapped: string,
): Promise<WrappedVaultKey> {
  const kek = await unwrapVaultKey(keyring, projectId, kekWrapped);
  const version = currentRootKeyVersion(keyring);
  return {
    kekWrapped: await seal(requireRootKey(keyring, version), kek, kekAad(projectId), version),
    rootKeyVersion: version,
  };
}

function kekAad(projectId: string): string {
  return `weldpass:kek:${projectId}`;
}

// ---------------------------------------------------------------------------
// Secret values (DEK)
// ---------------------------------------------------------------------------

/** Where a value lives. Bound into the ciphertext so it cannot be relocated. */
export interface SecretLocation {
  projectId: string;
  environmentId: string;
  key: string;
}

/** Everything needed to store one encrypted value, plus its safe-to-show parts. */
export interface SealedSecret {
  ciphertext: string;
  dekWrapped: string;
  checksum: string;
  valueLength: number;
  valueHint: string | null;
}

/** Encrypt one value under a fresh data key. */
export async function sealSecret(
  kek: Uint8Array<ArrayBuffer>,
  location: SecretLocation,
  plaintext: string,
): Promise<SealedSecret> {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await seal(dek, encoded, valueAad(location), 'v1');
  const dekWrapped = await seal(kek, dek, dekAad(location), 'v1');

  return {
    ciphertext,
    dekWrapped,
    checksum: await sha256Hex(plaintext),
    valueLength: plaintext.length,
    valueHint: hintFor(plaintext),
  };
}

/** Decrypt one value. Callers must have already checked `secrets:reveal`. */
export async function openSecret(
  kek: Uint8Array<ArrayBuffer>,
  location: SecretLocation,
  stored: { ciphertext: string; dekWrapped: string },
): Promise<string> {
  const dek = await open(kek, stored.dekWrapped, dekAad(location));
  const plain = await open(dek, stored.ciphertext, valueAad(location));
  return new TextDecoder().decode(plain);
}

function valueAad(location: SecretLocation): string {
  return `weldpass:value:${location.projectId}:${location.environmentId}:${location.key}`;
}

function dekAad(location: SecretLocation): string {
  return `weldpass:dek:${location.projectId}:${location.environmentId}:${location.key}`;
}

/**
 * Provider API tokens are sealed the same way as secret values, using the
 * credential id in place of an environment so they cannot be swapped between
 * credential rows.
 */
export function credentialLocation(projectId: string, credentialId: string): SecretLocation {
  return { projectId, environmentId: credentialId, key: '__provider_token__' };
}

// ---------------------------------------------------------------------------
// Non-secret derivatives
// ---------------------------------------------------------------------------

/** SHA-256 of a plaintext, hex. Used to spot drift without decrypting. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Last four characters of a value, for masked display — but only once the value
 * is long enough that four characters are not most of it.
 */
export function hintFor(plaintext: string): string | null {
  if (plaintext.length < 12) return null;
  return plaintext.slice(-4);
}
