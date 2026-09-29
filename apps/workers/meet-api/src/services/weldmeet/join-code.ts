/**
 * Join codes are the public handle of a meeting: `<portal>/<workspace>/<joinCode>`.
 * With `accessType: 'anyone_with_link'` the code is the only thing gating entry,
 * so it is drawn from the Web Crypto RNG rather than Math.random().
 *
 * Format: `wm-abc-def-ghi` (26^9 combinations).
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function segment(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  // 256 % 26 !== 0 gives a slight bias; irrelevant at 26^9 and keeps it branch-free.
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function generateJoinCode(): string {
  return `wm-${segment()}-${segment()}-${segment()}`;
}
