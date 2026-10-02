/**
 * RealtimeKit webhook signature verification.
 *
 * RealtimeKit signs every webhook body with RSA-SHA256 (RSASSA-PKCS1-v1_5)
 * and sends the Base64 signature in the `rtk-signature` header. The public key
 * is published at {@link RTK_WEBHOOK_PUBLIC_KEY_URL}. Each delivery also
 * carries a unique `rtk-uuid` for de-duplication.
 *
 * Docs: https://developers.cloudflare.com/realtime/realtimekit/webhooks/
 *
 * The signature covers the raw body bytes, so callers must verify the body
 * exactly as received — never a re-serialised `JSON.parse` result.
 */

export const RTK_WEBHOOK_PUBLIC_KEY_URL = 'https://api.realtime.cloudflare.com/.well-known/webhooks.json';
export const RTK_SIGNATURE_HEADER = 'rtk-signature';
export const RTK_DELIVERY_ID_HEADER = 'rtk-uuid';

/** Thrown when the RealtimeKit public key cannot be fetched or parsed. */
export class RtkWebhookKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtkWebhookKeyUnavailableError';
  }
}

type FetchLike = (input: string) => Promise<Response>;

/** Re-fetch the key at most this often (covers key rotation). */
const KEY_TTL_MS = 60 * 60 * 1000;
/** After a failed verification, a cached key older than this is re-fetched once. */
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;

let cachedKey: { key: CryptoKey; fetchedAt: number } | null = null;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PEM `PUBLIC KEY` (SPKI) → DER bytes. Tolerates literal `\n` escapes. */
export function pemToSpki(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem
    .replace(/\\n/g, '')
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return base64ToBytes(b64);
}

async function fetchPublicKey(fetchImpl: FetchLike): Promise<CryptoKey> {
  let pem: unknown;
  try {
    const res = await fetchImpl(RTK_WEBHOOK_PUBLIC_KEY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { publicKey?: unknown } };
    pem = body.data?.publicKey;
  } catch (err) {
    throw new RtkWebhookKeyUnavailableError(
      `Could not fetch the RealtimeKit webhook public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof pem !== 'string' || !pem) {
    throw new RtkWebhookKeyUnavailableError('RealtimeKit webhook public key response carried no key');
  }
  try {
    return await crypto.subtle.importKey(
      'spki',
      pemToSpki(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch (err) {
    throw new RtkWebhookKeyUnavailableError(
      `Could not import the RealtimeKit webhook public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function getPublicKey(fetchImpl: FetchLike, forceRefresh: boolean): Promise<CryptoKey> {
  const now = Date.now();
  if (!forceRefresh && cachedKey && now - cachedKey.fetchedAt < KEY_TTL_MS) return cachedKey.key;
  const key = await fetchPublicKey(fetchImpl);
  cachedKey = { key, fetchedAt: now };
  return key;
}

/**
 * Returns true only when `signature` is a valid RealtimeKit signature over
 * `rawBody`. A missing or malformed signature returns false. Throws
 * {@link RtkWebhookKeyUnavailableError} when the public key cannot be loaded,
 * so the caller can answer 5xx and let RealtimeKit retry.
 */
export async function verifyRtkWebhookSignature(
  rawBody: ArrayBuffer | Uint8Array<ArrayBuffer>,
  signature: string | null | undefined,
  options: { fetch?: FetchLike } = {},
): Promise<boolean> {
  if (!signature) return false;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64ToBytes(signature.trim());
  } catch {
    return false;
  }
  if (sig.length === 0) return false;

  const fetchImpl = options.fetch ?? ((input: string) => fetch(input));
  const verify = (key: CryptoKey) => crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, rawBody);

  if (await verify(await getPublicKey(fetchImpl, false))) return true;

  // The key may have been rotated since we cached it. Re-fetch once, but not
  // more than once a minute, so forged requests cannot hammer the key URL.
  if (cachedKey && Date.now() - cachedKey.fetchedAt >= MIN_REFETCH_INTERVAL_MS) {
    return verify(await getPublicKey(fetchImpl, true));
  }
  return false;
}

/** Test hook: drop the cached public key. */
export function resetRtkWebhookKeyCache(): void {
  cachedKey = null;
}
