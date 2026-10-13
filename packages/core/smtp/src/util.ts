/**
 * Small byte helpers shared by the MIME builder and the SMTP client.
 * Workers-safe: TextEncoder, btoa and crypto.getRandomValues only (no Buffer).
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Base64 of raw bytes (btoa works on binary strings, so go through chunks to stay clear of argument limits). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Cryptographically random lowercase hex, `byteLength * 2` characters. */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
