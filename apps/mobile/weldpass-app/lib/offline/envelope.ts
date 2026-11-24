/**
 * The offline copy at rest: AES-256-GCM over the copy's JSON (ADR PASS-010).
 *
 * The file is `WPO1` followed by the sealed data in the combined layout
 * nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes), which is what expo-crypto
 * writes and what CryptoKit (`AES.GCM.SealedBox(combined:)`) and
 * `javax.crypto` read, so the native autofill extensions can open it too.
 *
 * The additional data binds the file to its device and workspace: a copy
 * moved to another device's or workspace's slot fails to open instead of
 * being read as that one's.
 */

import type { OfflineCopy } from './copy';

/** AES-GCM with a 256-bit key; `combined` is nonce ‖ ciphertext ‖ tag. */
export interface AesGcm {
  seal(plaintext: Uint8Array, keyBase64: string, additionalData: Uint8Array): Promise<Uint8Array>;
  open(combined: Uint8Array, keyBase64: string, additionalData: Uint8Array): Promise<Uint8Array>;
}

const MAGIC = new Uint8Array([0x57, 0x50, 0x4f, 0x31]); // "WPO1"

export class CopyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyFormatError';
  }
}

export function additionalDataFor(owner: { deviceId: string; workspaceId: string }): Uint8Array {
  return new TextEncoder().encode(`weldpass-offline:v1:${owner.deviceId}:${owner.workspaceId}`);
}

export async function sealCopy(copy: OfflineCopy, keyBase64: string, aes: AesGcm): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(copy));
  const sealed = await aes.seal(plaintext, keyBase64, additionalDataFor(copy));
  const file = new Uint8Array(MAGIC.length + sealed.length);
  file.set(MAGIC, 0);
  file.set(sealed, MAGIC.length);
  return file;
}

/** Throws `CopyFormatError` for a file that isn't a copy, and the AES error for a wrong key or tampering. */
export async function openCopy(
  file: Uint8Array,
  keyBase64: string,
  owner: { deviceId: string; workspaceId: string },
  aes: AesGcm,
): Promise<OfflineCopy> {
  if (file.length <= MAGIC.length + 28 || !MAGIC.every((byte, index) => file[index] === byte)) {
    throw new CopyFormatError('Not a WeldPass offline copy');
  }
  const plaintext = await aes.open(file.subarray(MAGIC.length), keyBase64, additionalDataFor(owner));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new CopyFormatError('Unknown copy version');
  }
  return parsed as OfflineCopy;
}
