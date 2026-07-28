/**
 * Nango webhook verification + payload narrowing.
 *
 * Nango signs every webhook with `X-Nango-Signature`: the hex HMAC-SHA256 of
 * the JSON body under the environment's secret key. We verify against the RAW
 * request text first, then fall back to a re-serialised parse, because the
 * signing side hashes `JSON.stringify(body)` — semantically identical JSON can
 * still differ byte-for-byte from what arrived on the wire.
 *
 * Verification uses WebCrypto (`crypto.subtle`), available in Workers and in
 * Node 18+, so this file has no Node-only dependency.
 */

import type {
  NangoAuthWebhook,
  NangoForwardWebhook,
  NangoSyncWebhook,
  NangoWebhook,
} from './types';

export const NANGO_SIGNATURE_HEADER = 'x-nango-signature';

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time compare — a plain `===` on a hex digest leaks timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Hex HMAC-SHA256 of `payload` under `secret`. */
export async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * Verify a Nango webhook signature.
 *
 * Fails closed: a missing secret or a missing header is a rejection, never a
 * silent pass. Local development sets the secret in `.dev.vars` like any other.
 */
export async function verifyNangoSignature(
  secret: string | undefined,
  rawBody: string,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signature) return false;

  const provided = signature.trim().toLowerCase();
  const direct = await signPayload(secret, rawBody);
  if (timingSafeEqual(direct, provided)) return true;

  // Re-serialise and retry — covers whitespace/ordering drift introduced
  // between Nango's `JSON.stringify` and the bytes we received.
  try {
    const canonical = await signPayload(secret, JSON.stringify(JSON.parse(rawBody)));
    return timingSafeEqual(canonical, provided);
  } catch {
    return false;
  }
}

// ============================================================================
// Payload narrowing
// ============================================================================

export function isAuthWebhook(payload: NangoWebhook): payload is NangoAuthWebhook {
  return payload.type === 'auth';
}

export function isSyncWebhook(payload: NangoWebhook): payload is NangoSyncWebhook {
  return payload.type === 'sync';
}

export function isForwardWebhook(payload: NangoWebhook): payload is NangoForwardWebhook {
  return payload.type === 'forward';
}

/** Parse a webhook body, returning null for anything we don't recognise. */
export function parseNangoWebhook(rawBody: string): NangoWebhook | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed as Partial<NangoWebhook>;
  if (candidate.type !== 'auth' && candidate.type !== 'sync' && candidate.type !== 'forward') {
    return null;
  }
  if (typeof candidate.connectionId !== 'string' || typeof candidate.providerConfigKey !== 'string') {
    return null;
  }
  return candidate as NangoWebhook;
}
