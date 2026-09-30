/**
 * Cryptographically secure random strings (Web Crypto, available in Workers).
 *
 * Use instead of `Math.random()` for anything that ends up in an identifier,
 * document number or secret. Characters are drawn with rejection sampling so
 * every character of `alphabet` is equally likely (no modulo bias).
 */

export const BASE36_UPPER = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const BASE36_LOWER = '0123456789abcdefghijklmnopqrstuvwxyz';
export const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(length: number, alphabet: string = BASE36_LOWER): string {
  if (alphabet.length < 2 || alphabet.length > 256) {
    throw new RangeError('alphabet must contain between 2 and 256 characters');
  }
  // Largest multiple of alphabet.length that fits in a byte; bytes at or above
  // it are discarded so the remainder is uniformly distributed.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - out.length));
    for (const byte of bytes) {
      if (byte < limit) out += alphabet.charAt(byte % alphabet.length);
    }
  }
  return out;
}
