/**
 * GitHub Webhook Signature Verification
 *
 * Verifies the X-Hub-Signature-256 header using HMAC-SHA256.
 * Uses Web Crypto (crypto.subtle) — compatible with Cloudflare Workers.
 *
 * Security: uses a timing-safe comparison to prevent timing attacks.
 */

/**
 * Verify that a GitHub webhook request is authentic.
 *
 * @param rawBody - The raw request body bytes (must be the exact bytes received)
 * @param signatureHeader - Value of the X-Hub-Signature-256 header (e.g. "sha256=abc123")
 * @param secret - The plaintext webhook secret for this installation
 * @returns true if valid, false otherwise
 */
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;

  // Header format: "sha256=<hex-digest>"
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;

  const receivedHex = signatureHeader.slice(prefix.length);

  // Compute expected HMAC-SHA256
  const keyBytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, rawBody);
  const expectedHex = bufferToHex(signatureBuffer);

  // Timing-safe comparison — compare byte-by-byte with consistent timing
  return timingSafeEqual(receivedHex, expectedHex);
}

// ============================================================================
// Helpers
// ============================================================================

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Timing-safe string comparison.
 * Both strings must be the same length for true constant-time behavior.
 * If lengths differ, we still compare to avoid short-circuit leaks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = 0;

  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  // Also OR in the length difference so different-length strings always fail
  result |= a.length ^ b.length;

  return result === 0;
}
